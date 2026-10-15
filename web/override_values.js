// Override Bundle Values: the rows, the config dialog, and the
// "overridden" mark on the Value Presets node upstream.
//
// WHAT THE NODE SHOWS. Each field chosen in the config dialog (the gear)
// gets a toggle -- off, the bundle's own value passes; on, the value row
// under it replaces it. The value row is the very widget a Value Presets
// node draws for that field (fieldWidget, value_presets.js), so it has
// the preset's range, decimals, choices and tooltip. A field no widget
// can hold (an image, a model, a latent) gets an input SOCKET instead:
// wired, it replaces the field; unwired, the bundle's own value passes.
//
// WHERE THE FIELDS COME FROM. The bundle wire is traced upstream the way
// Unbundle traces it (bundleSourceFor / packerOf: through subgraphs, KJ
// Set/Get, get-by-name). A Value Presets source is described by the
// server from its schema (describe); a Bundle source's field types are
// read from what is wired into each of its inputs.
//
// STORED BY NAME, like Value Presets: the rows are built here and their
// state mirrored into the hidden `state` JSON (fields chosen, which are
// on, their values), the socket names into `wires`. Nothing the rows
// hold is positional, and none of their widgets is serialized.
//
// THE MARK. A Value Presets field overridden downstream says so on its
// label: "overridden" -- and the widget is disabled -- when every path
// from the preset node to a consumer passes an override of that field;
// "overridden in n of m" when only some do (a Set/Get pair can hand one
// bundle to several consumers, and disabling the field would be wrong
// for the ones that still read it).

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { widget, bundleSourceFor, packerOf, syncSockets, hideWidget,
         originOf, linkById, notifyVue, switchInputs, staticInput } from "./obvpm_dynamic.js";
import { describe, fieldWidget, isModelField, presetsListeners, recheckMissingModels }
    from "./value_presets.js";
import { typeIdOf, userFilters } from "./value_presets_user.js";
import { addConfigButton } from "./obvpm_bundle_config.js";
import { el, TEXT, TITLE, DIM, pushButton, openOverlay } from "./obvpm_ui.js";
import { constantOf, constantOn, isOurGetter, isOurSetter, isUnbundle, setMode }
    from "./obvpm_constants.js";

const NODE = "OverrideBundleValues (obvpm)";
const PRESETS_NODE = "ValuePresets (obvpm)";
const STATE = "state";
const WIRES = "wires";
const IN = "bundle";
const WIRE = "wire_";
const MAX_WIRES = 16;           // mirrors overrides.py MAX_WIRES
const ROW = "__obvpmOverrideRow";
const SET_W = "set";            // the declared name widget (hidden)
const CONST_ROW = "set_constant";
const VALUE_PREFIX = "↳ ";
const GEAR_TRIM = 12;           // px of default bottom padding under the gear row
const KNOWN = "obvpm_override_known";
const MARK_SUFFIX = /  ⤳ overridden.*$/;
const PRESETS_FIELD = "__obvpmField";      // value_presets.js MARK
const PRESETS_ROW = "obvpm_presets_bar";   // value_presets.js ROW_NAME

// output types a widget can hold, and the field kind each becomes
const WIDGET_TYPES = { INT: "int", FLOAT: "float", STRING: "text", BOOLEAN: "bool" };
// nodes that only carry a bundle along: the mark's path walk goes
// through them
const CARRIERS = /^(Reroute|LazySwitch\d? \(obvpm\)|LazyCaseSwitch(Auto)? \(obvpm\))$/;

// ---------------------------------------------------------------------
// state
// ---------------------------------------------------------------------

function readState(node) {
    let st;
    try {
        st = JSON.parse(widget(node, STATE)?.value || "{}");
    } catch (err) {
        st = {};
    }
    if (!st || typeof st !== "object" || Array.isArray(st)) st = {};
    return {
        fields: Array.isArray(st.fields) ? st.fields.filter((f) => typeof f === "string") : [],
        on: Array.isArray(st.on) ? st.on.filter((f) => typeof f === "string") : [],
        values: st.values && typeof st.values === "object" && !Array.isArray(st.values)
            ? st.values : {},
    };
}

function writeState(node, st) {
    const w = widget(node, STATE);
    if (w) w.value = JSON.stringify(st);
}

function isLoading(node) {
    return app.configuringGraph || !!node.__obvpmOvConfiguring;
}

// ---------------------------------------------------------------------
// where the fields come from
// ---------------------------------------------------------------------

function presetValues(presetsNode) {
    try {
        const v = JSON.parse(widget(presetsNode, "values")?.value || "{}");
        return v && typeof v === "object" ? v : {};
    } catch (err) {
        return {};
    }
}

/** A Bundle input's field, typed from what is wired into it. */
function fieldFromWire(bundleNode, name, index) {
    const slot = (bundleNode.inputs ?? []).find((s) => s.name === `in_${index + 1}`);
    const origin = slot ? originOf(bundleNode, slot) : null;
    const out = origin?.node?.outputs?.[origin.slot];
    const type = String(out?.type ?? "*");
    if (WIDGET_TYPES[type]) return { name, kind: WIDGET_TYPES[type] };
    if (type === "COMBO") {
        // the dropdown's own list, when the wire comes from a widget
        const w = (origin.node.widgets ?? []).find(
            (x) => x.name === out.name || x.name === out.label)
            ?? (origin.node.widgets ?? []).find((x) => x.type === "combo");
        let values = w?.options?.values;
        if (typeof values === "function") {
            try { values = values(); } catch (err) { values = null; }
        }
        if (Array.isArray(values) && values.length) {
            return { name, kind: "choice", choices: values.map(String) };
        }
    }
    return { name, wire: true, type };
}

