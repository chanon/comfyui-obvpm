import { app } from "../../scripts/app.js";
import { dropWidgetSockets } from "./obvpm_ui.js";

// Constants on Bundle and Unbundle: the "set" / "get" option in the node's
// ⚙ dialog joins a Bundle and an Unbundle by a NAME instead of a wire, the
// way KJNodes' Set and Get nodes join any two sockets -- and in KJNodes'
// namespace, so the families mix: a KJ Get can read a setting Bundle, and
// a getting Unbundle can read a KJ Set that carries a bundle.
//
// The option is the whole switch. Off -- the default, and every Bundle and
// Unbundle saved before it existed -- the node is exactly what it always
// was: the name field is hidden, an Unbundle has its `in` socket, and a
// stale name counts for nothing. On, the name field shows, the title
// follows it ("Set name" / "Get name", which is also what the folded bar
// shows), and an Unbundle's `in` socket goes: its bundle comes by name.
// The state is a node property, so it saves with the workflow.
//
// The difference from KJNodes is what the two ends ARE. KJ's Set and Get
// are virtual: the frontend drops them from the prompt and the Get's
// consumers are wired straight to whatever feeds the Set. Bundle and
// Unbundle are real nodes (they pack and unpack on the server), so:
//
// - A KJ Get reading a setting Bundle resolves, natively, through the
//   frontend's `resolveVirtualOutput` hook (1.52 and 1.53 both have it):
//   the Get answers "the Bundle's output 0". A wrapper on KJ's Get.
// - A getting Unbundle has no input socket, and the frontend has no hook
//   for filling an unwired input on a real node (its resolver returns
//   nothing for a socket without a link, and the resolver class is not
//   reachable from an extension). So `in` is filled after the prompt is
//   built: find the setter the way KJNodes does (own graph, then each
//   parent) and follow its feed with a small resolver that mirrors the
//   frontend's -- through subgraphs, bypassed and muted nodes, and
//   virtual nodes such as KJ's own Get.
//
// Names follow KJNodes' rules: a setter is visible in its own graph and
// every subgraph below it; a getter looks in its own graph, then up.
// Setter names are unique within that scope, across both families.

export const BUNDLE = "Bundle (obvpm)";
export const UNBUNDLE = "Unbundle (obvpm)";
const KJ_SET = "SetNode";
const KJ_GET = "GetNode";
const BUNDLE_TYPE = "OBVPM_BUNDLE";   // see h3/wiretypes.py
// The name fields, declared server-side (optional, after `names`).
const SET_W = "set";
const GET_W = "get";
// Node properties: the option, the title it replaced, the last name.
const MODE_PROP = "obvpm_constant";
const TITLE_PROP = "obvpm_title";
const PREV_PROP = "obvpm_previous";
const MODE_NEVER = 2;     // LGraphEventMode.NEVER (muted)
const MODE_BYPASS = 4;    // LGraphEventMode.BYPASS
const HOLLOW_CIRCLE = 7;  // RenderShape.HollowCircle: `in` is optional

// ---------------------------------------------------------------------
// Names and scope
// ---------------------------------------------------------------------

/** "set" on a Bundle, "get" on an Unbundle, else null. */
function kindOf(node) {
    if (node?.__obvpmConstKind) return node.__obvpmConstKind;
    if (node?.type === BUNDLE) return "set";
    if (node?.type === UNBUNDLE) return "get";
    return null;
}

/** Is this Bundle / Unbundle's set / get option on? */
export function constantOn(node) {
    return !!node?.properties?.[MODE_PROP];
}

function nameWidget(node) {
    const want = kindOf(node) === "get" ? GET_W : SET_W;
    return node?.widgets?.find((w) => w.name === want) ?? null;
}

/** A Bundle with its set option on. */
export function isOurSetter(node) {
    return node?.type === BUNDLE && constantOn(node);
}

/** An Unbundle with its get option on. */
export function isOurGetter(node) {
    return node?.type === UNBUNDLE && constantOn(node);
}

export function isConstantSetter(node) {
    return node?.type === KJ_SET || isOurSetter(node);
}

export function isConstantGetter(node) {
    return node?.type === KJ_GET || isOurGetter(node);
}

export function isUnbundle(node) {
    return node?.type === UNBUNDLE;
}

/**
 * The constant a setter or getter names. KJNodes keeps it in
 * `widgets[0]`; ours by name, and only while the option is on -- off, a
 * leftover name means nothing.
 */
