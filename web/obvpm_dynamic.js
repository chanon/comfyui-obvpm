import { cssString } from "./obvpm_image_limits.js";
import { app } from "../../scripts/app.js";
// The bundle config dialogs. The import is circular (that file imports
// this one's utilities); safe, because both sides only call across it
// at runtime.
import {
    addConfigButton, applyUnbundleLayout, hasUnbundleLayout,
    openBundleConfig, openUnbundleConfig,
} from "./obvpm_bundle_config.js";
import { el } from "./obvpm_ui.js";
import { foldButton, installFold, isFolded, syncFold } from "./obvpm_fold.js";

// User-defined dropdowns without a node per list.
//
// A combo's option list normally comes from the server, in INPUT_TYPES, so
// a list that differs per node instance would need its own node class. It
// doesn't have to: litegraph's ComboWidget resolves its list as
// `typeof values === 'function' ? values(this, node) : values`, so handing
// it a FUNCTION makes the options per-instance and live -- here they are
// read straight out of a sibling widget.
//
// The inputs stay plain STRING server-side rather than COMBO. That keeps
// the value free-form (no "value not in list" validation to work around)
// and degrades gracefully: if this file ever fails to load, the nodes are
// still usable as text fields.

const BUNDLE_TYPE = "OBVPM_BUNDLE";   // see h3/wiretypes.py

// RenderShape.HollowCircle. The frontend stamps this on every optional
// input as it builds a node (litegraphService: `isOptional ? HollowCircle
// : undefined`), so a socket added here has to carry it too -- otherwise
// the ones we grow render solid, claiming to be required, next to the
// identical declared ones that render as donuts.
// Every socket in these pools is declared optional, so the shape is not
// something to work out per node -- it is the same for all of them, and
// restating it also repairs nodes saved before this was fixed.
const HOLLOW_CIRCLE = 7;
const OPTIONAL_SLOT = { shape: HOLLOW_CIRCLE };