/**
 * The nodes a bundle wire can come from: one, or -- through the switches
 * and reroutes that only carry a bundle -- one per branch that can run.
 * A switch whose choice is settled before the run (its boolean or case
 * traced to a widget, a preset value, or a node output that says what it
 * will be: switchInputs) counts only the branch it will pick; otherwise
 * every branch. Each is {node, via} where `via` is the node and input the
 * trace asked (for packerOf). Null when any branch cannot be traced.
 */
function leavesOf(node, slotName, depth = 0) {
    if (depth > 8) return null;
    const src = bundleSourceFor(node, slotName);
    if (!src?.node) return null;
    // another override (wired, or read by its constant): its fields are
    // those of the bundle it overrides
    if (src.node.type === NODE) return leavesOf(src.node, IN, depth + 1);
    if (!CARRIERS.test(src.node.type)) return [{ node: src.node, via: [node, slotName] }];
    // a switch: the branches that can feed this output (a switch's
    // boolean or case list is not one); a reroute: its bundle input
    const names = switchInputs(src.node, src.slot);
    const inputs = (src.node.inputs ?? []).filter((i) => i.link != null && (names
        ? names.includes(i.name)
        : (i.type === "*" || i.type === "OBVPM_BUNDLE")));
    if (!inputs.length) return null;
    const out = [];
    for (const i of inputs) {
        const more = leavesOf(src.node, i.name, depth + 1);
        if (!more) return null;
        out.push(...more);
    }
    return out;
}

/** One leaf's fields: {kind, presets, values, fields, error, schema}. */
async function leafFields(leaf) {
    if (leaf.node.type === PRESETS_NODE) {
        const schema = String(widget(leaf.node, "schema")?.value ?? "");
        const answer = await describe(schema);
        return {
            kind: "presets", presets: [leaf.node], schema,
            values: presetValues(leaf.node),
            fields: answer.fields ?? [], error: answer.error ?? null,
        };
    }
    const packer = packerOf(...leaf.via);
    if (!packer) return null;
    return {
        kind: "bundle", values: {},
        fields: packer.names.map((name, i) => fieldFromWire(packer.node, name, i)),
    };
}

/** The values every one of the given Value Presets nodes agrees on. */
function agreedValues(presetsNodes) {
    const all = presetsNodes.map(presetValues);
    const out = {};
    for (const [name, value] of Object.entries(all[0] ?? {})) {
        const text = JSON.stringify(value);
        if (all.every((v) => name in v && JSON.stringify(v[name]) === text)) {
            out[name] = value;
        }
    }
    return out;
}

/**
 * The incoming bundle's fields: {kind: "presets"|"bundle", fields,
 * presets (the Value Presets nodes it can come from), values (the
 * values they all hold)}, or null when the wire cannot be traced.
 *
 * Through a switch, the fields are those EVERY branch carries -- the
 * ones an override is sure to find whichever branch wins (typically two
 * Value Presets nodes of one schema, e.g. generation and upscale engine
 * settings). It stays a "presets" source when every branch is one.
 */
async function traceSource(node) {
    const leaves = leavesOf(node, IN);
    if (!leaves?.length) return null;
    const parts = await Promise.all(leaves.map(leafFields));
    if (parts.some((p) => !p)) return null;
    if (parts.length === 1) return parts[0];
    const first = parts[0];
    const common = first.fields.filter((f) =>
        parts.every((p) => p.fields.some((g) => g.name === f.name)));
    const presets = parts.every((p) => p.kind === "presets");
    return {
        kind: presets ? "presets" : "bundle",
        presets: presets ? parts.flatMap((p) => p.presets) : [],
        values: presets ? agreedValues(parts.flatMap((p) => p.presets)) : {},
        fields: common,
        error: parts.find((p) => p.error)?.error ?? null,
    };
}

/**
 * The user's dropdown filter for a field, as on the Value Presets nodes
 * the bundle comes from: their Preset Type Id's filters, when they all
 * go by one id (read live: the source is traced again on every build).
 */
function sourceFilter(node, name) {
    const from = node.__obvpmOvSource?.presets ?? [];
    const ids = new Set(from.map(typeIdOf));
    if (ids.size !== 1) return undefined;
    const [id] = ids;
    return id ? userFilters(id)[name] : undefined;
}

/** Remember the traced kinds (not the choice lists), for a load before
 *  the source can be traced. */
function remember(node, source) {
    if (!source) return;
    node.properties ??= {};
    const known = {};
    for (const f of source.fields) {
        known[f.name] = f.wire ? { name: f.name, wire: true, type: f.type }
            : { name: f.name, kind: f.choices ? "text" : f.kind,
                lo: f.lo ?? null, hi: f.hi ?? null, decimals: f.decimals ?? null };
    }
    node.properties[KNOWN] = known;
}

// ---------------------------------------------------------------------
// the rows
// ---------------------------------------------------------------------

function show(w, on) {
    if (!w) return;
    w.hidden = !on;
    (w.options ??= {}).hidden = !on;
}

function short(value) {
    const text = typeof value === "boolean" ? (value ? "true" : "false")
        : String(value ?? "");
    return text.split(/[\\/]/).pop();
}

/** `text` cut (with …) to fit `room` px in the context's font. */
function fitText(ctx, text, room) {
    if (ctx.measureText(text).width <= room) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (ctx.measureText(text.slice(0, mid) + "…").width <= room) lo = mid;
        else hi = mid - 1;
    }
    return lo ? text.slice(0, lo) + "…" : "…";
}

/**
 * The classic toggle draws its value right-aligned, whole: the "bundle:
 * <value>" text is cut to the room the label leaves, at draw time, so a
 * wide node shows more of it. (Nodes 2.0 draws the two halves itself and
 * truncates each with CSS.)
 */