export function constantOf(node) {
    if (kindOf(node)) {
        return constantOn(node) ? String(nameWidget(node)?.value ?? "") : "";
    }
    return String(node?.widgets?.[0]?.value ?? "");
}

function nodesOf(graph) {
    return graph?._nodes ?? graph?.nodes ?? [];
}

function rootOf(graph) {
    return graph?.rootGraph || graph || null;
}

function linkOf(graph, id) {
    if (!graph || id == null) return null;
    if (typeof graph.getLink === "function") return graph.getLink(id) ?? null;
    const links = graph.links;
    if (!links) return null;
    return typeof links.get === "function" ? links.get(id) : links[id];
}

function linksOf(graph) {
    const links = graph?.links;
    if (!links) return [];
    return typeof links.values === "function"
        ? [...links.values()] : Object.values(links);
}

/** Every subgraph definition, root first -- where nested instances live. */
function allGraphs(graph) {
    const root = rootOf(graph);
    if (!root) return [];
    const subs = root._subgraphs || root.subgraphs;
    return [root, ...(subs ? subs.values() : [])];
}

/**
 * [graph, parent, grandparent, ..., root]: the graphs whose setters a
 * getter in `graph` can see. Same walk as KJNodes' getGraphAncestors --
 * the parent of a subgraph definition is the graph holding a node that
 * instances it.
 */
export function graphAncestors(graph) {
    const root = rootOf(graph);
    if (!graph || !root) return [];
    const chain = [graph];
    let current = graph;
    for (let depth = 0; current !== root && depth < 32; depth++) {
        const parent = allGraphs(root).find((g) => g !== current
            && nodesOf(g).some((n) => n.subgraph === current));
        if (!parent || chain.includes(parent)) {
            if (!chain.includes(root)) chain.push(root);
            break;
        }
        chain.push(parent);
        current = parent;
    }
    return chain;
}

/** `graph` and every subgraph instanced below it. */
function graphDescendants(graph, seen = new Set()) {
    if (!graph || seen.has(graph)) return [];
    seen.add(graph);
    const out = [graph];
    for (const n of nodesOf(graph)) {
        if (n.subgraph) out.push(...graphDescendants(n.subgraph, seen));
    }
    return out;
}

/** A setter can hand its constant to an Unbundle only if it is a bundle. */
export function carriesBundle(setter) {
    if (isOurSetter(setter)) return true;
    const type = String(setter?.inputs?.[0]?.type ?? "");
    return type.split(",").includes(BUNDLE_TYPE);
}

/**
 * The nearest setter called `name` seen from `graph`: own graph first,
 * then up. Returns { node, graph } or null. `accept` narrows the kinds.
 */
export function findConstantSetter(graph, name, accept = isConstantSetter) {
    if (!name) return null;
    for (const g of graphAncestors(graph)) {
        const node = nodesOf(g).find((n) => accept(n)
                                           && constantOf(n) === name);
        if (node) return { node, graph: g };
    }
    return null;
}