export const LINES = (text) =>
    String(text ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

export function widget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

/**
 * The list a node is working from, whether typed in or wired in.
 *
 * Once a list input is connected its widget still holds whatever was typed
 * before -- the real value only arrives server-side at execution. So when
 * there is a link, follow it and read the list at its source instead.
 */
function listLines(node, name, depth = 0) {
    const idx = (node.inputs ?? []).findIndex((i) => i.name === name);
    if (idx >= 0 && node.inputs[idx].link != null && depth < 8) {
        const upstream = upstreamLines(node, name, depth);
        if (upstream) return upstream;      // else fall back to the widget
    }
    return LINES(widget(node, name)?.value);
}

/**
 * Walk a link back to the widget that produced it.
 *
 * The producers pass their list straight through, and their output slot
 * carries the same name as the widget behind it (`options` on a Dropdown,
 * `names` on a Bundle) -- so the slot name at the far end of the link says
 * which widget to read. Anything else that merely carries the value along
 * (a switch, a reroute) is stepped through by its single connected input;
 * a hop with several candidates is ambiguous and gives up rather than
 * guessing.
 */
function upstreamLines(node, slotName, depth = 0) {
    let current = node;
    let name = slotName;
    for (let hop = depth; hop < 8 && current; hop++) {
        const idx = (current.inputs ?? []).findIndex((i) => i.name === name);
        if (idx < 0) return null;
        const link = linkById(current.graph, current.inputs[idx].link);
        const wrapper = link ? current.graph.getNodeById(link.origin_id) : null;
        if (!wrapper) return null;
        const { node: origin, slot } = throughSubgraph(wrapper,
                                                      link.origin_slot);
        const produced = origin.outputs?.[slot]?.name;
        if (produced && widget(origin, produced)) {
            return listLines(origin, produced, hop + 1);   // may itself be wired
        }
        const linked = (origin.inputs ?? []).filter((i) => i.link != null);
        if (linked.length !== 1) return null;
        current = origin;
        name = linked[0].name;
    }
    return null;
}

/**
 * Re-sync every node in the graph.
 *
 * A list can be shared, so a single edit is not a local event: changing a
 * Dropdown's options has to move the sockets on whatever it feeds, and on
 * whatever that feeds in turn. Rather than tracking the dependency graph,
 * re-derive all of them -- each sync is a few array operations, and the
 * consumers are the only nodes that register one.
 */
let resyncing = false;
export function resyncGraph(node) {
    if (resyncing) return;
    resyncing = true;
    try {
        for (const other of node?.graph?._nodes ?? []) {
            try {
                other.__obvpmSync?.();
            } catch (err) {
                console.error("[obvpm-dynamic] resync failed:", err);
            }
        }
    } finally {
        resyncing = false;
    }
}

/**
 * Replace a text widget with a combo whose options come from `valuesFn`.
 * Swapped IN PLACE: widgets_values is serialised by position, so appending
 * instead would renumber every widget after it.
 */
function asDropdown(node, name, valuesFn) {
    const index = node.widgets?.findIndex((w) => w.name === name) ?? -1;
    if (index < 0) return null;
    const old = node.widgets[index];
    if (old.type === "combo") {          // already swapped (node reloaded)
        old.options.values = valuesFn;
        return old;
    }
    const combo = node.addWidget("combo", name, old.value ?? "", () => {
        node.graph?.setDirtyCanvas(true);
    }, { values: valuesFn });
    combo.serialize = true;
    const appended = node.widgets.indexOf(combo);
    if (appended >= 0) node.widgets.splice(appended, 1);
    node.widgets[index] = combo;
    return combo;
}

/** Fill an empty selection with the first option, once one exists. */
function defaultTo(combo, valuesFn, node) {
    const values = valuesFn();
    if (!combo.value && values.length) {
        combo.value = values[0];
        node.graph?.setDirtyCanvas(true);
    }
}

/**
 * One numbered socket per line of a list, labelled with it.
 *
 * The node declares a fixed pool server-side (the sockets must exist for
 * a prompt to carry them) and this trims the pool to the lines actually
 * in use. Sockets are only ever added or removed at the END, and never
 * while connected, so existing links keep both their slot index and their
 * meaning. One left over from a deleted line says so in its label rather
 * than vanishing with a link attached.
 *
 * `side` is "inputs" or "outputs" — outputs behave the same way, except a
 * link lives in `.links` rather than `.link`.
 */
function syncSockets(node, side, prefix, labels, max) {
    const re = new RegExp(`^${prefix}(\\d+)$`);
    const linked = (slot) =>
        side === "inputs" ? slot.link != null : !!slot.links?.length;
    const list = () => (node[side] ?? [])
        .map((slot, index) => ({ slot, index, n: Number(re.exec(slot.name)?.[1]) }))
        .filter((x) => x.n > 0)
        .sort((a, b) => a.n - b.n);

    let have = list();
    const want = Math.min(labels.length, max);
    for (let n = have.length + 1; n <= want; n++) {
        if (side === "inputs") {
            node.addInput(`${prefix}${n}`, "*", { ...OPTIONAL_SLOT });
        } else {
            node.addOutput(`${prefix}${n}`, "*");
        }
        have = list();
    }
    while (have.length > want) {
        const last = have[have.length - 1];
        if (linked(last.slot)) break;      // connected: leave it be
        if (side === "inputs") node.removeInput(last.index);
        else node.removeOutput(last.index);
        have = list();
    }
    for (const { slot, n } of have) {
        labelSlot(slot, labels[n - 1] ?? `${prefix}${n} (no line ${n})`);
        if (side === "inputs") slot.shape = HOLLOW_CIRCLE;
    }
    node.graph?.setDirtyCanvas(true, true);
    notifyVue(node);
}

/** How many `prefix`N slots the node definition declares. */
function poolSize(nodeData, prefix, where) {
    const re = new RegExp(`^${prefix}\\d+$`);
    if (where === "outputs") {
        // The definition has carried output names under more than one key
        // across versions; an unrecognised shape must read as "unknown",
        // not as an empty pool.
        const names = nodeData?.output_name
            ?? (nodeData?.outputs ?? []).map((o) => o?.name ?? o);
        return names.filter((n) => re.test(String(n))).length;
    }
    return Object.keys(nodeData?.input?.optional ?? {})
        .filter((k) => re.test(k)).length;
}

/**
 * How many `prefix`N slots the node actually has.
 *
 * Counted on the node itself, which is the authority: a freshly created
 * node carries the whole server-declared pool before anything trims it.
 * The definition object is only a hint -- its keys have moved between
 * frontend versions, and reading the wrong one silently yields a pool of
 * zero, which looks exactly like a node that refuses to grow.
 */
function countSlots(node, side, prefix) {
    if (!side) return 0;
    const re = new RegExp(`^${prefix}\\d+$`);
    return (node?.[side] ?? []).filter((s) => re.test(s.name)).length;
}

/**
 * Follow a BUNDLE link back to the Bundle node that packed it, so a
 * consumer can offer its field names.
 *
 * Anything that only carries the value along (a Lazy Case Switch, a
 * reroute) is passed through. A switch has one source per branch, and
 * which one arrives is not known until it runs -- so all of them are
 * traced and the names are only reported when every branch agrees. That
 * is the condition under which the answer is the same whichever branch
 * wins; branches that pack different fields have no single answer and get
 * none, which is exactly when the consumer needs an explicit list.
 *
 * Only sockets that could be carrying the bundle are followed: a wired
 * `cases` or `selected` on the switch is a string, not a candidate, and
 * counting it would make every such switch look ambiguous.
 */
/**
 * The node and output slot a bundle wire really comes from: the far end
 * of the link, seen through subgraph boundaries and wrappers and through
 * KJNodes Set/Get pairs (an invisible wire: a Get has no inputs and no
 * names widget, so the trace used to die on it with the Bundle one hop
 * away behind the pairing -- a Set passes to whatever feeds it, a Get to
 * its Set's feed, found the way the pair finds itself). Null when the
 * wire cannot be followed.
 */
function bundleSourceFor(node, slotName, depth = 0) {
    if (depth >= 8) return null;
    const idx = (node.inputs ?? []).findIndex((i) => i.name === slotName);
    const link = idx >= 0
        ? linkById(node.graph, node.inputs[idx].link) : null;
    // Handed IN from the parent graph: continue from the instance node's
    // matching input, which is where the wire actually comes from.
    if (fromBoundary(node.graph, link)) {
        const instance = instanceOf(node.graph);
        const outer = instance?.inputs?.[link.origin_slot];
        return outer
            ? bundleSourceFor(instance, outer.name, depth + 1) : null;
    }
    const wrapper = link ? node.graph.getNodeById(link.origin_id) : null;
    // A bundle packed inside a subgraph arrives through the wrapper's
    // output; the Bundle that named the fields is in there.
    const through = wrapper
        ? throughSubgraph(wrapper, link.origin_slot) : null;
    const origin = through?.node ?? null;
    if (!origin) return null;
    if (origin.type === "SetNode") {
        return bundleSourceFor(origin, origin.inputs?.[0]?.name, depth + 1);
    }
    if (origin.type === "GetNode") {
        const setter = setterFor(origin);
        return setter
            ? bundleSourceFor(setter, setter.inputs?.[0]?.name, depth + 1)
            : null;
    }
    return { node: origin, slot: through.slot };
}

/**
 * The Bundle that packed the bundle on a wire, with its field list and
 * the connected inputs those fields came from, in the same order.
 *
 * Follows a wire THROUGH an Unbundle: a bundle can hold another bundle
 * as a field, and unbundling the outer one puts the inner bundle on an
 * output. That output's label is the field's name, so the inner Bundle
 * is found by locating that field on the outer packer and following its
 * input. Any depth of nesting works the same way. Null when the wire
 * does not come from a Bundle (a Value Presets node packs without
 * inputs, and a switch is stepped over by bundleNamesFor instead).
 */
function packerOf(node, slotName, depth = 0) {
    const src = bundleSourceFor(node, slotName, depth);
    if (!src || depth >= 8) return null;
    const { node: origin, slot } = src;
    if (origin.type === "Unbundle (obvpm)") {
        const out = origin.outputs?.[slot];
        const field = out ? (out.label || out.localized_name || out.name) : "";
        const outer = field ? packerOf(origin, "in", depth + 1) : null;
        if (!outer) return null;
        const carrier = outer.inputs[outer.names.indexOf(field)];
        return carrier ? packerOf(outer.node, carrier.name, depth + 1) : null;
    }
    const inputs = (origin.inputs ?? []).filter(
        (i) => /^in_\d+$/.test(i.name) && i.link != null);
    if (!widget(origin, "names") || !inputs.length) return null;
    return { node: origin, inputs, names: listLines(origin, "names") };
}

export function bundleNamesFor(node, slotName, depth = 0) {
    if (depth >= 8) return null;
    const src = bundleSourceFor(node, slotName, depth);
    if (!src) return null;
    const origin = src.node;
    // A bundle taken out of another bundle: the names are the inner
    // Bundle's, found through the Unbundle (see packerOf).
    if (origin.type === "Unbundle (obvpm)") {
        return packerOf(node, slotName, depth)?.names ?? null;
    }
    // Read the Bundle's list the same way it does, so a wired-in list
    // resolves here too.
    if (widget(origin, "names")) return listLines(origin, "names");

    const carriers = (origin.inputs ?? []).filter(
        (i) => i.link != null && (i.type === "*" || i.type === BUNDLE_TYPE));
    if (!carriers.length) return null;
    const lists = carriers.map((i) => bundleNamesFor(origin, i.name, depth + 1));
    const agreed = JSON.stringify(lists[0]);
    if (!lists[0] || lists.some((l) => JSON.stringify(l) !== agreed)) {
        return null;                            // branches disagree
    }
    return lists[0];
}

/**
 * Move an input so it sits directly above the first `prefix`N socket.
 *
 * The numbered sockets come and go as the list is edited, so a fixed one
 * declared after them would appear to drift. Server-side ordering already
 * puts it first, but a workflow saved before that keeps its old layout --
 * this brings those into line. Link records address their target by slot
 * INDEX, so every link into this node is re-pointed after the move.
 */
function moveAboveSockets(node, name, prefix) {
    const inputs = node.inputs ?? [];
    const from = inputs.findIndex((i) => i.name === name);
    if (from < 0) return;
    const re = new RegExp(`^${prefix}\\d+$`);
    const first = inputs.findIndex((i) => re.test(i.name));
    if (first < 0 || from < first) return;      // already above them
    inputs.splice(first, 0, inputs.splice(from, 1)[0]);
    repointLinks(node);
}

/** Link records address their target by slot INDEX; restate them all. */
export function repointLinks(node) {
    (node.inputs ?? []).forEach((slot, index) => {
        const link = linkById(node.graph, slot.link);
        if (link) link.target_slot = index;
    });
}

function removeInputAt(node, index) {
    node.removeInput(index);
    repointLinks(node);
}

/**
 * One link by id, whichever shape the graph keeps its links in.
 *
 * A graph's `links` may be a plain object or a Map -- and a SUBGRAPH's is
 * not necessarily the same as the root graph's. Indexing a Map with
 * brackets returns undefined silently, so a trace that works at the top
 * level dies the moment it steps inside a subgraph.
 */
export function linkById(graph, id) {
    const links = graph?.links;
    if (!links || id == null) return null;
    return typeof links.get === "function" ? links.get(id) : links[id];
}

/** A graph's links, whichever shape it keeps them in. */
function linksOf(graph) {
    const links = graph?.links;
    if (!links) return [];
    if (typeof links.values === "function") return [...links.values()];
    return Object.values(links);
}

/**
 * Step out of a subgraph, so a trace does not stop at its boundary.
 *
 * A subgraph node is opaque from outside: the link ends at the wrapper,
 * not at whatever produced the value inside it. But an output slot of the
 * wrapper is fed, internally, by a link into the subgraph's output
 * boundary node at the same slot index -- so the real producer is one
 * hop further in. Loops until the origin is an ordinary node, which is
 * what makes NESTED subgraphs resolve as well.
 */
function throughSubgraph(origin, slot) {
    for (let depth = 0; depth < 8; depth++) {
        if (!origin?.isSubgraphNode?.()) break;
        const sub = origin.subgraph;
        const boundary = sub?.outputNode;
        if (!sub || !boundary) break;
        const link = linksOf(sub).find(
            (l) => l.target_id === boundary.id && l.target_slot === slot);
        const inner = link ? sub.getNodeById?.(link.origin_id) : null;
        if (!inner) break;          // unwired inside: nothing to follow
        origin = inner;
        slot = link.origin_slot;
    }
    return { node: origin, slot };
}

/**
 * The SetNode a GetNode reads, or null.
 *
 * Same graph first, then UPWARD through the subgraph instance -- the
 * direction KJNodes itself resolves the pair, and the only one that can
 * be answered from inside (a subgraph cannot see which sibling graphs
 * exist, but it can see out). The climb reuses instanceOf's rule:
 * several instances means no single answer, so the trace stops rather
 * than picking one.
 */
function setterFor(getNode) {
    const key = String(getNode.widgets?.[0]?.value ?? "");
    if (!key) return null;
    let g = getNode.graph;
    for (let depth = 0; g && depth < 8; depth++) {
        const hit = (g._nodes ?? g.nodes ?? []).find(
            (n) => n.type === "SetNode"
                   && String(n.widgets?.[0]?.value ?? "") === key);
        if (hit) return hit;
        g = instanceOf(g)?.graph ?? null;
    }
    return null;
}

/**
 * The node and output slot on the far end of an input's link.
 *
 * NOT descended through subgraphs: this is used for NAMING, and the name
 * of a socket should be the node you actually connected. Descending would
 * name a branch after whatever is buried inside the subgraph you wired --
 * "Bundle" rather than "vanilla 20 steps". Finding a Bundle's field list
 * is the opposite case, and that is what throughSubgraph is for.
 */
function instanceOf(sub) {
    const root = app.graph ?? app.rootGraph;
    const found = [];
    const walk = (g, level) => {
        if (!g || level > 8) return;
        for (const n of g._nodes ?? g.nodes ?? []) {
            if (n.subgraph === sub) found.push(n);
            if (n.subgraph) walk(n.subgraph, level + 1);
        }
    };
    walk(root, 0);
    // A definition can have several instances, and from inside there is no
    // way to tell which one is being looked at -- answer only when there
    // is exactly one, rather than picking.
    return found.length === 1 ? found[0] : null;
}

/** Is this link coming from the subgraph's own input boundary? */
function fromBoundary(graph, link) {
    const boundary = graph?.inputNode;
    return !!boundary && link != null && link.origin_id === boundary.id;
}

export function originOf(node, slot) {
    const link = linkById(node.graph, slot?.link);
    const from = link ? node.graph.getNodeById(link.origin_id) : null;
    return from ? { node: from, slot: link.origin_slot } : null;
}

/**
 * Name a field after whatever is plugged into it.
 *
 * The far end's own label is the best description available -- it is what
 * the producing node calls that output, and what the user renamed it to if
 * they did. Falls back to the node's title when the output is unnamed or
 * a bare wildcard, and numbers duplicates rather than packing two fields
 * under one key.
 */
function wireName(node, slot, used, preferTitle) {
    const source = originOf(node, slot);
    const out = source?.node?.outputs?.[source.slot];
    // A branch is better named after the NODE feeding it ("Upscale") than
    // after the slot's type ("IMAGE"), which several branches would share;
    // a packed field is the other way round.
    const title = String(source?.node?.title ?? "").trim();
    let base = preferTitle ? title.replace(/\s+/g, " ") : "";
    if (!base) {
        base = String(out?.label || out?.localized_name || out?.name || "").trim();
        if (!base || base === "*") base = title;
        // Field names are dict keys, so they are normalised to something
        // key-shaped. A branch name is a label the user reads and picks
        // from a list, so a title keeps its own spacing and capitals.
        base = base.toLowerCase().replace(/[^a-z0-9]+/g, "_")
                   .replace(/^_+|_+$/g, "");
    }
    if (!base) base = "value";
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    return name;
}

/**
 * The names a driven node's wires derive RIGHT NOW, in socket order.
 *
 * For the config dialog: derived names are de-duplicated by POSITION
 * ("value", "value_2", "value_3" for three unnamed wires), so a slot's
 * cached derived name goes stale the moment slots are reordered. The
 * dialog keys its renames by what the sync will derive after the move,
 * which is this.
 */
export function derivedFor(node) {
    const spec = DRIVEN[node?.type];
    if (!spec?.prefix) return [];
    return derivedNames(node, spec.prefix, spec.nameFrom === "title");
}

/** The wire-derived name for each connected socket, in order. */
function derivedNames(node, prefix, preferTitle) {
    const re = new RegExp(`^${prefix}\\d+$`);
    const used = new Set();
    return (node.inputs ?? [])
        .filter((slot) => re.test(slot.name) && slot.link != null)
        .map((slot) => wireName(node, slot, used, preferTitle));
}

/**
 * Grow-on-connect sockets, named from the far end of each wire.
 *
 * Every empty socket is dropped and exactly one spare added back, which is
 * what produces both halves of the behaviour: a socket appears as the last
 * one is filled, and unplugging one in the middle closes its gap instead
 * of leaving a hole. The sockets are then renumbered, because the prompt
 * maps `in_N` to name line N -- after a gap closes they have to be
 * back-to-back or every field below the gap would pack under the wrong
 * name.
 *
 * The names are written into the same `names` widget the plain Bundle
 * uses. They exist only in the browser otherwise, and the server has to
 * receive them somehow; going through the widget also means Unbundle and
 * Bundle Get trace this node exactly as they trace the other one.
 */
/**
 * One-time adoption of a typed names list into renames.
 *
 * Bundle used to come in two kinds: auto-named and typed. The merged
 * node derives names from the wires, which would silently rewrite a
 * typed list (turbo_loader, ...) the first time an old workflow loads.
 * Instead, the difference between the typed line and what the wire
 * derives is captured as a rename -- the node then shows exactly the
 * names it always had, through the same mechanism the config dialog
 * uses.
 *
 * The decision is only marked made once the wires are readable: the
 * first sync runs before onConfigure restores links and widget values,
 * and concluding "nothing to migrate" from that empty snapshot would be
 * wrong for the rest of the session.
 */
function migrateTypedNames(node, prefix, preferTitle) {
    if (node.__obvpmMigrated) return;
    if (node.properties?.obvpm_layout?.renames) {
        node.__obvpmMigrated = true;
        return;
    }
    const typed = LINES(widget(node, "names")?.value);
    if (!typed.length) return;           // new node, or not restored yet
    const derived = derivedNames(node, prefix, preferTitle);
    if (!derived.length) return;         // links not restored yet
    node.__obvpmMigrated = true;
    const renames = {};
    derived.forEach((name, i) => {
        if (typed[i] && typed[i] !== name) renames[name] = typed[i];
    });
    if (Object.keys(renames).length) {
        ((node.properties ??= {}).obvpm_layout ??= {}).renames = renames;
    }
}

function syncAutoSockets(node, prefix, max, listName, preferTitle) {
    const re = new RegExp(`^${prefix}\\d+$`);
    for (let i = (node.inputs?.length ?? 0) - 1; i >= 0; i--) {
        const slot = node.inputs[i];
        if (re.test(slot.name) && slot.link == null) removeInputAt(node, i);
    }
    const slots = () => (node.inputs ?? []).filter((s) => re.test(s.name));
    if (slots().length < max) {
        node.addInput(`${prefix}${slots().length + 1}`, "*",
                      { ...OPTIONAL_SLOT });
    }
    slots().forEach((slot, i) => { slot.name = `${prefix}${i + 1}`; });

    const derived = derivedNames(node, prefix, preferTitle);
    // The config dialog's renames, applied over what the wires derive --
    // keyed BY the derived name, so a rename survives re-derivation and
    // degrades to the derived name when its wire changes. Re-deduped
    // afterwards with the same _2 rule wireName uses: a rename target
    // colliding with a derived name must not pack two fields as one.
    const renames = node.properties?.obvpm_layout?.renames;
    let finals = derived;
    if (renames && typeof renames === "object") {
        const used = new Set();
        finals = derived.map((name) => {
            const base = typeof renames[name] === "string" && renames[name]
                ? renames[name] : name;
            let out = base;
            for (let n = 2; used.has(out); n++) out = `${base}_${n}`;
            used.add(out);
            return out;
        });
    }
    const names = [];
    slots().forEach((slot) => {
        slot.shape = HOLLOW_CIRCLE;
        if (slot.link == null) labelSlot(slot, "+");
    });
    slots().filter((slot) => slot.link != null).forEach((slot, i) => {
        // The derived name is NOT cached on the slot: de-duplication is
        // positional, so a cached name is wrong as soon as slots move.
        // The dialog re-derives (derivedFor) after it has moved them.
        labelSlot(slot, finals[i]);
        names.push(finals[i]);
    });

    const list = widget(node, listName);
    const text = names.join("\n");
    if (list && list.value !== text) {
        list.value = text;
        const listEl = list.element ?? list.inputEl;
        if (listEl) listEl.value = text;
    }
    node.graph?.setDirtyCanvas(true, true);
    notifyVue(node);
}

/**
 * Make a node as small as its sockets, with no title bar.
 *
 * `computeSize` is a MINIMUM, and its width is
 * `max(slotsWidth, widgetWidth, title_width, minWidth)` -- so a node can
 * never be narrower than its own title, and the mere presence of a widget
 * (visible or not, it counts `widgets.length`) raises the floor from 140
 * to 210. For a node whose entire content is a column of sockets, both
 * floors are the whole width. Core's Reroute has the same problem and
 * solves it the same way: override computeSize outright.
 *
 * The title bar goes the way Reroute's does, with `title_mode`. It is
 * read off the CONSTRUCTOR in the canvas renderer and off the instance in
 * places elsewhere, so both are set.
 */
const NO_TITLE = 1;   // TitleMode.NO_TITLE
const SLOT_PADDING = 6;

let measureCtx = null;
function textWidth(text) {
    const lg = typeof LiteGraph !== "undefined" ? LiteGraph : {};
    if (!measureCtx) {
        try {
            measureCtx = document.createElement("canvas").getContext("2d");
        } catch (err) {
            measureCtx = null;
        }
    }
    const str = String(text ?? "");
    if (!measureCtx) return str.length * ((lg.NODE_TEXT_SIZE ?? 14) * 0.6);
    measureCtx.font = `${lg.NODE_TEXT_SIZE ?? 14}px ${lg.NODE_FONT ?? "Arial"}`;
    return measureCtx.measureText(str).width;
}

/**
 * Tell the Nodes 2.0 renderer the sockets changed.
 *
 * The Vue renderer does not read the litegraph node; it draws from a
 * snapshot (`extractVueNodeData` into the node manager's `vueNodeData`
 * map). Adding, removing or relabelling a slot the way this file does
 * mutates the model without telling Vue, so in 2.0 nothing appears to
 * happen -- while the canvas renderer, reading the node directly, shows
 * it all. The manager re-extracts a node on `node:slot-links:changed`,
 * which litegraph itself fires whenever a widget-input link changes, so
 * it is a signal listeners already expect.
 */
const SLOT_TYPE_INPUT = 1;   // NodeSlotType.INPUT

/**
 * Name a socket.
 *
 * Both fields, always: readers are `label || localized_name || name`, and
 * the Nodes 2.0 snapshot does not necessarily carry the same one the
 * canvas renderer draws from. Setting only `label` leaves the other
 * renderer showing the raw slot name.
 */
export function labelSlot(slot, text) {
    slot.label = text;
    slot.localized_name = text;
}

/** What the renderer would draw, so a no-op change costs nothing. */
function slotSignature(node) {
    const one = (slot) => `${slot.name}${slot.label ?? ""}`;
    return [
        (node.inputs ?? []).map(one).join(","),
        (node.outputs ?? []).map(one).join(","),
    ].join("|");
}

export function notifyVue(node) {
    const signature = slotSignature(node);
    if (node.__obvpmSlotSig === signature) return;   // nothing moved
    node.__obvpmSlotSig = signature;
    try {
        // Nodes 2.0 draws from a snapshot taken by `extractVueNodeData`,
        // and nothing re-reads a known node's slots: `refreshNodeSlots`
        // only refreshes widget metadata, and the add hook does not
        // re-extract a node it has already seen. Dropping the node from
        // the manager first is what makes the add re-extract it -- the
        // node itself is untouched, only the renderer's copy of it.
        // Replace the slot OBJECTS, don't just edit them.
        //
        // A socket that is new appears in Nodes 2.0 straight away while a
        // socket that was merely renamed keeps its old text -- so the
        // snapshot is reusing the objects it already has and only picking
        // up ones it has not seen. Handing it fresh objects makes every
        // socket look new. The arrays are rebuilt in place, and links are
        // held by slot INDEX and by the `link` field copied here, so
        // nothing is disturbed by the change of identity.
        if (node.inputs) node.inputs = node.inputs.map((slot) => ({ ...slot }));
        if (node.outputs) node.outputs = node.outputs.map((s) => ({ ...s }));
        // The add hook re-extracts unconditionally and skips layout
        // creation when the node already has one, so it refreshes the
        // snapshot without disturbing position or size.
        node.graph?.onNodeAdded?.(node);
        // Renaming an existing slot needs saying separately: a re-extract
        // brings in slots that are NEW, but the snapshot reuses the
        // objects behind slots it already has, so their text goes stale.
        // Nodes 2.0 reads `localized_name || name` (never `label`) and has
        // its own event for a slot being renamed.
        for (const [side, kind] of [["inputs", 1], ["outputs", 2]]) {
            (node[side] ?? []).forEach((slot, slotIndex) => {
                node.graph?.trigger?.("node:slot-label:changed", {
                    nodeId: node.id,
                    slotType: kind,
                    slotIndex,
                    label: slot.localized_name ?? slot.label ?? slot.name,
                });
            });
        }
        // Widget slot metadata is refreshed by this instead.
        node.graph?.trigger?.("node:slot-links:changed", {
            nodeId: node.id,
            slotType: SLOT_TYPE_INPUT,
            slotIndex: 0,
            connected: (node.inputs?.[0]?.link ?? null) != null,
        });
    } catch (err) {
        console.error("[obvpm-dynamic] could not refresh the renderer:", err);
    }
}

/**
 * Nodes 2.0 styling for the compact nodes.
 *
 * That renderer ignores computeSize entirely: its width floor is a flat
 * `MIN_NODE_WIDTH` (225) written as an INLINE `--min-node-width`, and the
 * width itself is clamped to the same constant before being written as
 * `--node-width`. A stylesheet rule marked `!important` outranks a normal
 * inline declaration, which is the one lever that works from outside.
 *
 * Keyed on each node's own id so it only ever touches these nodes: badges
 * elsewhere stay the user's setting to make.
 */
const MIN_COMPACT_WIDTH = 40;
const COMPACT_RULES = (sel, width) => `
${sel} {
    --min-node-width: 0px !important;
    --node-width: ${width}px !important;
    min-width: ${width}px !important;
}
${sel} .rounded-b-xl {
    border-top-left-radius: 0.75rem !important;
    border-top-right-radius: 0.75rem !important;
}
${sel} .mt-auto,
${sel} [class*="badge" i],
${sel} [data-testid*="badge" i] {
    display: none !important;
}
${sel},
${sel} > [data-testid="node-inner-wrapper"] {
    /* --node-height is the body height PLUS a title row this node does
       not have; as a min-height it leaves 30px of nothing under the
       widgets, which the stretching widget row then fills. */
    min-height: 0 !important;
}
${sel} .bg-component-node-background.pb-3 {
    padding-bottom: 0.25rem !important;
}
${sel} .lg-node-widgets {
    /* The widget grid's columns have 80px and 125px minimums, wider than
       the whole node here, so a row overflowed to the right and its
       centred content sat off the node. */
    grid-template-columns: min-content minmax(0, 1fr) minmax(0, 1fr) !important;
}
`;

// A folded node is an ordinary collapsed node with its header back, so
// the compact width rules come off it. What stays: no title text (as on
// the canvas bar) and no 225px minimum width -- the header's own content,
// chevron and wire dots, is the whole node.
const FOLD_RULES = (sel) => `
${sel}[data-collapsed],
${sel}[data-collapsed] > [data-testid="node-inner-wrapper"] {
    min-width: 0 !important;
    width: max-content !important;
}
${sel}[data-collapsed] [data-testid="node-title"] {
    display: none !important;
}
`;


/**
 * Style the compact nodes BY ID rather than by a class added to their
 * element.
 *
 * Vue owns those elements and re-creates them; each time, a class we added
 * is gone until something puts it back, which is visible as the node
 * briefly showing its badge at full width before snapping small again. A
 * stylesheet keyed on `data-node-id` -- an attribute the renderer sets
 * itself -- is in force the instant the element exists, so there is no
 * intermediate frame to see.
 */
function installCompactCss() {
    if (typeof document === "undefined") return null;
    let style = document.getElementById("obvpm-compact-style");
    if (style) return style;
    style = document.createElement("style");
    style.id = "obvpm-compact-style";
    document.head?.appendChild(style);
    return style;
}

function refreshCompactCss() {
    const style = installCompactCss();
    if (!style) return;
    const rules = [];
    for (const [id, width] of COMPACT_NODES) {
        if (width != null) rules.push(COMPACT_RULES(`[data-node-id="${cssString(id)}"]`, width));
    }
    for (const id of FOLD_NODES) {
        rules.push(FOLD_RULES(`[data-node-id="${cssString(id)}"]`));
    }
    const css = rules.join("\n");
    if (style.textContent !== css) style.textContent = css;
}

// Which nodes want the treatment, and how wide. Vue owns these elements
// and re-creates them freely (scrolling a large graph is enough), so the
// marking is re-applied rather than set once. A folded node is registered
// with a null width: known, but not narrowed while it is collapsed.
const COMPACT_NODES = new Map();
const FOLD_NODES = new Set();

function applyVueCompact(node, width) {
    if (typeof document === "undefined") return;
    if (node.id == null || node.id === -1) return;   // not in the graph yet
    const px = isFolded(node) ? null : Math.max(MIN_COMPACT_WIDTH, Math.ceil(width));
    const id = String(node.id);
    const foldChanged = !!node.__obvpmFold && !FOLD_NODES.has(id);
    if (foldChanged) FOLD_NODES.add(id);
    if (COMPACT_NODES.has(id) && COMPACT_NODES.get(id) === px && !foldChanged) return;
    COMPACT_NODES.set(id, px);
    refreshCompactCss();
}

/**
 * Report what this frontend actually offers, so the Nodes 2.0 work can be
 * aimed at the real DOM instead of at the source I read it from. Call
 * `obvpmDiag()` in the console with one of these nodes on screen.
 */
function installDiagnostic() {
    if (typeof window === "undefined" || window.obvpmDiag) return;
    // For a DOM widget floating detached at the screen's top-left: that
    // is a widget whose store state was never painted (registerWidget
    // seeds visible:true, pos [0,0], and DomWidget.vue only styles it
    // when the per-frame updater mutates the state). This lists every
    // rendered .dom-widget wrapper with whose widget it is and whether
    // it ever got a transform -- the detached one is the row with no
    // transform. Pair it with the console: the updater aborting on an
    // earlier widget leaves errors there every frame.
    window.obvpmDomDiag = () => {
        const known = new Map();
        for (const n of window.app?.graph?._nodes ?? []) {
            for (const w of n.widgets ?? []) {
                const el = w.element ?? w.inputEl;
                if (el) known.set(el, { node: n.id, type: n.type,
                                        widget: w.name, y: w.y,
                                        hidden: !!w.hidden });
            }
        }
        const rows = [];
        document.querySelectorAll(".dom-widget").forEach((wrap) => {
            const inner = wrap.firstElementChild;
            rows.push({
                shown: wrap.style.display !== "none",
                positioned: !!wrap.style.transform,
                z: wrap.style.zIndex || "(unset)",
                text: (inner?.textContent ?? "").trim().slice(0, 40),
                ...(known.get(inner)
                    ?? { node: "NOT IN CURRENT GRAPH" }),
            });
        });
        console.table(rows);
        return rows.filter((r) => r.shown && !r.positioned);
    };
    window.obvpmDiag = (nodeId) => {
        const id = String(nodeId ?? [...COMPACT_NODES.keys()][0] ?? "");
        const el = document.querySelector(`[data-node-id="${cssString(id)}"]`);
        const graph = window.app?.graph;
        const report = {
            vueNodesMode: typeof LiteGraph !== "undefined"
                ? LiteGraph.vueNodesMode : "no LiteGraph",
            compactIds: [...COMPACT_NODES.keys()],
            inspecting: id,
            elementFound: !!el,
            styledById: !!COMPACT_NODES.get(id),
            styleTagInstalled: !!document.getElementById("obvpm-compact-style"),
            graphOnNodeAdded: typeof graph?.onNodeAdded,
            graphTrigger: typeof graph?.trigger,
            minNodeWidth: el && getComputedStyle(el)
                .getPropertyValue("--min-node-width"),
            nodeWidth: el && getComputedStyle(el)
                .getPropertyValue("--node-width"),
            offsetWidth: el?.offsetWidth,
        };
        console.log("[obvpm] diagnostic", report);
        if (el) {
            console.log("[obvpm] node element markup:\n"
                + el.outerHTML.slice(0, 3000));
            const badge = el.querySelector('[class*="badge" i]');
            console.log("[obvpm] badge inside node:", badge?.className ?? "none"
                + " -- if none, the badge is drawn outside the node element");
        }
        return report;
    };
}

/**
 * Keep the canvas renderer from drawing badges on a titleless node.
 *
 * Badges are drawn ABOVE the title bar. With no title there is nothing
 * under them, so they float detached in the space over the node. The
 * badge list is rebuilt by a watcher whenever the badge settings change,
 * so emptying the array once would not hold -- the property is replaced
 * with one that reads as empty and quietly swallows what is assigned.
 */
/**
 * Take the text off the single bundle pin.
 *
 * On these nodes it is the only pin of its kind, so "in" / "out" says
 * nothing the shape doesn't, and on a node this small the word is a
 * sizeable fraction of the width.
 *
 * A blank string will NOT do: every reader is `label || localized_name ||
 * name`, so an empty label falls straight back to the slot name. A single
 * space survives that chain and draws as nothing. Both fields are set,
 * because the canvas renderer prefers `label` and Nodes 2.0 reads
 * `localized_name` and never looks at `label` at all.
 */
// "bundle" is the pre-merge Bundle's output name, alive in old saves.
const PLUG_PINS = new Set(["in", "out", "bundle"]);

function blankPlugPins(node) {
    for (const slots of [node.inputs, node.outputs]) {
        for (const slot of slots ?? []) {
            if (PLUG_PINS.has(slot.name)) labelSlot(slot, " ");
        }
    }
}

function silenceBadges(node) {
    if (node.__obvpmBadgesSilenced) return;
    node.__obvpmBadgesSilenced = true;
    try {
        Object.defineProperty(node, "badges", {
            configurable: true,
            get: () => [],
            set: () => {},
        });
    } catch (err) {
        node.badges = [];      // at least clear what is there now
    }
}

function makeCompact(nodeType) {
    nodeType.title_mode = NO_TITLE;
    // The collapse toggle lives at the node's top-left, normally inside
    // the title bar. With no title bar it is still hit-tested, and on a
    // node this short it lands on the first input -- which is why that
    // one pin refuses a wire while every other pin works. Core's Reroute
    // registers `collapsable: false` next to `title_mode` for the same
    // reason; both are read off the constructor
    // (`this.constructor.collapsable !== false`).
    nodeType.collapsable = false;
    nodeType.prototype.computeSize = function () {
        const lg = typeof LiteGraph !== "undefined" ? LiteGraph : {};
        const slotHeight = lg.NODE_SLOT_HEIGHT ?? 20;
        const label = (slot) =>
            slot.label || slot.localized_name || slot.name || "";
        // Widget-backed slots are drawn with their widget, not as a row.
        const inputs = (this.inputs ?? []).filter((slot) => !slot.widget);
        const outputs = this.outputs ?? [];
        const widest = (slots) =>
            slots.reduce((w, slot) => Math.max(w, textWidth(label(slot))), 0);
        const inWidth = widest(inputs);
        const outWidth = widest(outputs);
        const width = inWidth + outWidth + 2 * slotHeight
            + (inWidth && outWidth ? 5 : 0);
        const rows = Math.max(inputs.length, outputs.length, 1);
        // Visible DOM widgets (the ⚙ config row) live below the sockets
        // and size through computeLayoutSize; without their height here
        // they overlap the node's bottom edge.
        const domHeight = (this.widgets ?? [])
            .filter((w) => !w.hidden && w.computeLayoutSize)
            .reduce((h, w) =>
                h + (w.computeLayoutSize(this)?.minHeight ?? 0), 0);
        // Slots sit at (n + 0.7) * NODE_SLOT_HEIGHT, so the last one's
        // centre is already most of the way down its row: an exact
        // rows * height leaves it flush against the bottom edge with its
        // lower half outside the node. The padding is what gives the
        // bottom row somewhere to sit, and the top row room above it.
        return [
            Math.max(width, 2 * slotHeight),
            Math.max((this.constructor.slot_start_y || 0)
                     + rows * slotHeight + SLOT_PADDING, slotHeight + 6)
                + domHeight,
        ];
    };
}

/**
 * Hide a widget while keeping it serialised.
 *
 * The auto nodes have no list to show, but the names still have to reach
 * the server, and a widget's value is the only thing a prompt carries --
 * so the widget stays, holding what the wires produced, and only its row
 * is taken away. Both renderers are told: the canvas one reads
 * `widget.hidden`, the Vue one `options.hidden`, and the zero height with
 * the -4 offset cancels the spacing the row would otherwise reserve.
 */
function hideWidget(node, name) {
    const w = widget(node, name);
    if (!w || w.hidden) return;
    try {
        w.hidden = true;
        // Mutated, not replaced: `options` can be a getter on some widget
        // types, and assigning to one throws (modules are strict mode).
        if (w.options) w.options.hidden = true;
        w.computeSize = () => [0, -4];
        // DOM widgets are laid out through computeLayoutSize, not
        // computeSize -- leaving that reporting a minimum height keeps the
        // node from shrinking past it, and the two disagreeing is worse
        // than either alone.
        w.computeLayoutSize = () => ({
            minHeight: 0, minWidth: 0, maxHeight: 0, maxWidth: 0,
        });
        const el = w.element ?? w.inputEl;
        if (el) el.style.display = "none";
        // Every widget also gets an input SOCKET (litegraphService adds one
        // unless the widget is `socketless`). Hiding the widget leaves that
        // socket behind: invisible, but still first in the list and still
        // hit-tested, so it sits over the top of the first real pin and
        // takes the wire. The widget's value travels in widgets_values, not
        // through the socket, so dropping it costs nothing.
        const at = (node.inputs ?? []).findIndex(
            (slot) => slot.widget && (slot.widget.name === name
                                      || slot.name === name));
        if (at >= 0 && node.inputs[at].link == null) removeInputAt(node, at);
    } catch (err) {
        console.error("[obvpm-dynamic] could not hide the list widget:", err);
    }
}

/**
 * Re-sync on the two events that can change a node's list without touching
 * one of its widgets: a link being made or broken, and a workflow loading.
 *
 * Both are deferred a tick. Loading replaces the inputs wholesale AFTER
 * onConfigure returns, and a connection change fires mid-teardown -- adding
 * or removing sockets before either has settled works against a structure
 * that is still moving.
 */
function watchGraph(node) {
    // Joining the graph is when a node first gets an id, and the id is
    // what the Nodes 2.0 styling is keyed on -- a node created from the
    // menu is built before that happens, so the first sync runs too early
    // to style it. This is the moment it becomes addressable.
    const onAdded = node.onAdded;
    node.onAdded = function () {
        const r = onAdded?.apply(this, arguments);
        setTimeout(() => resyncGraph(node), 0);
        return r;
    };
    const onConnectionsChange = node.onConnectionsChange;
    node.onConnectionsChange = function () {
        const r = onConnectionsChange?.apply(this, arguments);
        setTimeout(() => resyncGraph(node), 0);
        return r;
    };
    const onConfigure = node.onConfigure;
    node.onConfigure = function () {
        const r = onConfigure?.apply(this, arguments);
        setTimeout(() => resyncGraph(node), 0);
        return r;
    };
}

// Which multiline widget drives each node, and what its lines control.
const DRIVEN = {
    "Dropdown (obvpm)": { list: "options" },
    "LazyCaseSwitch (obvpm)": {
        list: "cases", side: "inputs", prefix: "on_case_", pin: "fallback",
    },
    // Same switch, named by what is wired into it. A branch is named after
    // the NODE feeding it rather than the slot's type, which several
    // branches would share.
    "LazyCaseSwitchAuto (obvpm)": {
        list: "cases", side: "inputs", prefix: "on_case_", pin: "fallback",
        autogrow: true, nameFrom: "title",
    },
    // ONE Bundle: fields named from the wires, renamed/reordered through
    // the config dialog. The hidden names list is still the server
    // channel, and a typed list from the pre-merge node is adopted as
    // renames on first load (migrateTypedNames).
    "Bundle (obvpm)": {
        list: "names", side: "inputs", prefix: "in_", autogrow: true,
        compact: true, fold: true,
        config: openBundleConfig, menu: "Configure bundle…",
        // The class no longer declares the second "names" output, but a
        // node saved before the merge keeps its outputs array; dropped
        // in sync once nothing is wired there.
        dropOutput: "names",
    },
    // ONE Unbundle: outputs traced off the wire; the config dialog's
    // layout (reorder/hide) writes the hidden names list, which the
    // server pulls by name. Its single pin is named "in", so that is
    // what the trace starts from.
    "Unbundle (obvpm)": {
        list: "names", side: "outputs", prefix: "out_", trace: "in",
        compact: true, hideList: true, fold: true,
        config: openUnbundleConfig, menu: "Configure outputs…",
    },
};

app.registerExtension({
    name: "obvpm.dynamic",
    setup() {
        // At load, not on first use: the stylesheet and the element watcher
        // have to be in place before any node element is created.
        refreshCompactCss();
        installDiagnostic();
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        const spec = DRIVEN[nodeData.name];
        if (!spec) return;
        const max = spec.side
            ? poolSize(nodeData, spec.prefix, spec.side)
            : 0;
        if (spec.compact) makeCompact(nodeType);
        if (spec.config) {
            // Renderer-independent ways in, beside the ⚙ row: they cost
            // nothing and survive any future compact-styling change.
            const label = spec.menu ?? "Configure…";
            const prevMenu = nodeType.prototype.getExtraMenuOptions;
            nodeType.prototype.getExtraMenuOptions = function (_, options) {
                const r = prevMenu?.apply(this, arguments);
                const self = this;
                options?.push({ content: label,
                                callback: () => spec.config(self) });
                return r;
            };
            const prevDbl = nodeType.prototype.onDblClick;
            nodeType.prototype.onDblClick = function () {
                spec.config(this);
                return prevDbl?.apply(this, arguments) ?? true;
            };
        }

        // Sockets come and go on these, so the fit has to be redone rather
        // than set once. Appearance only: a failure here must never stop
        // the node working, so it is contained rather than left to unwind
        // through the sync.
        const refit = (node) => {
            if (!spec.compact) return;
            try {
                // NOT node.title_mode: that is a getter on the instance,
                // reading the constructor. makeCompact sets it there, the
                // way Reroute does; assigning to the instance throws.
                // Not resizable: the size is entirely determined by the
                // sockets, so there is nothing for a drag to decide, and
                // a hand-set width would only be overwritten on the next
                // socket change. The snapshot carries `resizable`, so the
                // handles go away in Nodes 2.0 as well.
                node.resizable = false;
                silenceBadges(node);
                blankPlugPins(node);
                // A node loaded with its collapsed flag set gets its title
                // back here; a fold flipped since the last sync likewise.
                if (spec.fold && syncFold(node)) node.__obvpmSlotSig = null;
                const size = node.computeSize();
                // Collapsed, litegraph draws the title row and ignores the
                // size; it is still kept current for the unfold.
                node.setSize?.(size);
                // Registers the node with the watcher; the element itself
                // is marked whenever it turns up. A node created from the
                // menu has no id until it joins the graph, so retry once
                // -- otherwise it is registered under a placeholder and
                // stays unstyled until something else triggers a sync.
                applyVueCompact(node, size[0]);
                if (node.id == null || node.id === -1) {
                    setTimeout(() => applyVueCompact(node, size[0]), 0);
                }
                // This runs after the sync has already published, and the
                // pin text was changed above. Cheap to repeat: it compares
                // a signature first and does nothing when nothing moved.
                notifyVue(node);
            } catch (err) {
                console.error("[obvpm-dynamic] compact sizing failed:", err);
            }
        };

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;
            // The node still has its full declared pool at this point.
            const pool = Math.max(max, countSlots(node, spec.side, spec.prefix));
            try {
                // The nodes with a config dialog get their small way in;
                // right-click and double-click are wired on the type.
                // Folding first: its double-click wrap must sit over the
                // type's, and the fold button rides the same row.
                if (spec.fold) {
                    installFold(node, (n) => {
                        // The title changed hands: Nodes 2.0 must take a
                        // fresh snapshot (titleMode lives in it), which
                        // notifyVue skips unless the slots moved.
                        n.__obvpmSlotSig = null;
                        refit(n);
                    }, () => !(typeof LiteGraph !== "undefined"
                               && LiteGraph.vueNodesMode));
                }
                if (spec.config) {
                    addConfigButton(node, spec.config,
                                    spec.fold ? [foldButton(node, el)] : []);
                }
                // The auto Bundle runs the same list the other way round:
                // the wires write it, rather than it describing the wires.
                if (spec.autogrow) {
                    hideWidget(node, spec.list);
                    // The list is written by the wires, so the dropdown
                    // reads it straight back out of the hidden widget --
                    // the branch names and the choices cannot drift apart
                    // because they are literally the same lines.
                    const autoValues = () => LINES(widget(node, spec.list)?.value);
                    const autoCombo = widget(node, "selected")
                        ? asDropdown(node, "selected", autoValues)
                        : null;
                    node.__obvpmSync = () => {
                        hideWidget(node, spec.list);   // DOM arrives late
                        if (spec.dropOutput) {
                            // Output slots hold links by index, so the
                            // removal repaints downstream targets? No --
                            // outputs hold OUR links; removing an output
                            // shifts the ones after it, which is why the
                            // dropped pin must be the LAST output. It is:
                            // "names" was declared second of two.
                            const at = (node.outputs ?? []).findIndex(
                                (o) => o.name === spec.dropOutput);
                            if (at >= 0 && at === node.outputs.length - 1
                                && !node.outputs[at].links?.length) {
                                node.removeOutput(at);
                            }
                        }
                        // A typed list from the pre-merge Bundle becomes
                        // renames BEFORE the sync rewrites the widget
                        // from the wires -- order matters, or the typed
                        // names are gone before they can be read.
                        migrateTypedNames(node, spec.prefix,
                                          spec.nameFrom === "title");
                        syncAutoSockets(node, spec.prefix, pool, spec.list,
                                        spec.nameFrom === "title");
                        if (spec.pin) {
                            moveAboveSockets(node, spec.pin, spec.prefix);
                        }
                        if (autoCombo) {
                            autoCombo.options.values = autoValues;
                            defaultTo(autoCombo, autoValues, node);
                        }
                        refit(node);
                    };
                    // Installed BEFORE the first sync: if that throws, the
                    // node must still react to being wired up. Losing the
                    // listener is what turns one bad call into a node that
                    // silently does nothing for the rest of the session.
                    watchGraph(node);
                    node.__obvpmSync();
                    return result;
                }
                // Every other node reads its list from one multiline
                // widget, so the dropdown, the socket labels and the
                // routing cannot drift apart -- they are the same lines.
                // Wiring that widget swaps where the lines come from, not
                // what they mean, so nothing else here changes.
                const listName = spec.list;
                const valuesFn = () => {
                    const own = listName ? listLines(node, listName) : [];
                    // An explicit list always wins: it is how you reorder,
                    // take a subset, or work when the trace comes up empty.
                    if (own.length || !spec.trace) return own;
                    return bundleNamesFor(node, spec.trace) ?? [];
                };
                const combo = widget(node, "selected")
                    ? asDropdown(node, "selected", valuesFn)
                    : null;

                node.__obvpmSync = () => {
                    if (spec.hideList) hideWidget(node, spec.list);
                    if (combo) {
                        combo.options.values = valuesFn;
                        // A stale selection is the user's to resolve (the
                        // node refuses rather than silently choosing
                        // something else), so only fill in blanks.
                        defaultTo(combo, valuesFn, node);
                    }
                    if (spec.pin) moveAboveSockets(node, spec.pin, spec.prefix);
                    if (spec.trace && hasUnbundleLayout(node)) {
                        // A configured Unbundle: the layout owns the
                        // outputs -- order, subset, and the hidden names
                        // widget. It moves links BY NAME, so it is safe
                        // on every sync, and new upstream fields still
                        // append (arrange reads the live trace).
                        applyUnbundleLayout(node);
                    } else if (spec.side) {
                        syncSockets(node, spec.side, spec.prefix,
                                    valuesFn(), pool);
                    }
                    refit(node);
                };
                watchGraph(node);      // before the first sync -- see above
                node.__obvpmSync();

                const source = listName ? widget(node, listName) : null;
                if (source) {
                    const previous = source.callback;
                    source.callback = function () {
                        const r = previous?.apply(this, arguments);
                        resyncGraph(node);   // consumers of this list too
                        return r;
                    };
                    // The textarea's DOM element edits in place; its widget
                    // callback only fires on commit in some renderers.
                    (source.element ?? source.inputEl)?.addEventListener("input", () => {
                        resyncGraph(node);
                    });
                }
            } catch (err) {
                console.error("[obvpm-dynamic] dropdown setup failed:", err);
            }
            return result;
        };
    },
});