function fitToggleText(toggle) {
    const drawLabel = toggle.drawLabel;
    const drawValue = toggle.drawValue;
    if (typeof drawLabel !== "function" || typeof drawValue !== "function") return;
    toggle.drawLabel = function (ctx, x) {
        const name = this.displayName ?? this.label ?? this.name ?? "";
        this.__obvpmLabelEnd = x + ctx.measureText(String(name)).width;
        return drawLabel.call(this, ctx, x);
    };
    toggle.drawValue = function (ctx, x) {
        const key = this.value ? "on" : "off";
        const full = this.options?.[key];
        if (!full || this.__obvpmLabelEnd == null) return drawValue.call(this, ctx, x);
        const room = x - this.__obvpmLabelEnd - 12;
        this.options[key] = fitText(ctx, String(full), Math.max(room, 0));
        try {
            return drawValue.call(this, ctx, x);
        } finally {
            this.options[key] = full;
        }
    };
}

function offLabel(source, name) {
    if (source?.kind === "presets" && name in (source.values ?? {})) {
        return "bundle: " + short(source.values[name]);
    }
    return "from bundle";
}

function clearRows(node) {
    const keep = [];
    for (const w of node.widgets ?? []) {
        if (w[ROW]) w.onRemove?.();
        else keep.push(w);
    }
    node.widgets = keep;
}

function fitHeight(node) {
    if (typeof node.computeSize !== "function" || !node.size) return;
    node.setSize?.([node.size[0], node.computeSize()[1]]);
    node.setDirtyCanvas?.(true, true);
}

/** The node's rows and sockets for the chosen fields. */
function buildRows(node, source, { fit } = {}) {
    // addWidget grows the node to fit each widget as it is added -- the
    // value rows too, which are hidden right after. A loaded node keeps
    // the size it was saved with (grown only if its rows need more), so
    // the size from before the build is put back below.
    const before = node.size ? [node.size[0], node.size[1]] : null;
    clearRows(node);
    const st = readState(node);
    const traced = Object.fromEntries((source?.fields ?? []).map((f) => [f.name, f]));
    const known = node.properties?.[KNOWN] ?? {};
    node.__obvpmFieldMap = Object.create(null);   // fieldWidget's combo lists
    node.__obvpmOvSource = source;
    const wires = [];
    const wireTypes = [];
    for (const name of st.fields) {
        const field = traced[name] ?? known[name];
        if (!field) continue;                 // not in the bundle (the dialog says so)
        if (field.wire) {
            wires.push(name);
            wireTypes.push(field.type ?? "*");
            continue;
        }
        const on = st.on.includes(name);
        const toggle = node.addWidget("toggle", name, on,
            (v) => setOn(node, name, !!v),
            { on: "override", off: offLabel(source, name) });
        toggle.value = on;                    // through to the surviving state
        toggle.serialize = false;
        toggle[ROW] = true;
        fitToggleText(toggle);
        toggle.tooltip = field.hint
            ? "Override " + name + ". " + field.hint
            : "Override the bundle's " + name + ": on, the value under it "
              + "replaces it; off, the bundle's own value passes.";

        const held = Object.prototype.hasOwnProperty.call(st.values, name)
            ? st.values[name]
            : (source?.values && name in source.values ? source.values[name]
                                                      : field.default);
        st.values[name] = held;
        const valueName = VALUE_PREFIX + name;
        node.__obvpmFieldMap[valueName] = { ...field, name: valueName };
        const w = fieldWidget(node, { ...field, name: valueName }, held,
                              (_n, v) => setValue(node, name, v),
                              { filterOf: () => sourceFilter(node, name) });
        w[ROW] = true;
        show(w, on);
    }
    placeLastRows(node);
    writeState(node, st);
    widget(node, WIRES).value = wires.join("\n");
    syncSockets(node, "inputs", WIRE, wires, MAX_WIRES);
    (node.inputs ?? []).forEach((slot) => {
        const n = Number(/^wire_(\d+)$/.exec(slot.name)?.[1]);
        if (n > 0 && wireTypes[n - 1]) slot.type = wireTypes[n - 1];
    });
    notifyVue(node);
    if (fit) {
        fitHeight(node);
    } else if (before && typeof node.computeSize === "function") {
        node.setSize?.([before[0], Math.max(before[1], node.computeSize()[1])]);
    }
    node.setDirtyCanvas?.(true, true);
}

/** Under the fields: set_constant (while on), then the gear, last. */
function placeLastRows(node) {
    for (const name of [CONST_ROW, "obvpm_cfg"]) {
        const at = (node.widgets ?? []).findIndex((w) => w.name === name);
        if (at >= 0) node.widgets.push(node.widgets.splice(at, 1)[0]);
    }
}

// ---------------------------------------------------------------------
// set to constant
// ---------------------------------------------------------------------

// As on a Value Presets node: while "set to constant" is on (the config
// dialog), the last field, just above the gear, is `set_constant` -- the
// name an Unbundle with "get" or a KJNodes Get reads this node's bundle
// by. It is not the declared `set` widget: that one stays hidden where
// widgets_values expects it, and this field (never serialized) writes
// through to it, which runs the setter's rename handling
// (obvpm_constants.js asks this node to show the name its own way).

function showConstantRow(node, show) {
    const real = widget(node, SET_W);
    let row = widget(node, CONST_ROW);
    if (!show || !real) {
        if (row) {
            row.onRemove?.();
            node.widgets.splice(node.widgets.indexOf(row), 1);
        }
    } else {
        if (!row) {
            row = node.addWidget("string", CONST_ROW, String(real.value ?? ""), (v) => {
                real.value = String(v ?? "").trim();
                real.callback?.(real.value);
                // the setter may have made it unique (name_0, ...)
                if (row.value !== real.value) row.value = real.value;
            });
            row.serialize = false;
            row.tooltip = "The name an Unbundle with 'get' or a KJNodes Get "
                + "reads this bundle by. Turn it off in the config dialog.";
        }
        row.value = String(real.value ?? "");     // through to the surviving state
    }
    placeLastRows(node);
    if (!isLoading(node)) fitHeight(node);
    notifyVue(node);
    node.setDirtyCanvas?.(true, true);
}