/** Setter names visible from `graph`, sorted. */
function visibleSetterNames(graph, accept = () => true) {
    const names = new Set();
    for (const g of graphAncestors(graph)) {
        for (const n of nodesOf(g)) {
            if (!isConstantSetter(n) || !accept(n)) continue;
            const name = constantOf(n);
            if (name) names.add(name);
        }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
}

/** Getters of either family reading `name` in `graph` or below it. */
function gettersNamed(graph, name) {
    if (!name) return [];
    return graphDescendants(graph).flatMap((g) => nodesOf(g)
        .filter((n) => isConstantGetter(n) && constantOf(n) === name));
}

/** KJNodes' title style for ITS nodes ("Get_name" unless turned off). */
function kjTitle(prefix, name) {
    let bare = false;
    try {
        bare = !!app.ui?.settings?.getSettingValue?.("KJNodes.disablePrefix");
    } catch (err) { /* setting not registered: KJ default */ }
    return (bare ? "" : prefix + "_") + name;
}

// ---------------------------------------------------------------------
// Bundle and Unbundle
// ---------------------------------------------------------------------

function titleFor(node) {
    const name = String(nameWidget(node)?.value ?? "");
    const prefix = kindOf(node) === "get" ? "Get" : "Set";
    return name ? `${prefix} ${name}` : prefix;
}

/** On: the title follows the name. The replaced title is kept. */
function retitle(node) {
    if (!constantOn(node)) return;
    node.properties ??= {};
    if (node.properties[TITLE_PROP] == null) {
        node.properties[TITLE_PROP] = node.title ?? "";
    }
    const title = titleFor(node);
    if (node.title !== title) {
        node.title = title;
        node.setDirtyCanvas?.(true, true);
    }
}

/** Off: the title it had before. */
function restoreTitle(node) {
    const kept = node.properties?.[TITLE_PROP];
    if (kept == null) return;
    delete node.properties[TITLE_PROP];
    if (kept) node.title = kept;
    node.setDirtyCanvas?.(true, true);
}

let measureCtx = null;
/**
 * Text width in a node font: widget text is drawn in the inner font
 * (NODE_SUBTEXT_SIZE, 12px), a title in the title font (NODE_TEXT_SIZE,
 * 14px).
 */
function textWidth(text, title = false) {
    const lg = typeof LiteGraph !== "undefined" ? LiteGraph : {};
    const px = title ? (lg.NODE_TEXT_SIZE ?? 14) : (lg.NODE_SUBTEXT_SIZE ?? 12);
    try {
        measureCtx ??= document.createElement("canvas").getContext("2d");
        measureCtx.font = `${title ? "" : "normal "}${px}px ${lg.NODE_FONT ?? "Arial"}`;
        return measureCtx.measureText(String(text ?? "")).width;
    } catch (err) {
        return String(text ?? "").length * px * 0.5;
    }
}

// The classic renderer's widget layout (BaseWidget, the same in frontend
// 1.52 and 1.53): a label and value draw untruncated when the node is at
// least label + GAP + value + 4 * MARGIN + the widget's own paddings wide
// -- none for a text field, 5 left and 20 right for a dropdown (its
// arrows).
const WIDGET_MARGIN = 15;
const LABEL_VALUE_GAP = 5;
const COMBO_PADDING = 5 + 20;

/**
 * How wide the node must be -- no wider. Off: nothing, as before.
 *
 * On and unfolded: exactly what the name field needs to show its label
 * and the whole name.
 *
 * Folded: what the bar shows. Litegraph (1.52 and 1.53 alike) draws a
 * collapsed title in the title font, cut to its first 20 characters,
 * from one title height in -- but sizes the bar as min(node width,
 * WHOLE title in the smaller inner font + 2 title heights), so a long
 * name gets a bar far wider than its text, and the node's width is the
 * only say we have. So the width asked for is the drawn text plus a
 * title height each side. Folding and unfolding both refit, so the node
 * takes the bar's width and gives it back.
 */
function minWidth(node) {
    if (!constantOn(node)) return 0;
    const lg = typeof LiteGraph !== "undefined" ? LiteGraph : {};
    if (node.flags?.collapsed) {
        const shown = String(node.getTitle?.() ?? node.title ?? "").substr(0, 20);
        return Math.ceil(textWidth(shown, true) + 2 * (lg.NODE_TITLE_HEIGHT ?? 30));
    }
    const w = nameWidget(node);
    const need = textWidth(w?.label || w?.name || "") + LABEL_VALUE_GAP
        + textWidth(w?.value ?? "") + 4 * WIDGET_MARGIN
        + (kindOf(node) === "get" ? COMBO_PADDING : 0);
    return Math.min(480, Math.ceil(need));
}

function sync(node) {
    try {
        node.__obvpmSync?.();
    } catch (err) {
        console.error("[obvpm-constants] sync failed:", err);
    }
}

/** Re-derive a getter from its constant: title, outputs, all of it. */
function refreshGetter(node) {
    if (isOurGetter(node)) {
        retitle(node);
        sync(node);
    } else if (node.type === KJ_GET) {
        node.onRename?.();
    }
}

/**
 * Make a setter's name unique in its scope, the way KJNodes does it:
 * `name`, then `name_0`, `name_1`, ... Both families count, in this
 * graph and the graphs above it (`sameGraphOnly` for a paste, which is
 * KJNodes' rule too). Returns true if the name changed.
 */
function uniquify(node, graph, sameGraphOnly = false) {
    const w = kindOf(node) ? nameWidget(node) : node.widgets?.[0];
    const name = String(w?.value ?? "");
    if (!w || !name || !graph) return false;
    const scope = sameGraphOnly ? [graph] : graphAncestors(graph);
    const taken = new Set();
    for (const g of scope) {
        for (const n of nodesOf(g)) {
            if (n !== node && isConstantSetter(n)) taken.add(constantOf(n));
        }
    }
    if (!taken.has(name)) return false;
    // A pasted copy strips its old suffix first, as KJNodes does, so a
    // copy of a copy is name_1 rather than name_0_0.
    const base = node.__obvpmJustAdded ? name.replace(/_\d+$/, "") : name;
    let i = 0;
    while (taken.has(`${base}_${i}`)) i++;
    w.value = `${base}_${i}`;
    return true;
}

/** A setter was renamed: every getter of the old name follows it. */
function renameGetters(graph, from, to) {
    if (!from || !to || from === to) return;
    for (const getter of gettersNamed(graph, from)) {
        if (getter.type === KJ_GET) {
            getter.setName?.(to);
        } else {
            const w = nameWidget(getter);
            if (w) w.value = to;
            refreshGetter(getter);
        }
    }
}

/** Getters of `name` (below `graph`) re-trace: their setter changed. */
function refreshGettersNamed(graph, name) {
    for (const getter of gettersNamed(graph, name)) {
        if (isOurGetter(getter)) refreshGetter(getter);
    }
}

function showNameWidget(node, show) {
    const w = nameWidget(node);
    if (!w) return;
    w.hidden = !show;
    (w.options ??= {}).hidden = !show;
    const elm = w.element ?? w.inputEl;
    if (elm) elm.style.display = show ? "" : "none";
}

/** Put a moved socket's links back on the right slot index. */
function repoint(node) {
    (node.inputs ?? []).forEach((slot, index) => {
        const link = linkOf(node.graph, slot.link);
        if (link) link.target_slot = index;
    });
}

/** Get mode: the bundle comes by name, so `in` goes (and its wire). */
function dropInSocket(node) {
    const i = (node.inputs ?? []).findIndex((s) => s.name === "in");
    if (i < 0) return;
    if (node.inputs[i].link != null) node.disconnectInput?.(i);
    node.removeInput(i);
    repoint(node);
}

/** Off again: `in` comes back, first, as the class declares it. */
function restoreInSocket(node) {
    if ((node.inputs ?? []).some((s) => s.name === "in")) return;
    node.addInput("in", BUNDLE_TYPE, { shape: HOLLOW_CIRCLE });
    const at = node.inputs.findIndex((s) => s.name === "in");
    if (at > 0) node.inputs.unshift(node.inputs.splice(at, 1)[0]);
    repoint(node);
}

/** Make the node match its option. Idempotent. */
function applyMode(node) {
    const on = constantOn(node);
    showNameWidget(node, on);
    if (kindOf(node) === "get") {
        if (on) dropInSocket(node); else restoreInSocket(node);
    }
    if (on) retitle(node); else restoreTitle(node);
}

/**
 * Turn a Bundle's set / an Unbundle's get on or off. Called by the ⚙
 * dialog (obvpm_bundle_config.js) when it is confirmed.
 */
export function setMode(node, on) {
    node.properties ??= {};
    const before = constantOf(node);          // "" while off
    if (on) node.properties[MODE_PROP] = true;
    else delete node.properties[MODE_PROP];
    applyMode(node);
    const graph = node.graph;
    if (kindOf(node) === "set" && graph) {
        if (on && uniquify(node, graph)) retitle(node);
        node.properties[PREV_PROP] = constantOf(node);
        refreshGettersNamed(graph, on ? constantOf(node) : before);
        if (!on) {
            // Getters of the old name have nothing to read now.
            for (const g of graphDescendants(graph).flatMap(nodesOf)) {
                if (isOurGetter(g) && constantOf(g) === before) refreshGetter(g);
            }
        }
    }
    sync(node);
    node.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

// Paste coordination, as in KJNodes: a pasted setter that had to be
// renamed tells the getters pasted with it.
const pasteRenames = new Map();

/**
 * Replace the declared text widget with a combo, in place.
 *
 * In place because widgets_values is positional. The old widget comes
 * OUT before the combo goes in: frontend 1.53 renames a widget added
 * under a name the node already has ("get" -> "get#1"), and nothing
 * would find it again (issue #12's lesson).
 */
function asCombo(node, name, valuesFn, onChange) {
    const index = node.widgets?.findIndex((w) => w.name === name) ?? -1;
    if (index < 0) return null;
    const old = node.widgets[index];
    if (old.type === "combo") {
        old.options.values = valuesFn;
        return old;
    }
    const value = old.value ?? "";
    node.widgets.splice(index, 1);
    const combo = node.addWidget("combo", name, value, onChange,
                                 { values: valuesFn });
    combo.value = value;                // through to the surviving state
    combo.serialize = true;
    if (old.tooltip) combo.tooltip = old.tooltip;
    const appended = node.widgets.indexOf(combo);
    if (appended >= 0) node.widgets.splice(appended, 1);
    node.widgets.splice(index, 0, combo);
    return combo;
}

/** Centre the canvas on a node, entering its graph if it lives elsewhere. */
function showNode(node) {
    const canvas = app.canvas;
    if (!canvas || !node?.graph) return;
    const go = () => {
        canvas.centerOnNode?.(node);
        canvas.selectNode?.(node, false);
        canvas.setDirty?.(true, true);
    };
    if (canvas.graph !== node.graph && canvas.setGraph) {
        canvas.setGraph(node.graph);
        setTimeout(go, 0);
    } else {
        go();
    }
}

function addPairedGetter(setter) {
    const graph = setter.graph;
    const getter = LiteGraph.createNode(UNBUNDLE);
    if (!graph || !getter) return;
    getter.pos = [setter.pos[0] + setter.size[0] + 40, setter.pos[1]];
    graph.add(getter);
    const w = nameWidget(getter);
    if (w) w.value = constantOf(setter);
    setMode(getter, true);
    app.canvas?.selectNode?.(getter, false);
    app.canvas?.setDirty?.(true, true);
}

/**
 * Wire one Bundle ("set") or Unbundle ("get"). Runs in the constructor,
 * before the bundle sync; the switch itself is in the ⚙ dialog.
 */
function setup(node, kind) {
    node.__obvpmConstKind = kind;
    node.properties ??= {};
    // Folded, a node that sets/gets shows its title ("Set name"), as a
    // collapsed KJNodes Set/Get does; otherwise the bar stays blank.
    Object.defineProperty(node, "__obvpmFoldTitle", {
        configurable: true, get: () => constantOn(node),
    });
    node.__obvpmMinWidth = () => minWidth(node);

    if (kind === "get") {
        asCombo(node, GET_W,
                () => visibleSetterNames(node.graph, carriesBundle),
                () => {
                    if (!app.configuringGraph) refreshGetter(node);
                });
    } else {
        const w = nameWidget(node);
        const callback = w?.callback;
        if (w) {
            w.callback = function (...args) {
                const r = callback?.apply(this, args);
                if (!node.graph || app.configuringGraph
                        || !constantOn(node)) return r;
                uniquify(node, node.graph);
                const now = constantOf(node);
                renameGetters(node.graph, node.properties[PREV_PROP], now);
                node.properties[PREV_PROP] = now;
                retitle(node);
                sync(node);
                refreshGettersNamed(node.graph, now);
                return r;
            };
        }
    }
    dropWidgetSockets(node, [kind === "get" ? GET_W : SET_W]);
    showNameWidget(node, false);

    const onAdded = node.onAdded;
    node.onAdded = function () {
        this.__obvpmJustAdded = true;
        return onAdded?.apply(this, arguments);
    };
    const onConfigure = node.onConfigure;
    node.onConfigure = function () {
        const r = onConfigure?.apply(this, arguments);
        // A save with the option on comes back with it on; one from
        // before the option existed has no such property, so it is off
        // and nothing about the node changes.
        applyMode(this);
        const pasted = this.__obvpmJustAdded && this.graph
            && !app.configuringGraph;
        if (pasted && isOurSetter(this)) {
            // Pasted, not loaded: the copy must not share its name.
            const old = constantOf(this);
            if (uniquify(this, this.graph, true)) {
                pasteRenames.set(old, constantOf(this));
                setTimeout(() => pasteRenames.delete(old), 0);
                retitle(this);
            }
        }
        if (pasted && isOurGetter(this)) {
            const w = nameWidget(this);
            const renamed = w ? pasteRenames.get(String(w.value ?? "")) : null;
            if (renamed) w.value = renamed;
            setTimeout(() => refreshGetter(this), 0);
        }
        this.__obvpmJustAdded = false;
        if (kind === "set") this.properties[PREV_PROP] = constantOf(this);
        return r;
    };

    if (kind === "set") {
        // New fields change what its getters unpack.
        const onConnectionsChange = node.onConnectionsChange;
        node.onConnectionsChange = function () {
            const r = onConnectionsChange?.apply(this, arguments);
            if (!app.configuringGraph && isOurSetter(this)) {
                setTimeout(() => refreshGettersNamed(this.graph,
                                                     constantOf(this)), 0);
            }
            return r;
        };
        const onRemoved = node.onRemoved;
        node.onRemoved = function () {
            const r = onRemoved?.apply(this, arguments);
            const graph = this.graph;
            const was = constantOf(this);
            if (graph && was) {
                setTimeout(() => {
                    for (const g of gettersNamed(graph, was)) refreshGetter(g);
                }, 0);
            }
            return r;
        };
    }

    const menu = node.getExtraMenuOptions;
    node.getExtraMenuOptions = function (_, options) {
        const r = menu?.apply(this, arguments);
        const add = [];
        if (isOurSetter(this)) {
            add.push({
                content: "Add Unbundle (get)",
                callback: () => addPairedGetter(this),
            });
            const getters = gettersNamed(this.graph, constantOf(this));
            if (getters.length) {
                add.push({
                    content: "Getters",
                    has_submenu: true,
                    submenu: {
                        title: "Getters",
                        options: getters.map((g) => ({
                            content: `${g.title} (id ${g.id})`,
                            callback: () => showNode(g),
                        })),
                    },
                });
            }
        }
        if (isOurGetter(this)) {
            const hit = findConstantSetter(this.graph, constantOf(this));
            if (hit) {
                add.push({
                    content: "Go to setter",
                    callback: () => showNode(hit.node),
                });
            }
        }
        if (add.length) options?.unshift(...add, null);
        return r;
    };
}

// ---------------------------------------------------------------------
// The prompt: fill each getting Unbundle's `in`
// ---------------------------------------------------------------------

/**
 * Where a link's value really comes from, as a prompt reference
 * [execution id, output slot] -- or null if nothing reaches it.
 *
 * `frame` is { graph, path, parent }: the graph being walked, the
 * subgraph-instance ids leading to it (execution ids are those joined
 * with ':'), and the frame it was entered from. Mirrors the frontend's
 * own resolver (ExecutableNodeDTO) for the cases a bundle can take:
 * subgraph boundaries both ways, muted and bypassed nodes, and virtual
 * nodes (KJ's Get, reroute nodes) through their own resolution hooks.
 */
function resolveLink(frame, linkId, seen) {
    const link = linkOf(frame.graph, linkId);
    if (!link) return null;
    // Handed in from the parent graph: continue at the instance's input.
    const boundary = frame.graph.inputNode;
    if (boundary && link.origin_id === boundary.id) {
        const parent = frame.parent;
        const instanceId = frame.path[frame.path.length - 1];
        const instance = parent?.graph.getNodeById?.(instanceId);
        return instance
            ? resolveInput(instance, link.origin_slot, parent, seen) : null;
    }
    const origin = frame.graph.getNodeById?.(link.origin_id);
    const type = frame.graph.getNodeById?.(link.target_id)
        ?.inputs?.[link.target_slot]?.type ?? link.type;
    return resolveOutput(origin, link.origin_slot, frame, seen, type);
}

function resolveInput(node, slot, frame, seen) {
    const linkId = node?.inputs?.[slot]?.link;
    return linkId == null ? null : resolveLink(frame, linkId, seen);
}

/** The frame (of `frame` and those above it) whose graph holds `node`. */
function frameOf(node, frame) {
    for (let f = frame; f; f = f.parent) {
        if (f.graph === node?.graph) return f;
    }
    return null;
}

function bypassSlot(node, slot, type) {
    const inputs = node.inputs ?? [];
    const outType = node.outputs?.[slot]?.type;
    const ok = (a, b) => typeof LiteGraph?.isValidConnection === "function"
        ? LiteGraph.isValidConnection(a, b)
        : (a === b || a === "*" || b === "*");
    if (type === "*" || type === "" || type == null) {
        return inputs.length > slot ? slot : 0;
    }
    const same = inputs[slot];
    if (same && ok(same.type, outType) && ok(same.type, type)) return slot;
    const exact = inputs.findIndex((i) => i.type === type);
    if (exact !== -1) return exact;
    return inputs.findIndex((i) => ok(i.type, outType) && ok(i.type, type));
}

function resolveOutput(node, slot, frame, seen, type) {
    if (!node || !frame) return null;
    const key = `${frame.path.join(":")}|${node.id}|${slot}`;
    if (seen.has(key) || seen.size > 256) return null;
    seen.add(key);

    if (node.mode === MODE_NEVER) return null;
    if (node.mode === MODE_BYPASS) {
        const i = bypassSlot(node, slot, type);
        return i < 0 ? null : resolveInput(node, i, frame, seen);
    }
    if (node.isSubgraphNode?.() && node.subgraph) {
        const sub = node.subgraph;
        const inner = { graph: sub, path: [...frame.path, node.id], parent: frame };
        const out = sub.outputNode;
        const link = out ? linksOf(sub).find(
            (l) => l.target_id === out.id && l.target_slot === slot) : null;
        return link ? resolveLink(inner, link.id, seen) : null;
    }
    if (node.isVirtualNode) {
        const v = node.resolveVirtualOutput?.(slot);
        if (v?.node) {
            return resolveOutput(v.node, v.slot, frameOf(v.node, frame),
                                 seen, type);
        }
        const vlink = node.getInputLink?.(slot);
        if (!vlink) return null;
        return vlink.id != null && linkOf(frame.graph, vlink.id)
            ? resolveLink(frame, vlink.id, seen)
            : resolveOutput(frame.graph.getNodeById?.(vlink.origin_id),
                            vlink.origin_slot, frame, seen, type);
    }
    return [[...frame.path, node.id].join(":"), slot];
}

/** The prompt reference a getter's constant stands for, or null. */
function sourceForGetter(getter, frame) {
    const name = constantOf(getter);
    if (!name) return null;
    for (let f = frame; f; f = f.parent) {
        const setter = nodesOf(f.graph).find(
            (n) => isConstantSetter(n) && constantOf(n) === name);
        if (!setter) continue;
        if (isOurSetter(setter)) {
            return resolveOutput(setter, 0, f, new Set(), BUNDLE_TYPE);
        }
        return resolveInput(setter, 0, f, new Set());
    }
    return null;
}

export function fillConstants(output, root) {
    if (!output || !root) return;
    const walk = (frame, depth) => {
        if (depth > 16) return;
        for (const node of nodesOf(frame.graph)) {
            if (node.type === BUNDLE || node.type === UNBUNDLE) {
                const id = [...frame.path, node.id].join(":");
                const entry = output[id];
                // A name with its option off means nothing: send none,
                // so the server's messages never mention a stale one.
                if (entry?.inputs && !constantOn(node)) {
                    entry.inputs[node.type === BUNDLE ? SET_W : GET_W] = "";
                }
            }
            if (isOurGetter(node)) {
                const id = [...frame.path, node.id].join(":");
                const entry = output[id];
                if (entry && entry.inputs && entry.inputs.in == null) {
                    const ref = sourceForGetter(node, frame);
                    // Only a node that made it into the prompt can feed
                    // it; anything else leaves `in` out, which the node
                    // then explains by name.
                    if (ref && output[ref[0]]) entry.inputs.in = ref;
                }
            }
            if (node.subgraph && node.isSubgraphNode?.()
                    && node.mode !== MODE_NEVER && node.mode !== MODE_BYPASS) {
                walk({ graph: node.subgraph, path: [...frame.path, node.id],
                       parent: frame }, depth + 1);
            }
        }
    };
    walk({ graph: root, path: [], parent: null }, 0);
}

// ---------------------------------------------------------------------
// KJNodes interop
// ---------------------------------------------------------------------

/**
 * Teach KJNodes' Get and Set about our setting Bundles. Wrapped on their
 * prototypes (and one per-instance hook for the dropdown, whose option
 * list KJ builds in the constructor); each wrapper steps aside unless
 * the nearest setter of the name is ours, so KJ-only graphs behave
 * exactly as before.
 */
function patchKJ() {
    const GetNode = LiteGraph.registered_node_types?.[KJ_GET];
    const SetNode = LiteGraph.registered_node_types?.[KJ_SET];
    if (GetNode && !GetNode.prototype.__obvpmConstants) {
        const p = GetNode.prototype;
        p.__obvpmConstants = true;
        const ours = (node) => {
            const hit = findConstantSetter(node.graph, constantOf(node));
            return isOurSetter(hit?.node) ? hit.node : null;
        };

        const resolveVirtualOutput = p.resolveVirtualOutput;
        p.resolveVirtualOutput = function (slot) {
            const setter = ours(this);
            if (setter) return { node: setter, slot: 0 };
            return resolveVirtualOutput?.apply(this, arguments);
        };
        const getInputLink = p.getInputLink;
        p.getInputLink = function () {
            // Resolved above; without this KJ would alert "No SetNode".
            if (ours(this)) return null;
            return getInputLink?.apply(this, arguments);
        };
        const findSetter = p.findSetter;
        p.findSetter = function (graph) {
            const found = findSetter?.apply(this, arguments);
            if (found) return found;
            const hit = findConstantSetter(graph ?? this.graph,
                                           constantOf(this), isOurSetter);
            return hit?.node;
        };
        const onRename = p.onRename;
        p.onRename = function () {
            if (ours(this)) {
                this.setType?.(BUNDLE_TYPE);
                this.title = kjTitle("Get", constantOf(this));
                app.canvas?.setDirty?.(true, true);
                return;
            }
            return onRename?.apply(this, arguments);
        };
        const onAdded = p.onAdded;
        p.onAdded = function () {
            const r = onAdded?.apply(this, arguments);
            extendKJChoices(this);
            return r;
        };
    }
    if (SetNode && !SetNode.prototype.__obvpmConstants) {
        const p = SetNode.prototype;
        p.__obvpmConstants = true;
        const validateName = p.validateName;
        p.validateName = function (graph, sameGraphOnly) {
            const changed = validateName?.apply(this, arguments);
            // KJ only counts its own Set nodes; ours share the namespace.
            if (uniquify(this, graph, sameGraphOnly)) {
                this.title = kjTitle("Set", constantOf(this));
                return true;
            }
            return changed;
        };
        const update = p.update;
        p.update = function () {
            const r = update?.apply(this, arguments);
            const name = constantOf(this);
            const prev = String(this.properties?.previousName ?? "");
            if (this.graph) {
                // KJ renames its own Gets; ours follow here.
                if (prev && name && prev !== name) {
                    for (const g of gettersNamed(this.graph, prev)) {
                        if (!isOurGetter(g)) continue;
                        const w = nameWidget(g);
                        if (w) w.value = name;
                        refreshGetter(g);
                    }
                }
                for (const g of gettersNamed(this.graph, name)) {
                    if (isOurGetter(g)) refreshGetter(g);
                }
            }
            return r;
        };
    }
}

/**
 * Add our setters' names to a KJ Get's dropdown. KJ builds the option
 * list as a getter on an object in its constructor; that object is
 * wrapped here, so KJ's own copies of it (its Nodes 2.0 refresh copies
 * the descriptor) carry our names too.
 */
function extendKJChoices(getNode) {
    const w = getNode.widgets?.[0];
    const opts = w?.options;
    if (!opts || opts.__obvpmConstants) return;
    const desc = Object.getOwnPropertyDescriptor(opts, "values");
    if (!desc?.get) return;
    Object.defineProperty(opts, "values", {
        configurable: true, enumerable: true,
        get() {
            const kj = desc.get.call(this) ?? [];
            if (!getNode.graph) return kj;
            // KJ narrows its list to the type the Get feeds; ours only
            // ever carry bundles.
            let wanted = null;
            const linkId = getNode.outputs?.[0]?.links?.[0];
            const link = linkOf(getNode.graph, linkId);
            if (link) {
                wanted = getNode.graph.getNodeById?.(link.target_id)
                    ?.inputs?.[link.target_slot]?.type ?? null;
            }
            if (wanted && wanted !== "*"
                    && !String(wanted).split(",").includes(BUNDLE_TYPE)) {
                return kj;
            }
            const mine = visibleSetterNames(getNode.graph, isOurSetter);
            return [...new Set([...kj, ...mine])].sort(
                (a, b) => a.localeCompare(b));
        },
    });
    Object.defineProperty(opts, "__obvpmConstants", { value: true });
}

// ---------------------------------------------------------------------

app.registerExtension({
    name: "obvpm.constants",
    nodeCreated(node) {
        // Runs inside the node's constructor, before onNodeCreated -- so
        // before the bundle sync, which then sees the finished widgets.
        // `node.type` is not set yet at this point (createNode assigns it
        // after construction); the class name is. Every Bundle and
        // Unbundle is set up -- with its option off it is exactly the
        // node it always was.
        const cls = node.comfyClass ?? node.constructor?.comfyClass ?? node.type;
        if (cls === BUNDLE) setup(node, "set");
        else if (cls === UNBUNDLE) setup(node, "get");
    },
    setup() {
        patchKJ();
        const graphToPrompt = app.graphToPrompt;
        app.graphToPrompt = async function (...args) {
            const result = await graphToPrompt.apply(this, args);
            try {
                const root = args[0]?.serialize ? args[0]
                    : (app.rootGraph ?? app.graph);
                fillConstants(result?.output, rootOf(root));
            } catch (err) {
                console.error("[obvpm-constants] could not fill Get & "
                              + "Unbundle inputs:", err);
            }
            return result;
        };
    },
});