/** A starting name for the constant, from the node's title. */
function constantNameFrom(node) {
    const slug = String(node.title ?? "").replace(/\s*\(obvpm\)\s*$/i, "").toLowerCase()
        .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return slug || "override";
}

function setOn(node, name, on) {
    const st = readState(node);
    st.on = st.on.filter((f) => f !== name);
    if (on) st.on.push(name);
    writeState(node, st);
    const w = widget(node, VALUE_PREFIX + name);
    show(w, on);
    if (!isLoading(node)) fitHeight(node);
    scheduleMarks();
    // the value under a switched override came or went: ComfyUI's
    // missing-model check looks at it only while shown (value_presets.js)
    if (isModelField(w)) recheckMissingModels();
}

function setValue(node, name, value) {
    const st = readState(node);
    st.values[name] = value;
    writeState(node, st);
}

/** Trace, then build. Coalesced: one trace in the air per node. */
async function rebuild(node, { fit } = {}) {
    if (node.__obvpmOvRemoved) return;
    if (node.__obvpmOvBuilding) {
        node.__obvpmOvAgain = { fit: fit || node.__obvpmOvAgain?.fit };
        return;
    }
    node.__obvpmOvBuilding = true;
    let source = null;
    try {
        source = await traceSource(node);
    } catch (err) {
        console.error("[obvpm-override] could not trace the bundle:", err);
    } finally {
        node.__obvpmOvBuilding = false;
    }
    if (node.__obvpmOvRemoved) return;
    node.__obvpmOvLeaves = leafKey(node);
    remember(node, source);
    buildRows(node, source, { fit });
    const again = node.__obvpmOvAgain;
    node.__obvpmOvAgain = null;
    if (again) return rebuild(node, again);
    scheduleMarks();
}

// ---------------------------------------------------------------------
// the config dialog
// ---------------------------------------------------------------------

function typeText(field) {
    if (!field) return "not in the bundle";
    if (field.wire) return (field.type && field.type !== "*" ? field.type : "any")
        + " · a socket";
    if (field.choices) return "choice";
    if (field.kind === "int" || field.kind === "float") {
        const span = field.lo != null || field.hi != null
            ? " " + (field.lo ?? "") + ".." + (field.hi ?? "") : "";
        return field.kind + span;
    }
    return field.kind ?? "";
}

function wiredFields(node) {
    const names = String(widget(node, WIRES)?.value ?? "").split("\n");
    const out = new Set();
    for (const slot of node.inputs ?? []) {
        const n = Number(/^wire_(\d+)$/.exec(slot.name)?.[1]);
        if (n > 0 && slot.link != null && names[n - 1]) out.add(names[n - 1]);
    }
    return out;
}

async function openConfig(node) {
    const source = await traceSource(node);
    const st = readState(node);
    const traced = source?.fields ?? [];
    const names = traced.map((f) => f.name);
    for (const name of st.fields) if (!names.includes(name)) names.push(name);
    const byName = Object.fromEntries(traced.map((f) => [f.name, f]));
    const chosen = new Set(st.fields);
    const wired = wiredFields(node);

    const { overlay, panel, close } = openOverlay("min(460px, 90vw)");
    panel.append(el("div", { font: TITLE }, "Override Bundle Values"));
    panel.append(el("div", { color: DIM, font: "12px sans-serif" },
        "Choose the fields that can be overridden. Each gets a toggle and a "
        + "value on the node; a field no widget can hold gets an input "
        + "socket instead."
        + (source?.kind === "presets"
            ? " The values follow the Value Presets schema." : "")));
    if (!names.length) {
        panel.append(el("div", { color: DIM }, source
            ? "The bundle has no fields."
            : "Connect a bundle first (from a Value Presets node, a Bundle "
              + "or a Get) -- there are no fields to choose yet."));
    }
    const list = el("div", {
        display: "flex", flexDirection: "column", gap: "2px",
        overflowY: "auto", maxHeight: "60vh", padding: "4px 2px",
    });
    panel.append(list);
    for (const name of names) {
        const field = byName[name];
        const row = el("label", { display: "flex", alignItems: "center",
                                  gap: "8px", font: TEXT, cursor: "pointer" });
        const check = el("input");
        check.type = "checkbox";
        check.checked = chosen.has(name);
        if (wired.has(name) && chosen.has(name)) {
            check.disabled = true;
            check.title = "Its socket has a connection -- unplug it first.";
        }
        check.addEventListener("change", () => {
            if (check.checked) chosen.add(name); else chosen.delete(name);
        });
        row.append(check,
            el("span", { flex: "1", color: field ? undefined : DIM }, name),
            el("span", { color: DIM, font: "12px sans-serif" }, typeText(field)));
        list.appendChild(row);
    }
    // Set to constant, as on a Value Presets node (config -> Set)
    const nameW = widget(node, SET_W);
    let constant = constantOn(node);
    const setBox = el("div", { display: "flex", flexDirection: "column", gap: "6px",
                               marginTop: "6px" });
    const setCheck = el("input");
    setCheck.type = "checkbox";
    setCheck.checked = constant;
    setCheck.disabled = !nameW;
    setCheck.addEventListener("change", () => { constant = setCheck.checked; });
    const setRow = el("label", { display: "flex", alignItems: "center", gap: "8px",
                                 font: TEXT, cursor: "pointer" });
    setRow.append(setCheck, el("span", { flex: "1" }, "set this bundle to a constant"));
    setBox.append(
        el("div", { font: "600 14px sans-serif" }, "Set to constant"),
        el("div", { color: DIM, font: "12px sans-serif" },
            nameW
                ? "On, this node's bundle (with the overrides) is a constant: an "
                  + "Unbundle with 'get' or a KJNodes Get reads it by NAME, without "
                  + "a wire. The name is the node's set_constant field, its last "
                  + "one; set or change it there."
                : "This node has no name field yet: restart ComfyUI after "
                  + "updating comfyui-obvpm (a node added before the update may "
                  + "need to be added again)."),
        setRow);
    panel.append(setBox);

    const bar = el("div", { display: "flex", justifyContent: "flex-end", gap: "8px" });
    bar.append(
        pushButton("Cancel", () => close()),
        pushButton("OK", () => {
            if (nameW && constant !== constantOn(node)) {
                // a name to start from; the node's field changes it, and
                // setMode makes it unique among the setters in scope
                if (constant && !String(nameW.value ?? "").trim()) {
                    nameW.value = constantNameFrom(node);
                }
                setMode(node, constant);
            }
            const next = readState(node);
            next.fields = names.filter((n) => chosen.has(n));
            next.on = next.on.filter((n) => chosen.has(n));
            for (const key of Object.keys(next.values)) {
                if (!chosen.has(key)) delete next.values[key];
            }
            writeState(node, next);
            close();
            void rebuild(node, { fit: true });
        }));
    panel.append(bar);
    document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------
// the mark on the Value Presets node
// ---------------------------------------------------------------------

function allGraphs() {
    const root = app.graph ?? app.rootGraph;
    const out = [];
    const seen = new Set();
    const walk = (g, level) => {
        if (!g || seen.has(g) || level > 8) return;
        seen.add(g);
        out.push(g);
        for (const n of g._nodes ?? g.nodes ?? []) {
            if (n.subgraph) walk(n.subgraph, level + 1);
        }
    };
    walk(root, 0);
    return out;
}

function nodesOf(graph) {
    return graph?._nodes ?? graph?.nodes ?? [];
}

function linksOf(graph) {
    const links = graph?.links;
    if (!links) return [];
    return typeof links.values === "function" ? [...links.values()] : Object.values(links);
}

/**
 * An output slot's link ids. Usually an array -- but a slot restored from
 * a saved workflow can hold them as {"0": id, ...} (the frontend's array
 * properties come back that way), which for...of cannot walk.
 */
function linkIds(slot) {
    const links = slot?.links;
    if (!links) return [];
    return Array.isArray(links) ? links : Object.values(links);
}

/**
 * A node that reads a constant by NAME, with no Get node: it says so with
 * `obvpmConstantRead()` (the constant's name, or "" while it reads none),
 * so a setter's value goes on to it as to a getter. The timeline pack's
 * result previews (`result_constant`) do.
 */
function readsConstant(node, key) {
    if (!key || typeof node?.obvpmConstantRead !== "function") return false;
    try {
        return String(node.obvpmConstantRead() ?? "") === key;
    } catch (err) {
        return false;
    }
}

/** A node ComfyUI never executes: no outputs at all, and not an output
 *  node (core runs only output nodes and what they need). */
function neverRuns(node) {
    if ((node.outputs ?? []).length) return false;
    const def = node.constructor?.nodeData;
    return !!def && !def.output_node;
}

function wrapperOf(sub) {
    const found = [];
    for (const g of allGraphs()) {
        for (const n of nodesOf(g)) if (n.subgraph === sub) found.push(n);
    }
    return found.length === 1 ? found[0] : null;
}

/** The fields an override node replaces right now. */
function activeFields(node) {
    const st = readState(node);
    const out = new Set(st.on.filter((f) => st.fields.includes(f)));
    for (const name of wiredFields(node)) out.add(name);
    return out;
}

/**
 * Every path from a Value Presets node's bundle to a node that reads it,
 * as the set of fields overridden along each path. Through subgraphs,
 * KJ Set/Get pairs and the switches that only carry a bundle; an
 * override node adds the fields it replaces and the walk goes on past
 * it (for the others).
 *
 * With `prune`, a switch whose choice is known before the run
 * (switchInputs) passes the bundle on only from the input it will pick;
 * a path that arrives on another input ends there, in `dead`; so does
 * one that reaches a node a Mute If gate will block (`blocked`, from
 * blockedNodes). And an Unbundle is followed on to whatever reads its
 * fields, since the preset is only used if one of THOSE runs. The marks
 * walk without it: a field is overridden whichever branch runs.
 */
function pathsFrom(presetsNode, { prune = false, blocked = null } = {}) {
    const ends = [];
    const dead = [];
    const byField = new Map();          // field -> override node titles
    const seen = new Set();
    const note = (node, fields) => {
        for (const f of fields) {
            if (!byField.has(f)) byField.set(f, new Set());
            byField.get(f).add(node.title || "Override Bundle Values");
        }
    };
    const fromOutput = (node, slot, acc, depth) => {
        const graph = node.graph;
        for (const id of linkIds(node.outputs?.[slot])) {
            const link = linkById(graph, id);
            if (link) visit(graph, link.target_id, link.target_slot, acc, depth + 1);
        }
    };
    // a setter's bundle goes on at every getter of its constant
    const toGetters = (setter, acc, depth) => {
        const key = constantOf(setter);
        if (!key) return;
        for (const g of allGraphs()) {
            for (const n of nodesOf(g)) {
                if (n === setter || constantOf(n) !== key) continue;
                if (n.type === "GetNode") fromOutput(n, 0, acc, depth + 1);
                else if (isOurGetter(n) || readsConstant(n, key)) {
                    if (prune) readOn(n, acc, depth + 1);
                    else ends.push(acc);
                }
            }
        }
    };
    // prune: an Unbundle's fields go on to their readers
    // prune: a reader passes the value on to ITS readers, to the end of
    // the chain -- the value is used only if some chain gets there with
    // no blocked node on the way (a reader that is not blocked itself
    // can still feed only nodes that are, like a sampler's denoise)
    const readOn = (node, acc, depth) => {
        if (blocked?.has(node)) return void dead.push(acc);
        let onward = false;
        (node.outputs ?? []).forEach((out, i) => {
            if (!linkIds(out).length) return;
            onward = true;
            fromOutput(node, i, acc, depth);
        });
        if (isOurSetter(node)) {
            onward = true;
            toGetters(node, acc, depth);
        }
        if (!onward) {
            // the end of a chain: used -- unless the node never runs. A
            // node with no outputs that is not an output node is never
            // executed (nothing asks for it), so a display-only reader
            // is no use of the preset
            if (neverRuns(node)) dead.push(acc);
            else ends.push(acc);
        }
    };
    const visit = (graph, id, slot, acc, depth) => {
        if (depth > 64) return;
        const key = `${graph.id ?? ""}:${id}:${slot}:${[...acc].sort().join(",")}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (graph.outputNode && id === graph.outputNode.id) {
            // out of a subgraph: on through the wrapper's output
            const wrapper = wrapperOf(graph);
            if (wrapper) fromOutput(wrapper, slot, acc, depth);
            return;
        }
        const node = graph.getNodeById?.(id);
        if (!node) return;
        // muted: it will not run, so nothing reads on -- and that is
        // evidence, as a blocked node is (Mute Group If mutes whole groups)
        if (node.mode === 2) return void dead.push(acc);
        if (node.type === NODE) {
            if (node.mode === 4) return fromOutput(node, 0, acc, depth);  // bypassed
            if (prune && blocked?.has(node)) return void dead.push(acc);
            const active = activeFields(node);
            note(node, active);
            const after = new Set([...acc, ...active]);
            fromOutput(node, 0, after, depth);
            if (isOurSetter(node)) toGetters(node, after, depth);
            return;
        }
        if (node.isSubgraphNode?.() && node.subgraph) {
            const sub = node.subgraph;
            for (const link of linksOf(sub)) {
                if (link.origin_id === sub.inputNode?.id && link.origin_slot === slot) {
                    visit(sub, link.target_id, link.target_slot, acc, depth + 1);
                }
            }
            return;
        }
        if (node.type === "SetNode") return toGetters(node, acc, depth);
        if (prune && isUnbundle(node)) return readOn(node, acc, depth);
        if (CARRIERS.test(node.type)) {
            const arrived = node.inputs?.[slot]?.name;
            let onward = false;
            (node.outputs ?? []).forEach((out, i) => {
                if (out.type !== "*" && out.type !== "OBVPM_BUNDLE") return;
                const names = prune ? switchInputs(node, i) : null;
                if (names && !names.includes(arrived)) return;   // not picked
                onward = true;
                fromOutput(node, i, acc, depth);
            });
            if (!onward) dead.push(acc);
            return;
        }
        if (prune) return readOn(node, acc, depth);
        ends.push(acc);                                 // a node that reads it
    };
    fromOutput(presetsNode, 0, new Set(), 0);
    // "set to constant" on the preset node itself: no wire, but the
    // getters of its constant read it all the same
    if (isOurSetter(presetsNode)) toGetters(presetsNode, new Set(), 0);
    return { ends, byField, dead };
}

// ---------------------------------------------------------------------
// "not used by the next run": the Value Presets node fades
// ---------------------------------------------------------------------
//
// A preset whose every path ends where the next run will not go is drawn
// faded, so the one in use stands out without panning to the switch:
// - at a switch that will pick another branch (its choice known before
//   the run: the timeline's upscale toggle choosing between generation
//   and upscale engine settings), or
// - at a node a Mute If gate will block (its `mute` known before the run:
//   the upscale group's gate while generating), or
// - at a muted node (a group Mute Group If has muted).
// Only with that evidence: a new node, an unwired one, or one behind a
// switch or gate decided at run time, is drawn as usual. Nothing is
// saved; the node still edits.

const INACTIVE_ATTR = "data-obvpm-inactive";
const FADE = 0.4;               // the node's opacity while not used
const GATE = "MuteGate (obvpm)";
const inactive = new Set();

/**
 * The nodes a Mute If gate will block in the next run: everything
 * downstream of a gate whose `mute` is known to be true (ExecutionBlocker
 * skips every node that receives it, and their outputs carry it on).
 * Through subgraphs, Set/Get pairs and set-to-constant setters; a switch
 * passes the block on only from the branch it will pick, and one whose
 * choice is not known before the run stops it (it may not arrive).
 */
function blockedNodes() {
    const out = new Set();
    const seen = new Set();
    const flow = (node, slot) => {
        const graph = node.graph;
        for (const id of linkIds(node.outputs?.[slot])) {
            const link = linkById(graph, id);
            if (link) reach(graph, link.target_id, link.target_slot);
        }
    };
    const flowAll = (node) => {
        (node.outputs ?? []).forEach((_o, i) => flow(node, i));
        if (isOurSetter(node) || node.type === "SetNode") {
            const key = constantOf(node);
            for (const g of allGraphs()) {
                for (const n of nodesOf(g)) {
                    if (n === node || !key || constantOf(n) !== key || out.has(n)) continue;
                    if (n.type === "GetNode" || isOurGetter(n)
                            || readsConstant(n, key)) {
                        out.add(n);
                        flowAll(n);
                    }
                }
            }
        }
    };
    const reach = (graph, id, slot) => {
        const key = `${graph.id ?? ""}:${id}:${slot}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (graph.outputNode && id === graph.outputNode.id) {
            const wrapper = wrapperOf(graph);
            if (wrapper) flow(wrapper, slot);
            return;
        }
        const node = graph.getNodeById?.(id);
        if (!node || node.mode === 2) return;
        if (node.isSubgraphNode?.() && node.subgraph) {
            const sub = node.subgraph;
            for (const link of linksOf(sub)) {
                if (link.origin_id === sub.inputNode?.id && link.origin_slot === slot) {
                    reach(sub, link.target_id, link.target_slot);
                }
            }
            return;
        }
        const arrived = node.inputs?.[slot]?.name;
        const picks = (node.outputs ?? []).map((_o, i) => switchInputs(node, i));
        if (picks.some((p) => p)) {
            // a switch: blocked only where it will pick the blocked input
            picks.forEach((p, i) => {
                if (p?.length === 1 && p[0] === arrived) flow(node, i);
            });
            return;
        }
        if (out.has(node)) return;
        out.add(node);
        flowAll(node);
    };
    for (const g of allGraphs()) {
        for (const n of nodesOf(g)) {
            if (n.type !== GATE || n.mode === 2 || n.mode === 4) continue;
            if (staticInput(n, "mute") === true) flow(n, 0);
        }
    }
    return out;
}

function isInactive(presetsNode, blocked) {
    if (presetsNode.mode === 2 || presetsNode.mode === 4) return false;
    const { ends, dead } = pathsFrom(presetsNode, { prune: true, blocked });
    return ends.length === 0 && dead.length > 0;
}

/** Nodes 2.0: the node is a DOM element. */
function vueElement(node) {
    return document.querySelector(`[data-node-id="${CSS.escape(String(node.id))}"]`);
}

let fadeStyle = null;
function ensureFadeStyle() {
    if (fadeStyle) return;
    fadeStyle = document.createElement("style");
    // !important: the element's own inline opacity (mute, bypass) is
    // rewritten by Vue on every style patch -- a move, a resize
    fadeStyle.textContent =
        `[data-node-id][${INACTIVE_ATTR}] { opacity: ${FADE} !important; }`;
    document.head.appendChild(fadeStyle);
}

/** Put each node's fade in step with the set (both renderers). */
function paintFades() {
    const vue = typeof LiteGraph !== "undefined" && LiteGraph.vueNodesMode;
    for (const g of allGraphs()) {
        for (const n of nodesOf(g)) {
            if (n.type !== PRESETS_NODE) continue;
            const off = inactive.has(n);
            // classic: its DOM widgets float above the canvas
            for (const w of n.widgets ?? []) {
                const elm = w.element ?? w.inputEl;
                if (!elm) continue;
                const want = off && !vue ? String(FADE) : "";
                if (elm.style.opacity !== want) elm.style.opacity = want;
            }
            if (vue) {
                const elm = vueElement(n);
                if (!elm) continue;
                if (off && !elm.hasAttribute(INACTIVE_ATTR)) {
                    ensureFadeStyle();
                    elm.setAttribute(INACTIVE_ATTR, "");
                } else if (!off && elm.hasAttribute(INACTIVE_ATTR)) {
                    elm.removeAttribute(INACTIVE_ATTR);
                }
            }
        }
    }
}

function refreshActivity() {
    inactive.clear();
    let blocked = new Set();
    try {
        blocked = blockedNodes();
    } catch (err) {
        console.error("[obvpm-override] could not trace the gates:", err);
    }
    for (const g of allGraphs()) {
        for (const n of nodesOf(g)) {
            if (n.type !== PRESETS_NODE) continue;
            try {
                if (isInactive(n, blocked)) inactive.add(n);
            } catch (err) {
                console.error("[obvpm-override] could not trace", n.id, err);
            }
        }
    }
    paintFades();
    app.canvas?.setDirty?.(true, true);
}

/**
 * Classic: the node is drawn with every alpha it sets scaled by FADE.
 * One globalAlpha up front is not enough -- drawNode puts it back to 1
 * before the widgets -- so for the length of this one node's draw the
 * context's globalAlpha is an own property that scales what is set.
 */
const ALPHA = Object.getOwnPropertyDescriptor(
    globalThis.CanvasRenderingContext2D?.prototype ?? {}, "globalAlpha");

function drawFaded(draw, canvas, node, ctx) {
    if (!ALPHA?.set || !inactive.has(node)) return draw.call(canvas, node, ctx);
    Object.defineProperty(ctx, "globalAlpha", {
        configurable: true,
        get() { return ALPHA.get.call(ctx) / FADE; },
        set(v) { ALPHA.set.call(ctx, v * FADE); },
    });
    try {
        ctx.globalAlpha = 1;
        return draw.call(canvas, node, ctx);
    } finally {
        delete ctx.globalAlpha;
    }
}

function markPresets(presetsNode) {
    const { ends, byField } = pathsFrom(presetsNode);
    for (const w of presetsNode.widgets ?? []) {
        if (!w[PRESETS_FIELD] || w.name === PRESETS_ROW) continue;
        const field = w.name.replace(/ {2}⚠$/, "");
        const base = String(w.label ?? w.name).replace(MARK_SUFFIX, "");
        const over = ends.filter((acc) => acc.has(field)).length;
        const all = ends.length > 0 && over === ends.length;
        let label = base;
        if (all) {
            label = base + "  ⤳ overridden";
        } else if (over) {
            label = base + `  ⤳ overridden in ${over} of ${ends.length}`;
        }
        if (w.label !== label) w.label = label;
        const by = byField.get(field);
        w.__obvpmOverriddenBy = over ? [...(by ?? [])].join(", ") : null;
        // disabled only when no path reads the preset's own value; and
        // only undone where this code did it
        if (all) {
            if (!w.disabled) { w.disabled = true; w.__obvpmOvDisabled = true; }
            (w.options ??= {}).disabled = true;
        } else if (w.__obvpmOvDisabled) {
            w.disabled = false;
            w.__obvpmOvDisabled = false;
            if (w.options) w.options.disabled = false;
        }
    }
    presetsNode.setDirtyCanvas?.(true, true);
}

function refreshMarks() {
    for (const g of allGraphs()) {
        for (const n of nodesOf(g)) {
            if (n.type === PRESETS_NODE) {
                try {
                    markPresets(n);
                } catch (err) {
                    console.error("[obvpm-override] could not mark", n.id, err);
                }
            }
        }
    }
}

let marksTimer = null;
function scheduleMarks() {
    if (marksTimer) return;
    marksTimer = setTimeout(() => {
        marksTimer = null;
        refreshMarks();
        refreshActivity();
        refreshBranches();
    }, 60);
}

/** Override nodes whose bundle comes from this Value Presets node. */
function overridesOf(presetsNode) {
    const out = [];
    for (const g of allGraphs()) {
        for (const n of nodesOf(g)) {
            if (n.type !== NODE) continue;
            if (leavesOf(n, IN)?.some((l) => l.node === presetsNode)) out.push(n);
        }
    }
    return out;
}

presetsListeners.add((presetsNode, what) => {
    if (what === "built") {
        // a new schema: new fields, new ranges and lists
        for (const n of overridesOf(presetsNode)) void rebuild(n);
    } else {
        // a value moved: the rows' "bundle: ..." text follows it
        for (const n of overridesOf(presetsNode)) {
            const source = n.__obvpmOvSource;
            if (source?.kind === "presets" && source.presets?.length) {
                source.values = agreedValues(source.presets);
            }
            for (const w of n.widgets ?? []) {
                if (w[ROW] && w.type === "toggle") {
                    (w.options ??= {}).off = offLabel(source, w.name);
                }
            }
            n.setDirtyCanvas?.(true, true);
        }
    }
    // the preset node rewrote its labels: put the marks back
    markPresets(presetsNode);
});

/** Which nodes the bundle comes from now, as a comparable string. */
function leafKey(node) {
    try {
        return (leavesOf(node, IN) ?? []).map((l) => l.node.id).join(",");
    } catch (err) {
        return "";
    }
}

/**
 * A switch upstream may have changed its mind (the timeline's upscale
 * toggle, a preset's boolean, a case pick): an override whose bundle now
 * comes from another node rebuilds, showing that node's values.
 */
function refreshBranches() {
    for (const g of allGraphs()) {
        for (const n of nodesOf(g)) {
            if (n.type !== NODE || n.__obvpmOvBuilding || n.__obvpmOvRemoved) continue;
            if (n.__obvpmOvLeaves !== undefined && leafKey(n) !== n.__obvpmOvLeaves) {
                void rebuild(n);
            }
        }
    }
}

api.addEventListener("graphChanged", scheduleMarks);
// graphChanged comes from the change tracker, which looks on a window
// mouseup -- and a button in a node's DOM (the timeline's upscale
// toggle) gets pointer events whose default the frontend cancels, so no
// mouseup ever comes and the fades waited for the next unrelated click.
// Every pointerup and keyup, in the capture phase (nothing can stop it
// there), schedules the same refresh; the click that follows the
// pointerup has changed the value by the time it runs.
window.addEventListener("pointerup", scheduleMarks, true);
window.addEventListener("keyup", scheduleMarks, true);
// Mute Group If changes modes on its own clock (a beat after the click
// that changed its value), which none of the above sees
window.addEventListener("obvpm:modes-changed", scheduleMarks);

// ---------------------------------------------------------------------
// the node
// ---------------------------------------------------------------------

app.registerExtension({
    name: "obvpm.override_values",
    setup() {
        const canvas = app.canvas;
        if (canvas && !canvas.__obvpmShades) {
            canvas.__obvpmShades = true;
            const drawNode = canvas.drawNode;
            canvas.drawNode = function (node, ctx) {
                return drawFaded(drawNode, this, node, ctx);
            };
            // Nodes 2.0: a remounted node element lost its attribute
            const fg = canvas.onDrawForeground;
            canvas.onDrawForeground = function (ctx, area) {
                const r = fg?.call(this, ctx, area);
                if (inactive.size && LiteGraph.vueNodesMode) {
                    try { paintFades(); } catch (err) { /* never break the canvas */ }
                }
                return r;
            };
        }
    },
    // a workflow with no override node still shades its presets
    afterConfigureGraph() {
        scheduleMarks();
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            hideWidget(this, STATE);
            hideWidget(this, WIRES);
            // "set to constant": the name shows as set_constant, last
            const node = this;
            this.__obvpmNameProxy = (show) => showConstantRow(node, show);
            showConstantRow(this, constantOn(this));
            // the declared wire_N pool shows only as fields ask for it
            syncSockets(this, "inputs", WIRE, [], MAX_WIRES);
            addConfigButton(this, openConfig);
            if (!isLoading(this)) {
                // the hidden multiline `state` asked for 400 px when it
                // was made; a new node takes only the width it needs
                const need = this.computeSize?.();
                if (need) this.setSize?.([need[0], need[1]]);
                void rebuild(this, { fit: true });
            }
            return r;
        };

        // The gear row is the last one, and LiteGraph's default height
        // pads under it as if it were a full widget row: it sat 17 px
        // off the bottom edge where Bundle/Unbundle's sits 5 px off.
        const computeSize = nodeType.prototype.computeSize;
        nodeType.prototype.computeSize = function () {
            const size = computeSize.apply(this, arguments);
            const gear = (this.widgets ?? []).at(-1);
            if (gear?.name === "obvpm_cfg" && !gear.hidden) {
                size[1] = Math.max(size[1] - GEAR_TRIM, 0);
            }
            return size;
        };

        // configure() replays the saved links; nothing may resize then
        const configure = nodeType.prototype.configure;
        nodeType.prototype.configure = function () {
            this.__obvpmOvConfiguring = true;
            try {
                return configure.apply(this, arguments);
            } finally {
                this.__obvpmOvConfiguring = false;
            }
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            // the source may not be configured yet: trace once the load
            // has finished (a loaded node keeps its saved size)
            const node = this;
            setTimeout(() => void rebuild(node), 0);
            return r;
        };

        const onConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (type, index) {
            const r = onConnectionsChange?.apply(this, arguments);
            if (type === 1 && !isLoading(this)) {
                if (this.inputs?.[index]?.name === IN) void rebuild(this, { fit: true });
                else scheduleMarks();           // a wired field came or went
            } else if (type === 2 && !isLoading(this)) {
                scheduleMarks();                // a reader came or went
            }
            return r;
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            this.__obvpmOvRemoved = true;
            scheduleMarks();
            return onRemoved?.apply(this, arguments);
        };
    },
});
