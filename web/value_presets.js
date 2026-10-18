import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
// Imported rather than copied: hiding a widget leaves its input socket
// behind -- invisible, still hit-tested, and ready to take a wire aimed
// at nothing. One implementation of that fix, and of the dialog kit and
// palette (the bundle config and Load Images & Compose use them too).
import { el, TEXT, TITLE, INK, DIM, EDGE, FILL, PANEL,
         textBox, pushButton, openOverlay, askText, askConfirm, askChoice, askTextChoice, notice,
         dropWidgetSockets, keepComboDefined, themePalette, valueTooltip, legacyCanvasBox,
         NODE_BUTTON, NODE_BUTTON_HOVER, gripHandle, markRow,
         sortableRows } from "./obvpm_ui.js";
import { trace, listenForPageErrors, loadStarted, loadFinished,
         reportText, copyText } from "./value_presets_diag.js";
import { STAR, typeIdOf, cleanTypeId, isUserLabel, bareName,
         userPresets, userPresetsError, loadUserPresets, saveUserPresets,
         userFilters, saveUserFilters, onUserPresetsChange, presetFileText, parseImports,
         mergePresets, pickPresets, exportFileName, download } from "./value_presets_user.js";
import { constantOn, setMode } from "./obvpm_constants.js";
import { staticInput } from "./obvpm_dynamic.js";
import { restoreRows, restoreWrites } from "./value_presets_restore.js";
import { filterChoices, filterNote, filtersFrom, patternsFrom }
    from "./value_presets_filter.js";

/**
 * Value Presets: a control per schema field, and named sets of them.
 *
 * THE SCHEMA IS PARSED ON THE SERVER, not here. This node could read its
 * own `schema` widget -- the syntax is small enough -- but then the rule
 * for what a line means would live in two languages, and the day either
 * moved they would disagree about what a preset holds. That is precisely
 * the class of bug the node exists to remove, so it must not be
 * reintroduced in its own UI. `/obvpm/presets/schema` answers with the
 * fields, their types, their resolved choice lists and their defaults,
 * and the widgets are built from that.
 *
 * THE VALUES ARE NOT IN `widgets_values`. Widgets serialise by position,
 * so a schema-driven set of them would renumber every stored value the
 * moment a line moved. The per-field widgets are built here with
 * `serialize = false` and mirrored into the node's `values` widget as
 * JSON, keyed by name -- one opaque channel, the same arrangement the H3
 * timeline uses for its pin state. The node's own signature stays five
 * widgets whatever the schema says.
 *
 * WHAT RUNS IS WHAT YOU SEE. Selecting a preset writes its values into
 * these controls rather than leaving them showing something else, and
 * they stay EDITABLE -- so there is one place to read the settings a
 * queued run will use, and it is the same place they are set. Changing
 * one does not silently detach the label: the node keeps saying which
 * preset it started from and marks itself modified, which is what
 * `update` then has something to update.
 */

const NODE = "ValuePresets (obvpm)";
const CUSTOM = "custom";

// Widgets this node declares. Everything else on it is built here.
const SCHEMA = "schema";
const PRESET = "preset";
const VALUES = "values";
const PRESETS = "presets";
const NAMES = "names";
// the constant's name, when "set by name" is on (obvpm_constants.js)
const SET_W = "set";
// the fields this node switches off (config -> Schema, the `on` column),
// one per line: hidden here and None on the bundle (presets.py resolve)
const DISABLED_W = "disabled";
// Hidden on the node's face. The schema joins them: "edit schema…" is
// the way in, and a multiline box of syntax sitting above the controls
// is a second, worse one. It stays a real widget -- it is still the
// store, still what a workflow carries, and still wire-able.
// the user presets a wired `preset` may select, put in the PROMPT only
// (see setup); declared last in presets.py
const USER_PRESETS_W = "user_presets";
const OWNED = [SCHEMA, VALUES, PRESETS, NAMES, DISABLED_W, USER_PRESETS_W];

// Where the built controls start, so buttons can sit after them.
const MARK = "__obvpmField";

function widget(node, name) {
    return (node.widgets ?? []).find((w) => w.name === name);
}

function hide(w, hidden = true) {
    if (!w) return;
    // both ways: the canvas renderer reads widget.hidden (layout and
    // drawing both skip it), the Vue one reads widget.options.hidden
    w.hidden = hidden;
    (w.options ??= {}).hidden = hidden;
    const el = w.element ?? w.inputEl;
    if (el) el.style.display = hidden ? "none" : "";
}

function readJson(node, name) {
    try {
        const parsed = JSON.parse(widget(node, name)?.value || "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? Object.assign(Object.create(null), parsed) : Object.create(null);
    } catch (err) {
        return Object.create(null);     // the server reports it properly
    }
}

function writeJson(node, name, value) {
    const w = widget(node, name);
    if (!w) return;
    w.value = JSON.stringify(value);
}

/**
 * The schema's fields, from the server.
 *
 * NOT CACHED, deliberately. The obvious cache is by schema text, and it
 * would be wrong: a borrowed list is the point of borrowing, and
 * `@LoraName.lora_name` answers differently after you drop a file in the
 * folder while the schema says exactly what it said before. Nothing is
 * saved by caching anyway -- `rebuild` already refuses to ask unless the
 * text changed, so this runs on a schema edit and on the deliberate
 * rebuilds, not on the draw loop.
 */
/**
 * Who wants to hear that a Value Presets node built its fields ("built")
 * or had a value changed ("value"): Override Bundle Values
 * (override_values.js), whose "overridden" mark on a field is lost when
 * the widget is rebuilt, and whose rows show the bundle's own value.
 */
export const presetsListeners = new Set();

function tell(node, what) {
    for (const listener of presetsListeners) {
        try {
            listener(node, what);
        } catch (err) {
            console.error("[obvpm-presets] listener failed:", err);
        }
    }
}

export async function describe(schema) {
    try {
        const resp = await api.fetchApi("/obvpm/presets/schema", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ schema: String(schema ?? "") }),
        });
        return await resp.json();
    } catch (err) {
        return { error: String(err?.message ?? err) };
    }
}

// ---------------------------------------------------------------------
// The description saved with the node
//
// The fields are drawn from the server's description of the schema, and
// a loaded workflow used to wait for it: the answer comes back in a few
// ms, but the browser is busy building the rest of the workflow and only
// reads it once the whole load is done -- so every preset node showed up
// empty and filled in last. The node now keeps the last description in
// its properties, keyed by the schema text, and a load whose schema
// matches builds from it at once; the server is still asked, and a
// different answer rebuilds the node.
//
// What is kept is only what does not depend on the machine. A borrowed
// dropdown's list (and a default taken from it, and the note that the
// written default is not in it) is this machine's -- the author's model
// and LoRA file names -- so none of it goes into a shared workflow: the
// list is read from the browser's own node definitions at load, and the
// default and the note are worked out from it the way the server does
// (presets.py Field.default / default_missing / describe).
// ---------------------------------------------------------------------

const DESC_PROP = "obvpm_schema_desc";

/** A short key for a schema text: FNV-1a over it, and its length. */
function schemaKey(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0") + ":" + text.length;
}

/** The part of an answer that may be saved, or null (an answer with an
 *  error is not kept: the next load asks again). */
function portableDescription(answer) {
    if (!answer || answer.error || !Array.isArray(answer.fields)) return null;
    if (answer.fields.some((f) => f.error)) return null;
    return answer.fields.map((f) => {
        if (!f.ref) return f;
        // without this machine's list, its default, and the local "not in
        // this list" note (savedAnswer puts all three back)
        const { choices, default: _d, note, ...rest } = f;
        return rest;
    });
}

/** JSON with object keys sorted: two answers compared by content. */
function canonical(value) {
    return JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
}

/** Python's repr of a str, as `%r` writes it in the server's note. */
function pyRepr(text) {
    const s = String(text);
    const q = s.includes("'") && !s.includes('"') ? '"' : "'";
    const body = s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t").split(q).join("\\" + q);
    return q + body + q;
}

/** A borrowed list from the browser's node definitions (ref_choices). */
function localChoices(ref) {
    const text = String(ref ?? "");
    const dot = text.indexOf(".");
    if (dot < 0) return null;
    const nodeName = text.slice(0, dot).trim();
    const inputName = text.slice(dot + 1).trim();
    const def = LiteGraph.registered_node_types?.[nodeName]?.nodeData;
    const input = def?.input;
    const spec = input?.required?.[inputName] ?? input?.optional?.[inputName];
    if (!spec) return null;
    if (Array.isArray(spec[0])) return spec[0];
    const options = spec[1]?.options;
    return Array.isArray(options) ? options : null;
}

/** The saved description with this machine's parts put back, as an
 *  answer buildFields takes; null when it cannot be (the server decides). */
function savedAnswer(node, schema) {
    const saved = node.properties?.[DESC_PROP];
    if (!saved || saved.key !== schemaKey(schema)) return null;
    let fields;
    try {
        fields = JSON.parse(saved.json);
    } catch (err) {
        return null;
    }
    if (!Array.isArray(fields)) return null;
    const out = [];
    for (const f of fields) {
        if (!f || typeof f !== "object" || typeof f.name !== "string") return null;
        if (!f.ref) {
            out.push(f);
            continue;
        }
        const choices = localChoices(f.ref);
        if (!choices) return null;
        const written = String(f.default_text ?? "");
        const hit = written ? choices.find((c) => String(c) === written) : undefined;
        const fallback = choices.length ? choices[0]
            : ({ int: 0, float: 0.0, bool: false }[f.kind] ?? "");
        const entry = { ...f, choices, default: hit !== undefined ? hit : fallback };
        delete entry.note;
        if (written && hit === undefined && choices.length) {
            entry.note = "The schema's default, " + pyRepr(written)
                + ", is not in this list here, so the field starts on the first entry.";
        }
        out.push(entry);
    }
    return { fields: out };
}

/** Keep the answer with the node, when it can be kept. */
function saveDescription(node, schema, answer) {
    const fields = portableDescription(answer);
    if (!fields) return;
    const next = { key: schemaKey(schema), json: JSON.stringify(fields) };
    const now = node.properties?.[DESC_PROP];
    if (now?.key === next.key && now?.json === next.json) return;
    node.properties ??= {};
    node.properties[DESC_PROP] = next;
}

/**
 * A loaded node: build from the saved description now, then check it
 * with the server. True when it built.
 */
function buildFromSaved(node) {
    const schema = String(widget(node, SCHEMA)?.value ?? "");
    if (!schema.trim() || !isLive(node)) return false;
    const answer = savedAnswer(node, schema);
    if (!answer) return false;
    node.__obvpmBuilt = schema;
    try {
        buildFields(node, answer);
    } catch (err) {
        node.__obvpmBuilt = null;
        trace(node, "saved-build-threw", String(err?.stack ?? err));
        return false;
    }
    trace(node, "built", "from the saved description, "
          + answer.fields.length + " fields");
    const used = canonical(answer.fields);
    void (async () => {
        const fresh = await describe(schema);
        if (node.__obvpmRemoved || !isLive(node)) return;
        if (String(widget(node, SCHEMA)?.value ?? "") !== schema) return;  // edited meanwhile
        if (node.__obvpmBuilt !== schema || fresh?.error) return;
        if (canonical(fresh.fields) === used) return;
        // this machine's server says otherwise: its answer wins
        trace(node, "saved-differs", "rebuilding from the server's answer");
        buildFields(node, fresh);
        saveDescription(node, schema, fresh);
    })();
    return true;
}

/**
 * A hidden field's list, with the field's own value in it.
 *
 * ComfyUI (frontend 1.55) flags a dropdown whose model-file value is not
 * in its list as a missing model -- hidden or not -- and asks the user to
 * open the node and replace it. A hidden field cannot be replaced from
 * the node, and its value is not used: a field whose `when` is off or
 * that the node switches off is left out of the bundle (presets.py), and
 * an override that is off overrides nothing. So while hidden its list
 * holds its value too, and only then: shown, the list is the machine's
 * own again and a missing file is missing. The server checks its own
 * lists, never this one. (Issue: 007's hidden turbo LoRA with turbo off.)
 */
function withHiddenValue(node, name, choices) {
    const live = (node.widgets ?? []).find((x) => x[MARK] && x.name === name);
    if (!live || !(live.hidden || live.options?.hidden)) return choices;
    const value = live.value == null ? "" : String(live.value);
    if (!value || choices.some((c) => String(c) === value)) return choices;
    return [...choices, value];
}

// What ComfyUI's missing-model check counts as a model file
// (missingModelScan.ts, MODEL_FILE_EXTENSIONS).
const MODEL_FILE = /\.(safetensors|ckpt|pt|pth|bin|sft|onnx|gguf)$/i;

/** A dropdown field holding a model file: what that check looks at. */
export function isModelField(w) {
    return w?.[MARK] === true && w.type === "combo"
        && MODEL_FILE.test(String(w.value ?? ""));
}

let recheckQueued = false;

/**
 * Run ComfyUI's missing-model check again, once for everything that
 * changed in this task. It runs by itself only when a workflow loads, so
 * a model field shown or hidden afterwards (turbo switched on, a preset
 * that turns it off again, an override switched) would keep the warning
 * the load gave, or never get one. Same check and same warning as on
 * load (frontend 1.55+; older ones have no such check, nothing to do).
 * The canvas is redrawn after it: the red outline is painted from the
 * check's result, and the classic canvas paints only when asked. The
 * result lands a moment AFTER the call returns (measured: <50 ms; it
 * can wait on the model folder lists), so it is asked again later too.
 */
export function recheckMissingModels() {
    if (recheckQueued || typeof app.refreshMissingModels !== "function") return;
    recheckQueued = true;
    setTimeout(async () => {
        recheckQueued = false;
        try {
            await app.refreshMissingModels({ reloadDefs: false, silent: false });
        } catch (err) {
            console.warn("obvpm: re-checking missing models failed", err);
        }
        for (const ms of [0, 150, 1000]) {
            setTimeout(() => app.canvas?.setDirty?.(true, true), ms);
        }
    }, 0);
}

/**
 * Build one widget for one field.
 *
 * `serialize = false` on every one of them: their values live in the
 * `values` JSON, and letting them into widgets_values as well would be
 * two stores for one fact, positional, in the node whose whole point is
 * that neither of those things happens.
 *
 * THE WIDGET'S STATE OUTLIVES THE WIDGET. The frontend keeps widget
 * state in a store keyed by (graph, node, name), and addWidget on a
 * name it has seen hands the old state back and DROPS the value passed
 * in (BaseWidget.setNodeId -> registerWidget returns the existing
 * entry). Two consequences shape this function: the name must be final
 * BEFORE addWidget (renaming after leaves the state filed under the old
 * key), and the value must be ASSIGNED after (assignment writes through
 * to the surviving state; the constructor argument does not). Without
 * the assignment, revert and preset-apply repaint nothing.
 */
export function fieldWidget(node, field, value, onChange, { filterOf } = {}) {
    const set = (v) => { onChange(field.name, v); };
    const shown = field.error ? field.name + "  ⚠" : field.name;
    // The user's dropdown filter for this field (config -> Filters):
    // looked up live by the node and the field's NAME, like the list
    // itself, so a surviving widget's first closure still answers right.
    const filter = filterOf ?? (() => userFilters(typeIdOf(node))[field.name]);
    const listed = () => {
        const all = node.__obvpmFieldMap?.[field.name]?.choices ?? [];
        const live = (node.widgets ?? []).find((x) => x[MARK] && x.name === shown);
        return filterChoices(all, filter(), live ? live.value : undefined);
    };
    let w, coerced;
    if (field.choices) {
        // A values FUNCTION because litegraph wants one -- and it must
        // close over the node and the NAME, not this build's field
        // object: a re-created widget keeps the FIRST build's options in
        // the surviving state, so an old closure over an old field would
        // serve stale choices forever. Looked up live, even the old
        // closure answers with this build's list.
        coerced = String(value ?? "");
        w = keepComboDefined(node.addWidget("combo", shown, coerced, set, {
            values: () => withHiddenValue(node, shown, listed().choices),
        }));
    } else if (field.kind === "bool") {
        coerced = !!value;
        w = node.addWidget("toggle", shown, coerced, set);
    } else if (field.kind === "int" || field.kind === "float") {
        // a float shows and steps by the decimals its range was
        // written with (0..1.0 one, 0..1.00 two; 0..1 two), per server
        const decimals = field.kind === "int" ? 0 : (field.decimals ?? 2);
        const step = Math.pow(10, -decimals);
        coerced = Number(value ?? 0);
        w = node.addWidget("number", shown, coerced, set, {
            min: field.lo ?? -Infinity, max: field.hi ?? Infinity,
            step: step * 10,            // litegraph's step is /10 on drag
            precision: decimals,
            round: field.kind === "int" ? 1 : false,
        });
    } else {
        coerced = String(value ?? "");
        w = node.addWidget("string", shown, coerced, set);
    }
    w.value = coerced;                  // through to the surviving state
    w.serialize = false;
    w[MARK] = true;
    if (field.error) {
        // Shown, not hidden: the value is still there and still what
        // would run, and the node refuses at queue time anyway. A field
        // that quietly vanished would look like data loss.
        w.label = w.name;
    }
    // The schema's hint for the field, the error if it has one, and the
    // note about this machine's list -- shown as text (the tooltip is
    // rendered as text by the host, never as markup).
    const baseTip = [field.error, field.hint, field.note].filter(Boolean).join("\n\n")
        || undefined;
    // The full value on hover whenever the widget draws it cut off -- a
    // long file name in a narrow node. A getter, not a stored string: the
    // frontend reads widget.tooltip at hover time, and both the value and
    // the node's width change long after this build.
    // ...and, on a filtered dropdown, how much of the list it shows
    const tip = () => {
        const said = field.choices ? filterNote(listed()) : "";
        return [baseTip, said].filter(Boolean).join("\n\n") || undefined;
    };
    Object.defineProperty(w, "tooltip", {
        configurable: true,
        get: () => valueTooltip(w, node.size?.[0] ?? 0, tip()),
        set: () => {},
    });
    return w;
}

/**
 * Whether a field is shown, given the values on the node.
 *
 * The SAME rule presets.py's is_shown applies to the bundle: a field
 * whose `when` does not hold is hidden, and so is one whose deciding
 * field is itself hidden. Applied here to the parsed condition the
 * server described, so the text is still read in one place; only this
 * one comparison is repeated, and it is a lookup, not an expression.
 */
function isShown(field, fieldMap, values, shown) {
    if (!field.when) return true;
    const decider = fieldMap[field.when.field];
    if (!decider) return true;          // the server refused the schema
    if (!(shown[decider.name] ?? isShown(decider, fieldMap, values, shown))) {
        return false;
    }
    const value = values[decider.name];
    const text = typeof value === "boolean" ? (value ? "true" : "false")
        : String(value ?? "");
    return field.when.values.includes(text) !== !!field.when.not;
}

/**
 * Hide and show the field widgets to match the values.
 *
 * On every change of a value, not only on a rebuild: the toggle that
 * hides the LoRA picker is answered at once, and without rebuilding --
 * the widgets keep their state, so the hidden value comes back when
 * the toggle does. The node is re-sized to the widgets it shows, in
 * both directions: addWidget only ever grows a node, so a row of
 * hidden fields would otherwise leave a blank band under the buttons.
 */
function applyVisibility(node) {
    const fieldMap = node.__obvpmFieldMap ?? {};
    const off = disabledFields(node);
    // what the `when` lines read: the values, except that a field this
    // node switches off counts at its default (presets.py resolve)
    const values = readJson(node, VALUES);
    for (const name of off) {
        if (fieldMap[name]) values[name] = fieldMap[name].default;
    }
    const shown = Object.create(null);
    for (const field of Object.values(fieldMap)) {
        shown[field.name] = isShown(field, fieldMap, values, shown);
    }
    for (const name of off) shown[name] = false;
    // a heading shows while any field under it does
    const groupShown = Object.create(null);
    for (const field of Object.values(fieldMap)) {
        if (field.group && shown[field.name]) groupShown[field.group] = true;
    }
    let moved = false;
    let modelMoved = false;
    for (const w of node.widgets ?? []) {
        if (!w[MARK] || w.name === ROW_NAME) continue;
        const field = w.name.replace(/ {2}⚠$/, "");
        const hidden = w[HEADING] != null ? !groupShown[w[HEADING]]
            : shown[field] === false;
        // either flag: the options object can outlive a rebuild with
        // the widget's state while the instance comes back fresh
        if (!!(w.hidden || w.options?.hidden) !== hidden) {
            hide(w, hidden);
            moved = true;
            if (isModelField(w)) modelMoved = true;
        }
    }
    // A model field that came or went after the node was first laid out
    // (not the load itself: ComfyUI checks the loaded workflow on its own)
    if (modelMoved && node.__obvpmVisibilitySettled) recheckMissingModels();
    node.__obvpmVisibilitySettled = true;
    if (moved && typeof node.computeSize === "function" && node.size) {
        node.setSize?.([node.size[0], node.computeSize()[1]]);
        notifyVue(node);
    }
    return shown;
}

/** The field names this node switches off. */
function disabledFields(node) {
    return new Set(String(widget(node, DISABLED_W)?.value ?? "")
        .split(/[\n,]/).map((n) => n.trim()).filter(Boolean));
}

// A heading over a group of fields (a `## Title` line in the schema):
// drawn on the canvas like the fields themselves, so it sits in their
// list in both renderers and takes no DOM overlay. Never serialized.
const HEADING = "__obvpmHeading";
const HEADING_H = 22;

function headingWidget(node, title) {
    const w = node.addCustomWidget({
        name: "§ " + title,
        type: "obvpm_heading",
        value: "",
        options: { serialize: false },
        serialize: false,
        computeSize: (width) => [width, HEADING_H],
        draw(ctx, _node, width, y, height) {
            const [wide] = legacyCanvasBox(ctx, width, height || HEADING_H);
            const P = themePalette();
            const h = height || HEADING_H;
            ctx.save();
            ctx.font = "600 11px sans-serif";
            ctx.fillStyle = P.sub;
            ctx.textBaseline = "middle";
            const mid = y + h / 2 + 2;
            const text = String(title).toUpperCase();
            ctx.fillText(text, 15, mid);
            const after = 15 + ctx.measureText(text).width + 8;
            ctx.strokeStyle = P.sub;
            ctx.globalAlpha *= 0.35;
            ctx.beginPath();
            ctx.moveTo(after, mid);
            ctx.lineTo(wide - 15, mid);
            ctx.stroke();
            ctx.restore();
        },
    });
    w[MARK] = true;
    w[HEADING] = title;
    return w;
}

/**
 * Remove the widgets this extension built, leaving the declared ones.
 *
 * The button row survives: it is a DOM widget with a live element and an
 * event wiring, and tearing it down and rebuilding it on every schema
 * change would leak the old element and flicker the row. It restates
 * itself from the node instead (paintButtonRow).
 */
function clearBuilt(node) {
    // The problem line is a DOM widget: dropped from the list alone, its
    // element would stay on screen with nothing updating it.
    const problem = widget(node, PROBLEM);
    try { problem?.onRemove?.(); } catch (err) { /* the list still drops it */ }
    node.widgets = (node.widgets ?? []).filter(
        (w) => !w[MARK] || w.name === ROW_NAME);
}


/**
 * Which fields differ from the preset the node says it is on.
 *
 * The controls are NOT locked while a preset is selected. Locking was
 * the first answer and it was the wrong one twice over: a disabled
 * widget is hard to read, which defeats the point of showing the
 * preset's values at all, and it left "update" as a button that could
 * never have anything to update. Editing a loaded preset is an ordinary
 * thing to want. So the values stay editable and the node says plainly
 * that they have moved -- which is also the honest thing to record,
 * because the label travels in the saved workflow and into every take.
 */
/**
 * What a preset means for a field it never stored: the schema default.
 * A preset saved before a field existed says nothing about it, and the
 * field's default is what the node would run with -- so that is the
 * value the preset is taken to hold, both when comparing (a new field
 * moved off its default IS a change from the preset) and when reverting.
 */
function presetValue(node, saved, key) {
    if (Object.prototype.hasOwnProperty.call(saved, key)) return saved[key];
    return node.__obvpmFieldMap?.[key]?.default;
}

function modifiedFields(node) {
    const name = selected(node);
    if (name === CUSTOM) return [];
    const saved = lookupPreset(node, name);
    if (!saved || typeof saved !== "object") return [];
    const now = readJson(node, VALUES);
    // Over the CURRENT fields, not the preset's keys: a field added to
    // the schema after the preset was saved is not among its keys, and
    // an edit to it went unreported (2026-09-09). A key the preset holds
    // for a field the schema lost is nothing to report either way.
    const fields = node.__obvpmFieldMap
        ? Object.keys(node.__obvpmFieldMap) : Object.keys(now);
    const off = disabledFields(node);
    return fields.filter((key) => key in now && !off.has(key)
        && String(now[key]) !== String(presetValue(node, saved, key)));
}

/** The chooser's label and the buttons, after anything that moves them. */
function refreshState(node) {
    const changed = modifiedFields(node);
    const chooser = widget(node, PRESET);
    if (chooser) {
        // The VALUE stays a real preset name -- it is what the server
        // records and what the library is keyed by. Only the label says
        // the values have moved on from it.
        chooser.label = changed.length ? PRESET + " ✎ modified" : PRESET;
        chooser.tooltip = changed.length
            ? "Changed since '" + selected(node) + "': " + changed.join(", ")
            : undefined;
        const wire = node.__obvpmWire;
        if (wire) {
            chooser.label = PRESET + (wire.label || !wire.known ? " ⇠ input" : " ⇠ input ⚠");
            chooser.tooltip = wireTip(node, wire);
        }
    }
    // Star the moved fields themselves, not just the summary line: the
    // LABEL only (the widget's name is its identity -- readJson keys,
    // clearBuilt, the changed list itself all look it up). An error
    // field's name already carries "  ⚠", so the star goes after that.
    const moved = new Set(changed);
    for (const w of node.widgets ?? []) {
        if (!w[MARK] || w.name === ROW_NAME) continue;
        const field = w.name.replace(/ {2}⚠$/, "");
        w.label = moved.has(field) ? w.name + " *" : w.name;
    }
    // The row reads THIS, so nothing is added or removed and the node's
    // height does not move when a value is edited.
    node.__obvpmChanged = changed;
    paintButtonRow(node);
    node.setDirtyCanvas?.(true, true);
    // after the labels are rewritten, so a listener's own mark on them
    // (Override Bundle Values' "overridden") is put back on top
    tell(node, "value");
}

const HIDDEN_PROP = "obvpm_presets_hidden";
const TYPE_ID_PROP = "obvpm_presets_type_id";

function hiddenPresets(node) {
    // an array as written -- or the {"0": ...} object some frontends make
    // of an array property -- so read the values either way
    const h = node.properties?.[HIDDEN_PROP];
    const list = Array.isArray(h) ? h
        : h && typeof h === "object" ? Object.values(h) : [];
    return new Set(list.map(String));
}

/**
 * The chooser's list: the workflow's presets (minus the ones hidden in
 * config -- except the one selected, so the chooser never shows a value
 * it does not list), then the user presets, marked ★.
 */
function presetNames(node) {
    const hidden = hiddenPresets(node);
    const current = selected(node);
    const own = Object.keys(readJson(node, PRESETS))
        .filter((n) => !hidden.has(n) || n === current)
        .sort((a, b) => a.localeCompare(b));
    const lib = typeIdOf(node);
    const mine = lib ? Object.keys(userPresets(lib))
        .sort((a, b) => a.localeCompare(b)).map((n) => STAR + n)
        .filter((label) => !hidden.has(label) || label === current) : [];
    // the user's own first, then the workflow's
    return [...mine, ...own];
}

// ------------------------------------------------ a wired preset (issue #20)
//
// A name wired into `preset` SELECTS that preset: the server runs its
// saved values (presets.py wired_preset), looking it up among the
// workflow presets and the user presets this page puts in the prompt
// while the input is wired. When the name is known before the run (a
// text node, a primitive, a switch with a known choice -- staticInput),
// the node applies it at once, so its face always shows what will run;
// a name made during the run is applied when the run reports it.

function presetWired(node) {
    return (node.inputs ?? []).some((i) => i.name === PRESET && i.link != null);
}

/** The chooser label a wired name stands for (CUSTOM for none), or null
 *  when it names no preset here -- the rule of presets.py wired_preset. */
function wiredLabel(node, name) {
    const text = String(name ?? "").trim();
    if (!text || text === CUSTOM) return CUSTOM;
    const lib = typeIdOf(node);
    const mine = lib ? userPresets(lib) : Object.create(null);
    const has = (store, key) => Object.prototype.hasOwnProperty.call(store, key)
        && store[key] && typeof store[key] === "object";
    if (isUserLabel(text)) {
        const bare = bareName(text).trim();
        return has(mine, bare) ? STAR + bare : null;
    }
    if (has(readJson(node, PRESETS), text)) return text;
    return has(mine, text) ? STAR + text : null;
}

function wireTip(node, wire) {
    if (!wire.known) {
        return "Selected by the wire, whose name is only known during the run: "
            + "the values shown are not necessarily what runs."
            + (node.__obvpmRan ? " Last run: '" + node.__obvpmRan + "'." : "");
    }
    if (!wire.label) {
        return "The wire names '" + wire.value + "', which is no preset here, so a "
            + "run is refused. The presets: " + (presetNames(node).join(", ") || "none") + ".";
    }
    return "Selected by the wire: '" + wire.label + "'. Its saved values run, "
        + "whatever is set here by hand.";
}

/**
 * Follow the wire: apply the preset it names whenever that is known and
 * not what the node shows -- a new name, or values edited by hand (the
 * wire decides what runs, so the face goes back to it).
 */
function followWire(node) {
    if (!node.__obvpmFieldMap || node.__obvpmRemoved) return;
    const chooser = widget(node, PRESET);
    if (!chooser) return;
    if (!presetWired(node)) {
        node.__obvpmWireApplied = null;
        if (node.__obvpmWire) {
            node.__obvpmWire = null;
            refreshState(node);
        }
        return;
    }
    const value = staticInput(node, PRESET);
    const known = typeof value === "string";
    const label = known ? wiredLabel(node, value) : null;
    const before = node.__obvpmWire;
    node.__obvpmWire = { known, value: known ? value.trim() : "", label };
    const moved = !before || before.known !== known || before.label !== label
        || before.value !== node.__obvpmWire.value;
    // Edited by hand since the wire's preset was last applied? Compared
    // by the values text, so a preset whose values never read back
    // exactly (a coercion) is not applied again and again; and never
    // while an apply is still on its way.
    const applied = node.__obvpmWireApplied;
    const valuesNow = String(widget(node, VALUES)?.value ?? "");
    const edited = !applied || (applied.values !== null && applied.values !== valuesNow);
    if (applied?.values === null) return;
    if (label && (selected(node) !== label
                  || (label !== CUSTOM && edited && modifiedFields(node).length))) {
        chooser.value = label;
        node.__obvpmWireApplied = { label, values: null };
        void applyPreset(node).finally(() => {     // ends in refreshState
            node.__obvpmWireApplied = {
                label, values: String(widget(node, VALUES)?.value ?? "") };
        });
    } else if (moved) {
        refreshState(node);
    }
}

function presetNodes() {
    const out = [];
    const walk = (g, level) => {
        if (!g || level > 8) return;
        for (const n of g._nodes ?? g.nodes ?? []) {
            if (n.type === NODE) out.push(n);
            if (n.subgraph) walk(n.subgraph, level + 1);
        }
    };
    walk(app.rootGraph ?? app.graph, 0);
    return out;
}

function followWires() {
    for (const node of presetNodes()) {
        try {
            followWire(node);
        } catch (err) {
            console.error("[obvpm-presets] following the preset wire:", err);
        }
    }
}

/** A preset's stored values by its chooser label: the workflow's, or the
 *  user presets for a ★ label. */
function lookupPreset(node, label) {
    if (isUserLabel(label)) {
        const lib = typeIdOf(node);
        return lib ? userPresets(lib)[bareName(label)] : undefined;
    }
    return readJson(node, PRESETS)[label];
}

/** Every Value Presets node, in every graph, with Preset Type Id `name`. */
function nodesUsingTypeId(name) {
    const out = [];
    const walk = (g, level) => {
        if (!g || level > 8) return;
        for (const n of g._nodes ?? g.nodes ?? []) {
            if (n.type === NODE && typeIdOf(n) === name) out.push(n);
            if (n.subgraph) walk(n.subgraph, level + 1);
        }
    };
    walk(app.graph ?? app.rootGraph, 0);
    return out;
}

// user presets that load or change: its nodes' choosers and "modified"
// state follow (the chooser reads the list live; only the labels and the
// button row need a refresh)
onUserPresetsChange((name) => {
    for (const node of nodesUsingTypeId(name)) {
        if (node.__obvpmFieldMap) refreshState(node);
    }
});

function selected(node) {
    return String(widget(node, PRESET)?.value ?? CUSTOM);
}

app.registerExtension({
    name: "obvpm.value_presets",

    // Diagnostics (value_presets_diag.js): page errors from here on, and
    // console.error only while a workflow loads -- what other packs throw
    // from their load hooks, which the frontend catches and logs.
    setup() {
        // A wired preset, followed on a short poll and at once after a
        // click or a key (the value can change anywhere: a text node, a
        // switch's choice), and right before every prompt is built, with
        // the user presets read again so the prompt carries them as they
        // are now.
        setInterval(followWires, 400);
        const soon = () => setTimeout(followWires, 30);
        window.addEventListener("pointerup", soon, true);
        window.addEventListener("keyup", soon, true);
        const toPrompt = app.graphToPrompt;
        if (typeof toPrompt === "function") {
            app.graphToPrompt = async function (...args) {
                try {
                    const ids = new Set(presetNodes().filter(presetWired)
                        .map(typeIdOf).filter(Boolean));
                    await Promise.all([...ids].map((id) => loadUserPresets(id, { fresh: true })));
                    followWires();
                } catch (err) {
                    console.error("[obvpm-presets] before the prompt:", err);
                }
                return toPrompt.apply(this, args);
            };
        }
        listenForPageErrors();
        if (typeof window !== "undefined") {
            window.obvpmPresetsDiag = (id) => {
                const nodes = (app.graph?._nodes ?? []).filter((n) => n.type === NODE);
                const node = id == null ? nodes[0] : nodes.find((n) => String(n.id) === String(id));
                return node ? diagnostics(node) : "No Value Presets node" + (id == null ? "" : " #" + id);
            };
        }
    },
    beforeConfigureGraph() {
        loadStarted();
    },
    afterConfigureGraph() {
        loadFinished();
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE) return;

        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            trace(this, "created", "id " + this.id);
            const r = created?.apply(this, arguments);
            setup(this);
            watch(this);
            return r;
        };

        // A node taken out of its graph -- deleted, or replaced by a load,
        // an undo or a tab switch -- is done: its watchdog, its retries and
        // an answer still on the way must leave it alone. `node.graph` does
        // not say so (a clear leaves it set, see rebuild), and the new node
        // under the same id made the old one's watchdog report "its graph
        // holds ANOTHER node" -- on a problem line added to the removed
        // node, a DOM widget nothing ever took down, drawn over the node
        // that replaced it wherever that one was not selected.
        const removed = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            this.__obvpmRemoved = true;
            clearTimeout(this.__obvpmWatch);
            trace(this, "removed", "id " + this.id);
            return removed?.apply(this, arguments);
        };
        const added = nodeType.prototype.onAdded;
        nodeType.prototype.onAdded = function () {
            this.__obvpmRemoved = false;        // put back: live again
            // pasted? (a load configures with app.configuringGraph set; a
            // paste configures right after adding, with it clear)
            this.__obvpmJustAdded = true;
            setTimeout(() => { this.__obvpmJustAdded = false; }, 0);
            return added?.apply(this, arguments);
        };

        // A workflow load replaces widget values AFTER creation, so the
        // controls have to be rebuilt once the real schema and values
        // are in place -- otherwise every loaded node shows the defaults.
        const configure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const saved = info?.widgets_values;
            // what the workflow carried, to tell "the load lost the
            // schema" from "the workflow never had one"
            this.__obvpmLoadedSchemaLen = String(saved?.[0] ?? "").length;
            trace(this, "configured", "id " + this.id + ", workflow schema "
                  + this.__obvpmLoadedSchemaLen + " chars, preset "
                  + JSON.stringify(saved?.[1] ?? null) + ", widgets_values "
                  + (Array.isArray(saved) ? saved.length : "none"));
            const r = configure?.apply(this, arguments);
            if (this.__obvpmJustAdded && !app.configuringGraph) {
                const node = this;
                // after the paste has finished adding its nodes
                setTimeout(() => joinGroup(node), 0);
            }
            // the fields at once, from the description saved with the
            // node (the server's answer would only be read once the
            // whole workflow has loaded); rebuild then finds it built
            buildFromSaved(this);
            void rebuild(this);
            // the user presets of the loaded node's Preset Type Id (a property, restored by now)
            void loadUserPresets(typeIdOf(this));
            watch(this);
            return r;
        };

        // "load settings" (comfyui-obvpm-timeline) asks the node itself
        // what loading a take's values would change, so a person decides
        // per field and per preset instead of on raw widget text.
        nodeType.prototype.obvpmRestoreRows = function (saved) {
            return restoreRowsFor(this, saved);
        };
        nodeType.prototype.obvpmRestoreApply = function (saved, keys) {
            return restoreApplyTo(this, saved, keys);
        };

        // A wired name made during the run: the server says which preset
        // ran, and the node shows it (its values, as it would have
        // applied a name known before the run).
        const executed = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (output) {
            const r = executed?.apply(this, arguments);
            const ran = output?.obvpm_preset_ran?.[0];
            if (typeof ran === "string" && presetWired(this)) {
                this.__obvpmRan = ran;
                const chooser = widget(this, PRESET);
                if (chooser && lookupPreset(this, ran) && selected(this) !== ran) {
                    chooser.value = ran;
                    void applyPreset(this);
                } else {
                    refreshState(this);
                }
            }
            return r;
        };

        const menu = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (_, options) {
            const r = menu?.apply(this, arguments);
            const self = this;
            options?.push({ content: "Copy Value Presets diagnostics",
                            callback: () => void copyDiagnostics(self) });
            return r;
        };

        // The catch-all. rebuild() is a string compare against the text
        // it last built from, so this costs one comparison per frame and
        // picks up every route a schema can change by -- including the
        // ones that fire no callback at all.
        const draw = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (...args) {
            void rebuild(this);
            syncConstantRow(this);
            return draw?.apply(this, args);
        };
    },
});

// While "set to constant" is on, the node's LAST field (just above the
// buttons) is `set_constant`: the name other nodes get this bundle by.
// Not the declared `set` widget itself -- widgets_values is positional
// on older frontends, so that one stays where it was declared (hidden)
// and this field, never serialized, writes through to it, which runs
// the setter's own rename handling (obvpm_constants.js asks this node to
// show the name its own way).
const CONST_ROW = "set_constant";

/** Put the field last among the fields: just above the button row. */
function placeConstantRow(node) {
    const row = widget(node, CONST_ROW);
    if (!row) return;
    node.widgets.splice(node.widgets.indexOf(row), 1);
    const bar = node.__obvpmRow?.widget;
    const at = bar ? node.widgets.indexOf(bar) : -1;
    if (at >= 0) node.widgets.splice(at, 0, row);
    else node.widgets.push(row);
}

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
                + "reads this bundle by. Turn it off in config -> Set.";
        }
        row.value = String(real.value ?? "");     // through to the surviving state
        placeConstantRow(node);
    }
    if (!app.configuringGraph && typeof node.computeSize === "function" && node.size) {
        node.setSize?.([node.size[0], node.computeSize()[1]]);
    }
    notifyVue(node);
    node.setDirtyCanvas?.(true, true);
}

/** Keep the field showing the real name (a paste can rename it). */
function syncConstantRow(node) {
    const row = widget(node, CONST_ROW);
    const real = widget(node, SET_W);
    if (row && real && row.value !== real.value
            && document.activeElement?.tagName !== "INPUT") {
        row.value = String(real.value ?? "");
    }
}

function setup(node) {
    node.__obvpmNameProxy = (show) => showConstantRow(node, show);
    for (const name of OWNED) hide(widget(node, name));
    // ... and their sockets with them. Anything genuinely wired is left
    // alone, so the schema or the preset name can still be driven from
    // elsewhere.
    dropWidgetSockets(node, OWNED);
    // The user presets go in the PROMPT while `preset` is wired, for the
    // server to select from (they live in the user's folder, which it is
    // never asked to read) -- never in the saved workflow, and not in a
    // prompt that does not need them: a prompt is embedded in every
    // output file.
    const userW = widget(node, USER_PRESETS_W);
    if (userW) {
        userW.value = "";
        userW.serializeValue = () => {
            const lib = typeIdOf(node);
            return presetWired(node) && lib ? JSON.stringify(userPresets(lib)) : "";
        };
    }

    // The preset name is a dropdown of what is stored, plus custom.
    const chooser = asDropdown(node, PRESET,
                               () => [CUSTOM, ...presetNames(node)]);
    if (chooser) {
        chooser.callback = () => { void applyPreset(node); };
    }

    const schema = widget(node, SCHEMA);
    if (schema) {
        const previous = schema.callback;
        schema.callback = function (...args) {
            const out = previous?.apply(this, args);
            void rebuild(node);
            return out;
        };
    }
    void rebuild(node);
    void loadUserPresets(typeIdOf(node));
}

/**
 * Swap a declared text widget for a combo, in place.
 *
 * In place because widgets_values is serialised by POSITION: appending a
 * replacement and leaving the original would shift every value after it.
 * (Same move as obvpm_dynamic.js's asDropdown, which does it for the
 * switch's `selected`.)
 */
function asDropdown(node, name, valuesFn) {
    const index = (node.widgets ?? []).findIndex((w) => w.name === name);
    if (index < 0) return null;
    const old = node.widgets[index];
    if (old.type === "combo") {
        old.options.values = valuesFn;
        return keepComboDefined(old);
    }
    // The old widget comes OUT before the combo goes in. Frontend 1.53
    // renames a widget added under a name the node already has ("preset"
    // -> "preset#1", ensureUniqueWidgetNames in addCustomWidget), after
    // which widget(node, PRESET) finds nothing: selected() answered
    // "custom" forever and a chosen preset changed no values (issue
    // #12). Its value is carried across by hand: with the old widget
    // gone, the store hands the combo its surviving state.
    const value = old.value ?? CUSTOM;
    node.widgets.splice(index, 1);
    const combo = keepComboDefined(node.addWidget("combo", name, value, () => {},
                                                  { values: valuesFn }));
    combo.value = value;                // through to the surviving state
    combo.serialize = true;             // this one IS declared server-side
    const appended = node.widgets.indexOf(combo);
    if (appended >= 0) node.widgets.splice(appended, 1);
    node.widgets.splice(index, 0, combo);
    return combo;
}

/**
 * Rebuild the per-field controls from the schema.
 *
 * Guarded by the text it was last built from rather than by a callback.
 * A multiline widget is a DOM textarea whose callback fires on some
 * routes and not others, and the schema also changes without any of them
 * -- a workflow load, a paste, the timeline's "load settings" writing
 * values straight in. Comparing the text is the one check that catches
 * every route, and it is a string compare against a value the draw loop
 * is reading anyway.
 */
async function rebuild(node, force) {
    if (node.__obvpmRemoved) return;                   // see onRemoved
    const schema = String(widget(node, SCHEMA)?.value ?? "");
    if (!force && node.__obvpmBuilt === schema) return;
    // A schema whose build threw is not retried from the draw loop (one
    // server request per frame); the spaced retries are forced, and an
    // edit to the schema is a new text and so a new attempt.
    if (!force && node.__obvpmFailedSchema === schema) return;
    // Likewise a node that is drawn but not in its graph (see isLive):
    // the watchdog retries it, the draw loop does not.
    if (!force && node.__obvpmNotLiveSchema === schema) return;
    if (node.__obvpmBuilding) {
        // The draw loop asks again every frame while the answer is in the
        // air. For the text already being asked about that is no news:
        // the flight answers it. Remembering it as a rerun discarded
        // every answer on a canvas that redraws each frame (a pack that
        // animates), so the node asked forever and never built (issue #12:
        // "stale: a rebuild was asked for meanwhile" on a loop).
        if (!force && schema === node.__obvpmBuildingSchema) return;
        // Not dropped: remembered, and re-run when the flight lands.
        // The call this guard used to swallow was onConfigure's -- the
        // one carrying a loaded workflow's schema and values -- while
        // onNodeCreated's build of the DEFAULT schema was in the air.
        // That stale build then wrote its `settled` set over the loaded
        // values, which is why every refresh reverted them.
        node.__obvpmRerun = Math.max(node.__obvpmRerun ?? 0, force ? 2 : 1);
        return;
    }
    node.__obvpmBuilding = true;
    node.__obvpmBuildingSchema = schema;
    node.__obvpmBuildingSince = Date.now();
    trace(node, "build", (force ? "forced" : "schema changed") + ", "
          + schema.length + " chars");
    const asked = Date.now();
    let answer;
    try {
        answer = await describe(schema);
    } finally {
        node.__obvpmBuilding = false;
        node.__obvpmBuildingSchema = null;
    }
    trace(node, "schema-answer", (Date.now() - asked) + " ms, "
          + (answer?.fields?.length ?? 0) + " fields"
          + (answer?.error ? ", error: " + answer.error : ""));
    // Deleted while we were asking? `node.graph` is not the test: a
    // graph clear (a workflow reloaded over itself, undo) fires the
    // node's removal but never unsets that reference, and the same
    // graph object is reused for the next load. A build that lands
    // after that would add its button row to a dead node -- registered
    // with the overlay, drawn at the dead node's position, and never
    // removed, because a removed node is not removed twice. That was
    // the duplicate row under a reloaded workflow (2026-09-10). The
    // graph has to still hold THIS node object.
    if (node.__obvpmRemoved) {
        // removed while asking: nothing to build and nothing to say
        trace(node, "dropped", "the node was removed while asking");
        return;
    }
    if (!isLive(node)) {
        // Not silent: a node that IS on the canvas but fails this (its
        // id answers with another node, or its graph is not the one it
        // is drawn in) would otherwise stay blank with no word why. The
        // watchdog retries it and says so on the node.
        trace(node, "not-live", liveness(node));
        node.__obvpmNotLiveSchema = schema;
        return;
    }
    node.__obvpmNotLiveSchema = null;
    const rerun = node.__obvpmRerun ?? 0;
    node.__obvpmRerun = 0;
    // An answer for text the widget no longer holds is stale: building
    // from it would be wrong, and its write-back would destroy values
    // keyed to the real schema. Discard and ask again -- BEFORE
    // __obvpmBuilt is touched, so the retry does not think it is done.
    if (String(widget(node, SCHEMA)?.value ?? "") !== schema || rerun) {
        trace(node, "stale", rerun ? "a rebuild was asked for meanwhile"
                                   : "the schema changed while asking");
        return rebuild(node, force || rerun === 2);
    }
    // Set before building so the draw loop does not start a second
    // build meanwhile -- and cleared again if the build throws, so a
    // node is never left blank for good believing it is built.
    node.__obvpmBuilt = schema;
    try {
        buildFields(node, answer);
        saveDescription(node, schema, answer);
        node.__obvpmBuildError = null;
        node.__obvpmFailedSchema = null;
        node.__obvpmFailures = 0;
        node.__obvpmProblem = null;
        node.__obvpmWatchRetried = false;
        trace(node, "built", Object.keys(node.__obvpmFieldMap ?? {}).length
              + " fields, " + (node.widgets?.length ?? 0) + " widgets");
    } catch (err) {
        node.__obvpmBuilt = null;
        node.__obvpmFailedSchema = schema;
        node.__obvpmBuildError = String(err?.message ?? err);
        node.__obvpmFailures = (node.__obvpmFailures ?? 0) + 1;
        trace(node, "build-threw", String(err?.stack ?? err));
        // A retry or two, spaced out: a load that is still settling can
        // make one build fail and the next one work. Not more: the draw
        // loop would otherwise ask the server every frame for a build
        // that fails the same way every time.
        if (node.__obvpmFailures <= 2) {
            setTimeout(() => void rebuild(node, true), 2000 * node.__obvpmFailures)
                ?.unref?.();                // node's test runner: never hold it open
        } else {
            showProblem(node, "could not build its fields: " + node.__obvpmBuildError);
        }
    }
}

/** The fields, their values and the row, from the server's answer. */
function buildFields(node, answer) {
    clearBuilt(node);
    node.__obvpmSchemaError = answer.error ?? null;
    const fields = answer.fields ?? [];
    // What the combo widgets' values() closures read -- by node and
    // name, so the closure a surviving widget state kept from an older
    // build still answers with THIS build's choices.
    node.__obvpmFieldMap = Object.fromEntries(
        fields.map((f) => [f.name, f]));

    // The names mirror, so a downstream Unbundle traces this node the
    // way it traces a Bundle (bundleNamesFor looks for a `names` widget).
    const namesWidget = widget(node, NAMES);
    if (namesWidget) namesWidget.value = fields.map((f) => f.name).join("\n");

    const stored = readJson(node, VALUES);
    const onChange = (name, value) => {
        const next = readJson(node, VALUES);
        next[name] = value;
        writeJson(node, VALUES, next);
        // Editing a value means this is no longer that preset. Said
        // plainly rather than left to be discovered: the label travels
        // in the saved workflow and into every take's metadata.
        // The label is NOT dropped. It says which preset these values
        // came from, which stays true after an edit and is what makes
        // "update" and "revert" mean anything. refreshState marks the
        // difference instead -- and never rebuilds, because replacing
        // the widget being typed into would take the caret with it.
        refreshState(node);
        // ... and the fields this one decides follow it at once
        applyVisibility(node);
    };

    let group = null;
    for (const field of fields) {
        if ((field.group ?? null) !== group) {
            group = field.group ?? null;
            if (group) headingWidget(node, group);
        }
        const held = Object.prototype.hasOwnProperty.call(stored, field.name)
            ? stored[field.name] : field.default;
        fieldWidget(node, field, held, onChange);
    }
    // Written back so the server sees exactly what is on the face --
    // including a new field's default, which the stored set did not have
    // and would otherwise only acquire when someone touched it.
    const settled = Object.create(null);
    for (const field of fields) {
        settled[field.name] =
            Object.prototype.hasOwnProperty.call(stored, field.name)
                ? stored[field.name] : field.default;
    }
    writeJson(node, VALUES, settled);

    if (answer.error) noteError(node, answer.error);
    addButtonRow(node);
    refreshState(node);
    applyVisibility(node);
    notifyVue(node);
    tell(node, "built");
}

function noteError(node, message) {
    // textContent-grade: a schema arrives inside shared workflows, so
    // its text is data. It reaches a widget label, never markup.
    const w = node.addWidget("string", "⚠ schema", String(message), () => {});
    w.value = String(message);          // through to the surviving state
    w.serialize = false;
    w[MARK] = true;
    w.disabled = true;
}

// ---------------------------------------------------------------------
// Workflow presets shared by Preset Type Id
//
// Nodes with the same Preset Type Id share their WORKFLOW presets too.
// Each keeps its own copy (the `presets` widget: the server, a node
// copied alone into another workflow and older versions all see an
// ordinary node), and every change is written to all of them. What stays
// per node: which preset is selected, and which are hidden.
// ---------------------------------------------------------------------

/** The other nodes sharing this node's workflow presets. */
function peersOf(node) {
    const id = typeIdOf(node);
    return id ? nodesUsingTypeId(id).filter((n) => n !== node) : [];
}

/** A stable text for comparing two preset sets. */
function sameSet(a, b) {
    const norm = (v) => JSON.stringify(Object.keys(v ?? {}).sort()
        .map((k) => [k, v[k]]));
    return norm(a) === norm(b);
}

function samePresets(a, b) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameSet(a[k], b[k]));
}

/**
 * Write the workflow presets to this node and every node sharing them.
 * `change` tells the others' choosers what happened to a name they may
 * have selected: {renamed: [from, to]} or {deleted: name}.
 */
function writeWorkflowPresets(node, presets, change) {
    writeJson(node, PRESETS, presets);
    for (const peer of peersOf(node)) {
        writeJson(peer, PRESETS, presets);
        const chooser = widget(peer, PRESET);
        if (chooser && change?.renamed && chooser.value === change.renamed[0]) {
            chooser.value = change.renamed[1];
        }
        if (chooser && change?.deleted && chooser.value === change.deleted) {
            chooser.value = CUSTOM;     // its values stay: they are what runs
        }
        void rebuild(peer, true);
    }
}

/**
 * A node joins a group (a Preset Type Id other nodes here already use):
 * the lists are merged. A name only one side has is simply combined; the
 * same name with the same values is one preset; the same name with
 * DIFFERENT values keeps the group's under the name, and the joining
 * node's becomes "name 2" -- with its selection moved onto it, so the
 * label still matches what the node runs. Nothing a node runs changes.
 */
function joinGroup(node) {
    const peers = peersOf(node);
    if (!peers.length) return false;
    const group = readJson(peers[0], PRESETS);
    const mine = readJson(node, PRESETS);
    if (samePresets(group, mine)) return false;
    const merged = Object.assign(Object.create(null), group);
    const chooser = widget(node, PRESET);
    for (const [name, set] of Object.entries(mine)) {
        if (!Object.prototype.hasOwnProperty.call(merged, name)) {
            merged[name] = set;
        } else if (!sameSet(merged[name], set)) {
            let n = 2;
            while (Object.prototype.hasOwnProperty.call(merged, `${name} ${n}`)) n++;
            merged[`${name} ${n}`] = set;
            if (chooser && chooser.value === name) chooser.value = `${name} ${n}`;
        }
    }
    writeWorkflowPresets(node, merged);
    void rebuild(node, true);
    return true;
}

/**
 * Where a preset lives, by its chooser label: the workflow's own store
 * (the `presets` widget) or, for a ★ label, the user presets. Both are
 * {name: {field: value}}; only reading and writing differ.
 */
function storeOf(node, label) {
    if (isUserLabel(label)) {
        const lib = typeIdOf(node);
        return {
            where: "your user presets", lib, key: bareName(label),
            read: () => Object.assign(Object.create(null), userPresets(lib)),
            write: (presets) => saveUserPresets(lib, presets),
            label: (key) => STAR + key,
        };
    }
    return {
        where: "the workflow presets", lib: "", key: label,
        read: () => readJson(node, PRESETS),
        // synchronous on purpose: a save into the workflow is done the
        // moment it returns (only the user presets' write is awaited)
        write: (presets, change) => { writeWorkflowPresets(node, presets, change); },
        label: (key) => key,
    };
}

/** After a store changed: the workflow's is a widget (rebuild picks the
 *  new list up); the user presets refresh their nodes when it is written. */
function afterStore(node, store) {
    if (store.lib) refreshState(node);
    else void rebuild(node, true);
}

async function badName(clean) {
    if (clean === CUSTOM) {
        await notice("'" + CUSTOM + "' is the name for values that are not "
                     + "a preset; pick another.");
        return true;
    }
    if (isUserLabel(clean)) {
        await notice("A preset name cannot start with '" + STAR.trim()
                     + "': that marks user presets.");
        return true;
    }
    return false;
}

// In-page dialogs, not window.prompt/confirm/alert: ComfyUI Desktop's
// Electron shell has no prompt() at all, so "save as preset" silently
// did nothing there (issue #11). See obvpm_ui.js.
async function savePreset(node, name) {
    let store;
    let clean;
    if (name) {
        // "save": into the preset that is selected, wherever it lives
        store = storeOf(node, name);
        clean = store.key;
    } else {
        // "save as": into this workflow, or -- when the node names a
        // Preset Type Id -- into the user's own presets, which every workflow
        // with that id shows
        const lib = typeIdOf(node);
        let target = "workflow";
        let chosen;
        if (lib) {
            // the name and where it goes, in one dialog
            const answer = await askTextChoice(
                "Save as a User Preset to save a preset that can be used "
                + "across workflow files. Save as a Workflow Preset to save a "
                + "preset that is stored and usable within this workflow file.",
                [{ label: "New Workflow Preset", value: "workflow" },
                 { label: "New User Preset", value: "user" }],
                { title: "Save as preset", placeholder: "preset name" });
            if (!answer) return;
            target = answer.value;
            chosen = answer.text;
        } else {
            chosen = await askText(
                "Save these values as a preset called:",
                { placeholder: "preset name", ok: "Save" });
        }
        store = target === "user" ? storeOf(node, STAR + "x") : storeOf(node, "x");
        clean = String(chosen ?? "").trim();
        if (!clean || await badName(clean)) return;
    }
    const presets = store.read();
    if (!name && Object.prototype.hasOwnProperty.call(presets, clean)
            && !(await askConfirm("Replace the preset '" + clean + "' in "
                                  + store.where + "?", { ok: "Replace" }))) {
        return;
    }
    presets[clean] = readJson(node, VALUES);
    try {
        const pending = store.write(presets);
        if (pending) await pending;
    } catch (err) {
        await notice("Could not save the preset: " + String(err?.message ?? err));
        return;
    }
    const chooser = widget(node, PRESET);
    if (chooser) chooser.value = store.label(clean);
    afterStore(node, store);
}

/**
 * Rename the selected preset, keeping its values.
 *
 * The name is the key in the store AND the chooser's value AND the
 * label a saved workflow (and every take) carries, so all three move
 * together. Renaming onto an existing name replaces that preset, after
 * asking -- the same rule as saving under a taken name.
 */
async function renamePreset(node) {
    const label = selected(node);
    if (label === CUSTOM) return;
    const store = storeOf(node, label);
    const name = store.key;
    const chosen = await askText("Rename the preset '" + name + "' to:",
                                 { value: name, ok: "Rename" });
    const clean = String(chosen ?? "").trim();
    if (!clean || clean === name || await badName(clean)) return;
    const presets = store.read();
    if (!Object.prototype.hasOwnProperty.call(presets, name)) return;
    if (Object.prototype.hasOwnProperty.call(presets, clean)
            && !(await askConfirm("Replace the preset '" + clean + "' with '"
                                  + name + "'?", { ok: "Replace" }))) {
        return;
    }
    // Rebuilt in order, so the renamed preset keeps its place rather
    // than dropping to the end (the chooser sorts anyway; the JSON is
    // what a diff of the workflow shows).
    const renamed = Object.create(null);
    for (const key of Object.keys(presets)) {
        if (key === clean) continue;    // being replaced
        renamed[key === name ? clean : key] = presets[key];
    }
    try {
        const pending = store.write(renamed, { renamed: [name, clean] });
        if (pending) await pending;
    } catch (err) {
        await notice("Could not rename the preset: " + String(err?.message ?? err));
        return;
    }
    const chooser = widget(node, PRESET);
    if (chooser) chooser.value = store.label(clean);
    afterStore(node, store);
}

async function deletePreset(node) {
    const label = selected(node);
    if (label === CUSTOM) return;
    const store = storeOf(node, label);
    if (!(await askConfirm("Delete the preset '" + store.key + "' from "
                           + store.where + "? The values stay on the node.",
                           { ok: "Delete" }))) {
        return;
    }
    const presets = store.read();
    delete presets[store.key];
    try {
        const pending = store.write(presets, { deleted: store.key });
        if (pending) await pending;
    } catch (err) {
        await notice("Could not delete the preset: " + String(err?.message ?? err));
        return;
    }
    const chooser = widget(node, PRESET);
    if (chooser) chooser.value = CUSTOM;
    afterStore(node, store);
}

/** Load the selected preset's values into the controls. */
async function applyPreset(node) {
    const name = selected(node);
    if (name === CUSTOM) {
        // The values stay where they are: switching to custom is "these
        // are mine now", not "throw them away".
        refreshState(node);
        return;
    }
    const saved = lookupPreset(node, name);
    if (!saved || typeof saved !== "object") return;
    // The preset's values, and the schema default for any field it was
    // saved without (see presetValue) -- the same reading modifiedFields
    // uses, so what "revert" puts back is exactly what "modified" was
    // measured against. Values for fields the schema no longer has are
    // left as they are: nothing displays or runs them.
    const next = Object.assign(Object.create(null), readJson(node, VALUES));
    for (const key of Object.keys(node.__obvpmFieldMap ?? {})) {
        next[key] = presetValue(node, saved, key);
    }
    for (const key of Object.keys(saved)) next[key] = saved[key];
    writeJson(node, VALUES, next);
    await rebuild(node, true);
}

// ------------------------------------------------ load settings (timeline)

// The declared widgets a take's workflow can bring back. Not `names`: it
// is rebuilt from the schema on every build.
const RESTORED = [SCHEMA, PRESET, VALUES, PRESETS, SET_W];

function storedNow(node) {
    return Object.fromEntries(RESTORED.map((n) => [n, widget(node, n)?.value]));
}

/** A widget a wire feeds (its value is dead), or one this node lacks. */
function notRestorable(node, name) {
    if (!widget(node, name)) return true;
    return (node.inputs ?? []).some(
        (s) => (s.widget?.name === name || s.name === name) && s.link != null);
}

/** "load settings" rows for this node: see value_presets_restore.js. */
function restoreRowsFor(node, saved) {
    const fields = new Set(Object.keys(node.__obvpmFieldMap ?? {}));
    return restoreRows(storedNow(node), saved ?? {}, fields,
                       (name) => notRestorable(node, name));
}

/**
 * Apply the ticked rows. The chooser's label is set WITHOUT applyPreset:
 * that would put the preset's stored values over the take's. Workflow
 * presets go through writeWorkflowPresets, so nodes sharing the Preset
 * Type Id keep the same list. One forced rebuild reads it all back.
 */
function restoreApplyTo(node, saved, keys) {
    const writes = restoreWrites(storedNow(node), saved ?? {}, keys);
    if (!Object.keys(writes).length) return false;
    if (SCHEMA in writes) widget(node, SCHEMA).value = writes[SCHEMA];
    if (PRESETS in writes) {
        let presets = null;
        try {
            presets = JSON.parse(writes[PRESETS] || "{}");
        } catch (err) { /* unreadable: stored as it came, like the load would */ }
        if (presets && typeof presets === "object") writeWorkflowPresets(node, presets);
        else widget(node, PRESETS).value = writes[PRESETS];
    }
    if (PRESET in writes) widget(node, PRESET).value = writes[PRESET];
    if (VALUES in writes) widget(node, VALUES).value = writes[VALUES];
    if (SET_W in writes) {
        const w = widget(node, SET_W);
        w.value = writes[SET_W];
        // the setter's own rename handling (obvpm_constants.js)
        w.callback?.(w.value, app.canvas, node);
    }
    trace(node, "restored", Object.keys(writes).join(", "));
    void rebuild(node, true);
    return true;
}

/**
 * Nodes 2.0 draws from a snapshot and does not re-read a node it knows,
 * so a rebuilt widget list has to be announced. Same move as
 * obvpm_dynamic.js's notifyVue, minus the slot handling -- nothing here
 * touches sockets.
 */
function notifyVue(node) {
    try {
        node.graph?.onNodeAdded?.(node);
    } catch (err) {
        /* older frontends need nothing */
    }
}

// ---------------------------------------------------------------------
// The schema editor
//
// A VIEW over the `schema` text, never a replacement for it. The text
// stays the one store, so a schema can still be pasted, diffed or
// hand-edited, and this dialog can never hold a state the text does not
// -- the same arrangement as the H3 timeline's strip over its sequence.
// Opening reads the text (through the server, so there is still only one
// parser); applying writes it back, and only after the server has agreed
// it parses.
// ---------------------------------------------------------------------

const BASIC = [
    { kind: "text", label: "text", hint: "any text" },
    { kind: "int", label: "whole number", hint: "1, 20, 200" },
    { kind: "float", label: "number", hint: "0.75, 1.0" },
    { kind: "bool", label: "true / false", hint: "a toggle" },
    { kind: "choice", label: "choice", hint: "a list you type" },
];

/**
 * The borrowable dropdowns on this install. Cached for the session.
 *
 * Cached unlike `describe`, and for the opposite reason: this answers
 * "which dropdowns exist", which changes when a pack is installed, not
 * when a file lands in a folder. The counts and samples here are for
 * recognising a list; what a field validates against is resolved fresh
 * every time the node builds.
 */
let typeCatalogue = null;

async function fetchTypes() {
    if (typeCatalogue) return typeCatalogue;
    try {
        const resp = await api.fetchApi("/obvpm/presets/types");
        typeCatalogue = (await resp.json()).types ?? [];
    } catch (err) {
        typeCatalogue = [];
    }
    return typeCatalogue;
}

/** A server-described field -> an editable row. */
function rowOf(field) {
    const ranged = field.lo != null || field.hi != null;
    return {
        name: field.name,
        // What this row was called when the dialog opened. A row is a
        // stable identity across an edit, so a changed name IS a rename
        // and needs no guessing -- see carryRenames.
        was: field.name,
        kind: field.ref ? "ref" : field.kind,
        ref: field.ref ?? "",
        arg: field.ref ? ""
            : field.kind === "choice" ? (field.choices ?? []).join(", ")
            : ranged ? (field.span || (field.lo ?? "") + ".." + (field.hi ?? ""))
            : "",
        def: field.default_text ?? "",
        when: field.when_text ?? "",
        hint: field.hint ?? "",
        group: field.group ?? "",
        on: true,
    };
}

/** A row -> the schema line it stands for. Mirrors presets.py's syntax. */
function lineOf(row) {
    const name = String(row.name ?? "").trim();
    const arg = String(row.arg ?? "").trim();
    const spec = row.kind === "ref" ? "@" + String(row.ref ?? "").trim()
        : row.kind === "choice" ? "choice " + arg
        : (row.kind === "int" || row.kind === "float")
            ? (arg ? row.kind + " " + arg : row.kind)
            : row.kind;
    const def = String(row.def ?? "").trim();
    // the tails in the order the parser takes them off: the hint LAST,
    // so it may say anything
    const when = String(row.when ?? "").trim().replace(/^when\s+/i, "");
    // ONE line: a line break in the hint would end the field there and
    // leave the rest as a line of its own that is no field at all
    const hint = String(row.hint ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();
    return name + ": " + spec + (def ? " = " + def : "")
        + (when ? " when " + when : "") + (hint ? " # " + hint : "");
}

/** The schema text the editor's rows stand for: a `## Title` line
 *  wherever the group changes (a bare `##` where a group ends). */
function schemaOf(rows) {
    const lines = [];
    let group = "";
    for (const row of rows) {
        const next = String(row.group ?? "").trim();
        if (next !== group) {
            lines.push(next ? "## " + next : "##");
            group = next;
        }
        lines.push(lineOf(row));
    }
    return lines.join("\n") + "\n";
}

function typeLabel(row) {
    if (row.kind === "ref") return row.ref || "(pick a dropdown)";
    return (BASIC.find((b) => b.kind === row.kind) ?? {}).label ?? row.kind;
}

function argHint(row) {
    if (row.kind === "int" || row.kind === "float") return "min..max";
    if (row.kind === "choice") return "a, b, c";
    return null;                        // nothing to fill in for this type
}

// ---------------------------------------------------------------------
// config: the Presets and Set pages (the Schema page is openConfig's own)
// ---------------------------------------------------------------------

function section(title, ...children) {
    const box = el("div", { display: "flex", flexDirection: "column", gap: "6px" });
    box.append(el("div", { font: "600 14px sans-serif" }, title), ...children);
    return box;
}

function hint(text) {
    // pre-line: a "\n" in the text starts a new line
    return el("div", { color: DIM, font: "12px sans-serif", whiteSpace: "pre-line" }, text);
}

function checkRow(label, checked, onChange, note) {
    const row = el("label", { display: "flex", alignItems: "center", gap: "8px",
                              cursor: "pointer" });
    const box = el("input");
    box.type = "checkbox";
    box.checked = !!checked;
    box.addEventListener("change", () => onChange(box.checked));
    row.append(box, el("span", { flex: "1" }, label));
    if (note) row.append(el("span", { color: DIM, font: "12px sans-serif" }, note));
    return row;
}

/** A dialog button that does nothing while there is nothing to act on. */
function enable(button, on) {
    button.disabled = !on;
    button.style.opacity = on ? "" : "0.45";
    button.style.cursor = on ? "pointer" : "default";
}

/**
 * Which presets an export or import takes: a tick per preset name, ticks
 * kept in `chosen`, with an "all" row above when there is more than one.
 * `note(name)` may add a dim note to a row; `onChange()` follows each tick.
 */
function pickList(names, chosen, onChange, note = () => "") {
    const list = el("div", { display: "flex", flexDirection: "column", gap: "3px",
                             maxHeight: "180px", overflowY: "auto" });
    const boxes = new Map();
    let all = null;
    const paintAll = () => {
        if (all) all.checked = chosen.size === names.length;
    };
    if (names.length > 1) {
        const row = checkRow(`all ${names.length}`, chosen.size === names.length, (on) => {
            chosen.clear();
            if (on) for (const n of names) chosen.add(n);
            for (const [n, box] of boxes) box.checked = chosen.has(n);
            onChange();
        });
        row.style.fontWeight = "600";
        all = row.querySelector("input");
        list.append(row);
    }
    for (const name of names) {
        const row = checkRow(name, chosen.has(name), (on) => {
            if (on) chosen.add(name); else chosen.delete(name);
            paintAll();
            onChange();
        }, note(name));
        boxes.set(name, row.querySelector("input"));
        list.append(row);
    }
    return list;
}

function radioRow(name, options, value, onChange) {
    const row = el("div", { display: "flex", gap: "14px", flexWrap: "wrap" });
    for (const opt of options) {
        const lab = el("label", { display: "flex", alignItems: "center", gap: "5px",
                                  cursor: "pointer" });
        const r = el("input");
        r.type = "radio";
        r.name = name;
        r.checked = opt.value === value;
        r.addEventListener("change", () => { if (r.checked) onChange(opt.value); });
        lab.append(r, el("span", {}, opt.label));
        row.append(lab);
    }
    return row;
}

/** A small pop-up over the config dialog, with its own buttons. */
function popOver(overlay, title, width, build) {
    const pop = el("div", {
        position: "fixed", inset: "0", zIndex: "10001",
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.35)",
    });
    const box = el("div", {
        background: PANEL, border: "1px solid " + EDGE,
        borderRadius: "8px", padding: "12px", width,
        display: "flex", flexDirection: "column", gap: "8px",
        boxShadow: "0 8px 40px rgba(0,0,0,0.5)", color: INK, font: TEXT,
        maxHeight: "86vh", overflowY: "auto",
    });
    box.append(el("div", { font: TITLE }, title));
    const close = () => pop.remove();
    build(box, close);
    pop.appendChild(box);
    pop.addEventListener("mousedown", (ev) => { if (ev.target === pop) close(); });
    pop.dataset.obvpmPop = "1";      // Escape closes this first
    overlay.appendChild(pop);
}

function textArea(value, minHeight) {
    const area = el("textarea", {
        background: FILL, color: INK, border: "1px solid " + EDGE,
        borderRadius: "4px", padding: "6px 8px", font: "12px monospace",
        minHeight: minHeight ?? "220px", resize: "vertical", boxSizing: "border-box",
        whiteSpace: "pre", overflowX: "auto",
    });
    area.value = value ?? "";
    area.spellcheck = false;
    return area;
}

/**
 * The Presets page: the Preset Type Id this node's user presets go by,
 * which of the workflow's presets the chooser shows, and export /
 * import. The Preset Type Id and the shown list apply with the dialog's
 * Apply; export and import act at once (each says so).
 */
function presetsPane(node, overlay, say) {
    const pane = el("div", { display: "flex", flexDirection: "column", gap: "14px",
                             overflowY: "auto", padding: "2px" });
    let typeId = typeIdOf(node) || String(node.properties?.[TYPE_ID_PROP] ?? "");
    const hidden = hiddenPresets(node);

    // -- user presets: the Preset Type Id
    const typeIdStatus = hint("");
    // the user presets, each with a checkbox like the workflow presets
    // below (hidden per node; kept in the same list, by their ★ labels)
    const userList = el("div", { display: "flex", flexDirection: "column", gap: "3px" });
    let listed = [];
    const paintStatus = async () => {
        const lib = cleanTypeId(typeId);
        userList.replaceChildren();
        listed = [];
        if (!typeId.trim()) {
            typeIdStatus.textContent = "No Preset Type Id: 'save as' saves workflow presets only.";
            return;
        }
        if (!lib) {
            typeIdStatus.textContent = "Use letters, digits, spaces, - _ or . (up to 64).";
            return;
        }
        const presets = await loadUserPresets(lib);
        if (cleanTypeId(typeId) !== lib) return;      // typed on meanwhile
        const err = userPresetsError(lib);
        const names = Object.keys(presets).sort((a, b) => a.localeCompare(b));
        typeIdStatus.textContent = err ? err
            : names.length ? "" : `No user presets in '${lib}' yet.`;
        typeIdStatus.style.display = typeIdStatus.textContent ? "" : "none";
        for (const name of names) {
            const label = STAR + name;
            listed.push(label);
            userList.append(checkRow(name, !hidden.has(label),
                (on) => { if (on) hidden.delete(label); else hidden.add(label); },
                label === selected(node) ? "selected now" : ""));
        }
    };
    const typeIdBox = textBox(typeId, "e.g. obvpm-h3-generation-engine",
                           (v) => { typeId = v; void paintStatus(); }, "260px");
    pane.append(section("Preset Type Id",
        hint("Any Value Presets node with the same Preset Type Id will "
             + "share presets."),
        typeIdBox));
    pane.append(section("User Presets",
        hint("User presets are saved in the ComfyUI user folder at "
             + "user/default/obvpm/presets/<preset-type-id>/, one file per preset.\n"
             + "This allows using the same user presets across workflow "
             + "files. Uncheck presets to hide them from the selection "
             + "dropdown."),
        typeIdStatus, userList));
    void paintStatus();

    // -- the workflow's presets: shown or hidden in the chooser
    const own = Object.keys(readJson(node, PRESETS)).sort((a, b) => a.localeCompare(b));
    const ownList = el("div", { display: "flex", flexDirection: "column", gap: "3px" });
    if (!own.length) ownList.append(hint("This workflow has no presets of its own."));
    for (const name of own) {
        ownList.append(checkRow(name, !hidden.has(name),
            (on) => { if (on) hidden.delete(name); else hidden.add(name); },
            name === selected(node) ? "selected now" : ""));
    }
    const peers = peersOf(node);
    const drifted = peers.filter((n) => !samePresets(readJson(n, PRESETS), readJson(node, PRESETS)));
    const shared = el("div", { display: "flex", flexDirection: "column", gap: "4px" });
    if (peers.length) {
        shared.append(hint(peers.length === 1
            ? "Shared with 1 other node with this Preset Type Id."
            : `Shared with ${peers.length} other nodes with this Preset Type Id.`));
    }
    if (drifted.length) {
        const syncBtn = pushButton("Sync from this node", () => {
            writeWorkflowPresets(node, readJson(node, PRESETS));
            syncBtn.disabled = true;
            say("The other nodes now have this node's workflow presets.");
        });
        shared.append(el("div", { color: "#e8b86b", font: "12px sans-serif" },
            `${drifted.length} of them ${drifted.length === 1 ? "has" : "have"} `
            + "different workflow presets (edited elsewhere, or by an older "
            + "version)."), syncBtn);
        syncBtn.style.alignSelf = "flex-start";
    }
    pane.append(section("Workflow Presets",
        hint("Workflow presets are saved in the workflow file. Uncheck "
             + "presets to hide them from the selection dropdown."),
        shared,
        ownList));

    // -- export / import
    const exportBtn = pushButton("Export…", () => popOver(overlay, "Export a preset",
        "min(700px, 92vw)", (box, close) => {
            const lib = cleanTypeId(typeId);
            // every preset there is to send, the user's own first (they
            // are what people share); one is picked, and that one goes
            const byName = (a, b) => a.localeCompare(b);
            const mine = lib ? userPresets(lib) : Object.create(null);
            const flow = readJson(node, PRESETS);
            const entries = [
                ...Object.keys(mine).sort(byName).map((name) => ({
                    label: STAR + name, name, values: mine[name], where: "user preset" })),
                ...Object.keys(flow).sort(byName).map((name) => ({
                    label: name, name, values: flow[name], where: "workflow preset" })),
            ];
            // the node's own preset when it is one of them
            let pick = entries.find((x) => x.label === selected(node)) ?? entries[0] ?? null;
            const area = textArea("");
            area.readOnly = true;
            const copyBtn = pushButton("Copy", async () => {
                try {
                    await navigator.clipboard.writeText(area.value);
                    say(`Copied the preset '${pick.name}'.`);
                } catch (err) {
                    area.select();
                    say("Select the text and copy it (the clipboard is not available here).");
                }
            });
            const downloadBtn = pushButton("Download", () => {
                download(exportFileName(pick.name), area.value);
            }, { fontWeight: "600" });
            const paint = () => {
                area.value = pick ? presetFileText({ typeId: lib, name: pick.name,
                                                     values: pick.values }) : "";
                enable(copyBtn, !!pick);
                enable(downloadBtn, !!pick);
            };
            const list = el("div", { display: "flex", flexDirection: "column", gap: "3px",
                                     maxHeight: "220px", overflowY: "auto" });
            for (const x of entries) {
                const row = el("label", { display: "flex", alignItems: "center", gap: "8px",
                                          cursor: "pointer" });
                const r = el("input");
                r.type = "radio";
                r.name = "obvpm-export-pick";
                r.checked = x === pick;
                r.addEventListener("change", () => { if (r.checked) { pick = x; paint(); } });
                row.append(r, el("span", { flex: "1" }, x.label),
                           el("span", { color: DIM, font: "12px sans-serif" }, x.where));
                list.append(row);
            }
            box.append(
                entries.length ? list : hint("There are no presets here to export."),
                area,
                hint("One preset per file. Send this text or the file to someone: "
                     + "they import it on their Value Presets node (config → Presets "
                     + "→ Import). It is the same file as in the user presets folder"
                     + (lib ? " (user/default/obvpm/presets/" + lib + "/)" : "")
                     + ", so it can also be dropped in there. To move all your user "
                     + "presets at once, copy that folder."));
            const row = el("div", { display: "flex", gap: "6px", justifyContent: "flex-end" });
            row.append(pushButton("Close", close), copyBtn, downloadBtn);
            box.append(row);
            paint();
        }));
    const importBtn = pushButton("Import…", () => popOver(overlay, "Import presets",
        "min(700px, 92vw)", (box, close) => {
            const lib = cleanTypeId(typeId);
            let into = "workflow";
            let mode = "keep";
            const area = textArea("", "180px");
            area.placeholder = "Paste an exported preset here, or open preset files.";
            const status = el("div", { color: "#e88", whiteSpace: "pre-wrap" });
            // what the text holds, and which of its presets come in: all
            // at first, or only the one wanted from a shared file
            let got = null;
            let names = [];
            const chosen = new Set();
            const picks = el("div");
            const target = () => (into === "user" && lib ? userPresets(lib)
                                                        : readJson(node, PRESETS));
            const importBtn = pushButton("Import", async () => {
                if (!got || !chosen.size) return;
                const incoming = pickPresets(got.presets, names.filter((n) => chosen.has(n)));
                try {
                    if (into === "user" && lib) {
                        const merged = mergePresets(userPresets(lib), incoming, mode);
                        await saveUserPresets(lib, merged.presets);
                        say(`Imported ${merged.added.length} preset(s) into your user presets ('${lib}').`);
                    } else {
                        const merged = mergePresets(readJson(node, PRESETS), incoming, mode);
                        writeWorkflowPresets(node, merged.presets);
                        say(`Imported ${merged.added.length} preset(s) into the workflow presets.`);
                        void rebuild(node, true);
                    }
                } catch (err) {
                    status.textContent = "Could not import: " + String(err?.message ?? err);
                    return;
                }
                close();
            }, { fontWeight: "600" });
            const paintPicks = () => {
                const there = target();
                picks.replaceChildren(names.length ? pickList(names, chosen,
                    () => enable(importBtn, chosen.size > 0),
                    (n) => (Object.prototype.hasOwnProperty.call(there, n)
                        ? "already there" : "")) : "");
                enable(importBtn, chosen.size > 0);
            };
            // the files opened, as [name, text]: read instead of the box
            // while the box is empty (typing in it drops them)
            let opened = [];
            const read = () => {
                got = null;
                names = [];
                chosen.clear();
                status.textContent = "";
                const texts = area.value.trim() ? [["the text", area.value]] : opened;
                if (texts.length) {
                    const r = parseImports(texts);
                    if (r.errors.length) status.textContent = r.errors.join("\n");
                    if (Object.keys(r.presets).length) got = r;
                }
                if (got) {
                    names = Object.keys(got.presets).sort((a, b) => a.localeCompare(b));
                    for (const n of names) chosen.add(n);
                }
                paintPicks();
            };
            area.addEventListener("input", () => { opened = []; read(); });
            const file = el("input");
            file.type = "file";
            file.multiple = true;
            file.accept = ".json,application/json";
            file.addEventListener("change", async () => {
                const picked = [...(file.files ?? [])].slice(0, 200);
                if (!picked.length) return;
                opened = [];
                for (const f of picked) {
                    opened.push([f.name, f.size > 1024 * 1024 ? "" : await f.text()]);
                }
                // one file shows in the box; several are listed below it
                area.value = opened.length === 1 ? opened[0][1] : "";
                if (opened.length === 1) opened = [];
                read();
            });
            box.append(
                area, file, picks,
                el("div", {}, "Into:"),
                radioRow("obvpm-import-into", [
                    { label: "workflow presets", value: "workflow" },
                    ...(lib ? [{ label: "user presets ('" + lib + "')", value: "user" }] : []),
                ], into, (v) => { into = v; paintPicks(); }),
                el("div", {}, "A preset with a name that is already there:"),
                radioRow("obvpm-import-mode", [
                    { label: "keep both (the new one is renamed)", value: "keep" },
                    { label: "replace it", value: "replace" },
                ], mode, (v) => { mode = v; }),
                hint("Only the ticked presets are imported, at once. Presets are "
                     + "matched to fields by name: a field this node lacks is "
                     + "ignored, one the preset lacks takes its default."),
                status);
            const row = el("div", { display: "flex", gap: "6px", justifyContent: "flex-end" });
            row.append(pushButton("Cancel", close), importBtn);
            box.append(row);
            read();
        }));
    const buttons = el("div", { display: "flex", gap: "6px" });
    buttons.append(exportBtn, importBtn);
    pane.append(section("Export / import",
        hint("Share a preset or move it between workflows: export copies or "
             + "downloads one preset as a small file; import takes preset files "
             + "in -- several at once, or the presets you tick of an older "
             + "export that holds many."),
        buttons));

    return {
        element: pane,
        // the id as typed on this page, for the Filters page
        typeId: () => cleanTypeId(String(typeId ?? "").trim()),
        async apply() {
            const typed = String(typeId ?? "").trim();
            const lib = cleanTypeId(typed);
            if (typed && !lib) {
                return "The Preset Type Id can only use letters, digits, spaces, - _ or .";
            }
            node.properties ??= {};
            const before = typeIdOf(node);
            if (lib) node.properties[TYPE_ID_PROP] = lib;
            else delete node.properties[TYPE_ID_PROP];
            if (lib && lib !== before) joinGroup(node);
            // workflow presets this node has, and the user presets listed
            // for the id being applied
            const keep = [...hidden].filter((n) => own.includes(n)
                || (isUserLabel(n) && listed.includes(n)));
            if (keep.length) node.properties[HIDDEN_PROP] = keep;
            else delete node.properties[HIDDEN_PROP];
            if (lib) await loadUserPresets(lib);
            return null;
        },
    };
}

/**
 * The Filters page: the user's own short list of each dropdown field --
 * include and exclude patterns per field, kept with the user presets of
 * the Preset Type Id (value_presets_filter.js says what they do and do
 * not do). `typeIdOf()` is the id as the Presets page has it now, so a
 * newly typed id is the one filtered.
 */
function filtersPane(fields, typeIdOf) {
    const pane = el("div", { display: "flex", flexDirection: "column", gap: "10px",
                             overflowY: "auto", padding: "2px", minHeight: "0" });
    const listable = (fields ?? []).filter((f) => Array.isArray(f.choices) && f.choices.length);
    pane.append(section("Dropdown filters",
        hint("Hide the dropdown entries you do not use. A field lists the entries "
             + "that match ANY include line (all of them when there is none) and NO "
             + "exclude line. One pattern per line: it matches anywhere in the "
             + "entry, ignoring case; * stands for anything, and \\ and / are the "
             + "same (h3/ matches a folder).\n"
             + "Only the dropdown changes: presets and runs still take every entry, "
             + "and the value a field holds is always listed. The filters are "
             + "yours, kept with your user presets, so every node with this "
             + "Preset Type Id uses them, in every workflow.")));
    const body = el("div", { display: "flex", flexDirection: "column", gap: "6px" });
    pane.append(body);

    let lib = null;         // the id the page was drawn for
    let draft = null;       // {field: {include: text, exclude: text}}
    let read = "";          // the draft as it was read, to see a change
    const keyOf = (d) => JSON.stringify(Object.entries(d ?? {}).map(([k, v]) =>
        [k, patternsFrom(v.include), patternsFrom(v.exclude)]));

    const COLS = "150px minmax(0, 1fr) minmax(0, 1fr) 120px";
    function rowOfField(f) {
        const d = draft[f.name];
        const line = el("div", { display: "grid", gridTemplateColumns: COLS, gap: "6px",
                                 alignItems: "start" });
        const name = el("div", { padding: "5px 0", overflow: "hidden", textOverflow: "ellipsis",
                                 whiteSpace: "nowrap" }, f.name);
        name.title = f.name;
        const box = (key, placeholder) => {
            const area = textArea(d[key], "44px");
            area.rows = 2;
            area.placeholder = placeholder;
            area.addEventListener("input", () => { d[key] = area.value; paintCount(); });
            return area;
        };
        const count = el("div", { padding: "5px 0", font: "12px sans-serif" });
        const preview = el("div", {
            gridColumn: "2 / 5", display: "none", color: DIM, font: "12px monospace",
            whiteSpace: "pre", overflow: "auto", maxHeight: "140px",
            border: "1px solid " + EDGE, borderRadius: "4px", padding: "4px 8px",
        });
        const toggle = el("span", { color: DIM, cursor: "pointer", textDecoration: "underline",
                                    marginLeft: "6px" }, "list");
        toggle.addEventListener("click", () => {
            preview.style.display = preview.style.display === "none" ? "block" : "none";
            paintCount();
        });
        const said = el("span");
        count.append(said, toggle);
        function paintCount() {
            const r = filterChoices(f.choices, {
                include: patternsFrom(d.include), exclude: patternsFrom(d.exclude) });
            said.textContent = r.ignored ? "matches none: all " + r.total
                : r.shown + " of " + r.total;
            said.style.color = r.ignored ? "#e8a86c" : (r.shown < r.total ? INK : DIM);
            said.title = r.ignored
                ? "No entry passes, so the filter is not applied: the dropdown lists all."
                : "";
            if (preview.style.display !== "none") preview.textContent = r.choices.join("\n");
        }
        paintCount();
        line.append(name, box("include", "all"), box("exclude", "none"), count, preview);
        return line;
    }

    async function refresh() {
        const id = typeIdOf();
        if (draft && id === lib) return;
        lib = id;
        draft = null;
        body.replaceChildren();
        if (!listable.length) {
            body.append(hint("This schema has no dropdown fields."));
            return;
        }
        if (!id) {
            body.append(hint("The filters are kept with your user presets, so they "
                             + "need a Preset Type Id: set one on the Presets page."));
            return;
        }
        body.append(hint("Loading ..."));
        await loadUserPresets(id);
        if (typeIdOf() !== id || lib !== id) return;    // changed meanwhile
        body.replaceChildren();
        const problem = userPresetsError(id);
        if (problem) {
            body.append(hint(problem + " -- the filters cannot be changed until it can be read."));
            return;
        }
        const stored = userFilters(id);
        draft = Object.create(null);
        for (const f of listable) {
            draft[f.name] = { include: (stored[f.name]?.include ?? []).join("\n"),
                              exclude: (stored[f.name]?.exclude ?? []).join("\n") };
        }
        read = keyOf(draft);
        const head = el("div", { display: "grid", gridTemplateColumns: COLS, gap: "6px",
                                 color: DIM, font: "12px sans-serif" });
        for (const label of ["field", "include (any of)", "exclude", "listed"]) {
            head.append(el("div", {}, label));
        }
        body.append(head, ...listable.map(rowOfField),
                    hint("Saved in user/default/obvpm/presets/" + id + ".json (beside "
                         + "the folder of your user presets), on Apply."));
    }

    return {
        element: pane,
        refresh,
        async apply() {
            if (!draft || keyOf(draft) === read) return null;
            if (lib !== typeIdOf()) {
                return "The Preset Type Id changed after the filters were edited: "
                    + "look at the Filters page again, then Apply.";
            }
            // the fields of this schema as edited; any other field's
            // filters (another schema under the same id) are kept
            const next = Object.assign(Object.create(null), userFilters(lib));
            for (const [field, d] of Object.entries(draft)) {
                next[field] = { include: patternsFrom(d.include), exclude: patternsFrom(d.exclude) };
            }
            try {
                await saveUserFilters(lib, filtersFrom(next));
            } catch (err) {
                return "The filters were not saved: " + String(err?.message ?? err);
            }
            read = keyOf(draft);
            app.graph?.setDirtyCanvas?.(true, true);
            return null;
        },
    };
}

/**
 * The Set page: hand this node's bundle to others BY NAME, the way a
 * Bundle's "set" does -- an Unbundle with "get", or a KJNodes Get, reads
 * it without a wire.
 */
/** A starting name for the constant, from the node's title. */
function constantNameFrom(node) {
    // the pack suffix every obvpm node's title carries is not part of a name
    const slug = String(node.title ?? "").replace(/\s*\(obvpm\)\s*$/i, "").toLowerCase()
        .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return slug || "presets";
}

function setPane(node) {
    const pane = el("div", { display: "flex", flexDirection: "column", gap: "10px",
                             padding: "2px" });
    const w = widget(node, SET_W);
    let on = constantOn(node);
    pane.append(
        section("Set to constant",
            hint("On, this node's bundle is a constant: an Unbundle with "
                 + "'get' (its config) or a KJNodes Get reads it by NAME, "
                 + "without a wire, anywhere in this graph and the subgraphs "
                 + "inside it -- the same as a Bundle's 'set'. The name is "
                 + "the node's set_constant field, its last one; set or "
                 + "change it there."),
            checkRow("set this bundle to a constant", on, (v) => { on = v; })));
    if (!w) {
        pane.append(hint("This node has no name field yet: update "
                         + "comfyui-obvpm and restart ComfyUI (a node added "
                         + "before the update may need to be added again)."));
    }
    return {
        element: pane,
        apply() {
            if (!w) return null;
            if (on && !constantOn(node)) {
                // a name to start from; the node's field changes it, and
                // setMode makes it unique among the setters in scope
                if (!String(w.value ?? "").trim()) w.value = constantNameFrom(node);
                setMode(node, true);
            } else if (!on && constantOn(node)) {
                setMode(node, false);
            }
            return null;
        },
    };
}

async function openConfig(node, tab = "presets") {
    const answer = await describe(widget(node, SCHEMA)?.value ?? "");
    const off = disabledFields(node);
    const rows = (answer.fields ?? []).map((f) => ({ ...rowOf(f), on: !off.has(f.name) }));

    // wider than the kit's default: a row is name, type, range,
    // default, condition and hint, and wrapping them would lose the
    // column-per-part reading that makes the dialog a table
    const { overlay, panel, close } = openOverlay("min(1180px, 96vw)");

    const title = el("div", { display: "flex", alignItems: "center", gap: "6px" });
    title.append(el("div", { font: TITLE, marginRight: "12px" }, "Config"));
    const columns = el("div", {
        display: "flex", gap: "5px", color: DIM, font: "12px sans-serif",
        padding: "0 2px",
    });
    for (const [label, width] of [["", "77px"], ["on", "22px"], ["group", "100px"],
                                  ["name", "150px"],
                                  ["type", "200px"], ["range / choices", "160px"],
                                  ["default", "110px"], ["shown when", "160px"],
                                  ["tooltip", "160px"]]) {
        // the last column takes what is left, so the rows end at the
        // panel's edge and the ✕ lines up under Apply
        const flex = label === "tooltip" ? "1 1 " + width : "0 0 " + width;
        columns.appendChild(el("div", { flex, overflow: "hidden" }, label));
    }
    const list = el("div", {
        display: "flex", flexDirection: "column", gap: "4px",
        overflowY: "auto", padding: "4px 2px",
    });
    const error = el("div", {
        color: "#e88", whiteSpace: "pre-wrap", display: "none",
    });

    // The row last worked in: "+ add field" puts the new field under it
    // (in its group), not at the end of a long list (issue #19).
    let lastRow = -1;
    list.addEventListener("focusin", (ev) => {
        const at = ev.target.closest?.("[data-obvpm-row]");
        if (at) lastRow = Number(at.dataset.obvpmRow);
    });
    const groupKey = (row) => String(row?.group ?? "").trim();

    function draw() {
        list.replaceChildren();
        rows.forEach((row, index) => list.appendChild(drawRow(row, index)));
        if (!rows.length) {
            list.appendChild(el("div", { color: DIM, padding: "8px 2px" },
                                "No fields yet."));
        }
        if (lastRow >= rows.length) lastRow = rows.length - 1;
        // Drag by the grip, Alt+Up/Down; with Shift, the field's whole
        // group (issue #19). A single field dropped INSIDE another group
        // -- the fields above and below it share one -- joins it: a
        // field moved up into the second group is meant to be in it,
        // and keeping its own would split that group in two headings.
        sortableRows(list, {
            rows, redraw: draw, groupOf: groupKey,
            afterMove: (moved) => {
                if (moved.length !== 1) return;
                const i = rows.indexOf(moved[0]);
                const above = rows[i - 1], below = rows[i + 1];
                if (above && below && groupKey(above) === groupKey(below)
                        && groupKey(moved[0]) !== groupKey(above)) {
                    moved[0].group = above.group;
                }
            },
        });
    }

    function drawRow(row, index) {
        const line = markRow(el("div", {
            display: "flex", gap: "5px", alignItems: "center",
        }), index);
        const move = (by) => {
            const to = index + by;
            if (to < 0 || to >= rows.length) return;
            rows.splice(to, 0, rows.splice(index, 1)[0]);
            draw();
        };
        // `on`: whether THIS node uses the field. The schema stays the
        // same for every node sharing it; a field switched off here is
        // hidden here and None on this node's bundle.
        const on = el("input", { flex: "0 0 22px", margin: "0" });
        on.type = "checkbox";
        on.checked = row.on !== false;
        on.title = "Use this field on this node. Off: hidden here and None on "
            + "this node's bundle; the schema (and every other node using it) "
            + "is unchanged.";
        on.addEventListener("change", () => { row.on = on.checked; });
        const group = textBox(row.group, "group", (v) => { row.group = v; }, "100px");
        group.title = "A heading on the node over this field and the ones "
            + "after it with the same group (a `## group` line in the schema).";
        line.append(
            gripHandle("Drag to move this field; Shift-drag moves its whole "
                       + "group. Alt+\u2191/\u2193 moves the field you are typing in "
                       + "(Alt+Shift: its group)."),
            pushButton("▲", () => move(-1), { padding: "1px 5px" }),
            pushButton("▼", () => move(1), { padding: "1px 5px" }),
            on,
            group,
            textBox(row.name, "name", (v) => { row.name = v; }, "150px"),
            pushButton(typeLabel(row), () => openTypePicker(row, draw),
                       { flex: "0 0 200px", overflow: "hidden",
                         textOverflow: "ellipsis", textAlign: "left" }),
        );
        const hint = argHint(row);
        if (hint) {
            line.appendChild(textBox(row.arg, hint, (v) => { row.arg = v; },
                                     "160px"));
        } else {
            // the column is held open, so the rows do not jag as types
            // change under each other
            line.appendChild(el("div", { flex: "0 0 160px" }));
        }
        // The condition is typed, not picked: `field = a, b` is short,
        // the server checks it on Apply and names the line when it is
        // wrong, and a three-part picker (field, operator, values)
        // would be the one part of this dialog wider than the text it
        // stands for.
        const when = textBox(row.when, "field = value", (v) => { row.when = v; },
                             "160px");
        when.title = "Show this field only while a choice or true/false "
            + "field above it holds one of these values: turbo = on, or "
            + "turbo != off, or mode = a, b. Hidden, its value on the "
            + "bundle is None.";
        // The tooltip: a box in the row for a few words, and a button
        // that opens it in a larger one -- a sentence or two does not
        // fit 160px, and editing text you cannot see is guesswork.
        // Joined to the box as one control: the box loses its right
        // corners, the pencil its left ones and the border between.
        const tip = textBox(row.hint, "tooltip", (v) => { row.hint = v; },
                            "100%");
        Object.assign(tip.style, { flex: "1 1 auto",
                                   borderRadius: "4px 0 0 4px" });
        const pencil = pushButton("✎", () => openTooltipEditor(row, tip), {
            padding: "1px 7px", borderRadius: "0 4px 4px 0",
            borderLeft: "none", flex: "0 0 auto",
        });
        pencil.title = "Edit the tooltip in a larger box";
        const tipGroup = el("div", { display: "flex", flex: "1 1 160px",
                                     minWidth: "0" });
        tipGroup.append(tip, pencil);
        line.append(
            textBox(row.def, "default", (v) => { row.def = v; }, "110px"),
            when,
            tipGroup,
            pushButton("✕", () => { rows.splice(index, 1); draw(); },
                       { padding: "1px 6px" }),
        );
        return line;
    }

    /**
     * The tooltip in a multiline box. Line breaks are folded to spaces
     * on the way back: the schema keeps one field per line, so the text
     * after `#` cannot hold a newline (the widget's tooltip wraps on
     * its own).
     */
    function openTooltipEditor(row, box) {
        const pop = el("div", {
            position: "fixed", inset: "0", zIndex: "10001",
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.35)",
        });
        const card = el("div", {
            background: PANEL, border: "1px solid " + EDGE,
            borderRadius: "8px", padding: "12px", width: "min(560px, 92vw)",
            display: "flex", flexDirection: "column", gap: "6px",
            boxShadow: "0 8px 40px rgba(0,0,0,0.5)", color: INK, font: TEXT,
        });
        const area = el("textarea", {
            background: FILL, color: INK, border: "1px solid " + EDGE,
            borderRadius: "4px", padding: "6px 8px", font: TEXT,
            minHeight: "120px", resize: "vertical", boxSizing: "border-box",
        });
        area.value = String(row.hint ?? "");
        area.placeholder = "Shown when hovering over the field";
        const buttons = el("div", { display: "flex", gap: "6px",
                                    justifyContent: "flex-end" });
        const accept = () => {
            row.hint = area.value.replace(/\s*\n\s*/g, " ").trim();
            box.value = row.hint;
            pop.remove();
        };
        buttons.append(
            pushButton("Cancel", () => pop.remove()),
            pushButton("OK", accept, { fontWeight: "600" }));
        card.append(el("div", { font: TITLE },
                       "Tooltip for " + (String(row.name ?? "").trim()
                                         || "this field")),
                    area, buttons);
        pop.appendChild(card);
        pop.addEventListener("mousedown", (ev) => {
            if (ev.target === pop) pop.remove();
        });
        pop.dataset.obvpmPop = "1";      // Escape closes this first
        overlay.appendChild(pop);
        area.focus();
    }

    /** The type picker: the basics, then every dropdown on the machine. */
    function openTypePicker(row, redraw) {
        const pop = el("div", {
            position: "fixed", inset: "0", zIndex: "10001",
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.35)",
        });
        const box = el("div", {
            background: PANEL, border: "1px solid " + EDGE,
            borderRadius: "8px", padding: "12px", width: "min(720px, 92vw)",
            maxHeight: "74vh", display: "flex", flexDirection: "column",
            gap: "6px", boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
            // set here, not inherited: this panel hangs off the overlay
            // rather than the dialog, so without it the picker takes the
            // PAGE's type and comes out a different size to its parent
            color: INK, font: TEXT,
        });
        pop.appendChild(box);
        pop.addEventListener("mousedown", (ev) => {
            if (ev.target === pop) pop.remove();
        });
        const search = textBox("", "search types and dropdowns…",
                               () => void paint(), "100%");
        const results = el("div", {
            display: "flex", flexDirection: "column", gap: "1px",
            overflowY: "auto",
        });
        box.append(el("div", { font: TITLE }, "Field type"),
                   search, results);
        pop.dataset.obvpmPop = "1";      // Escape closes this first
        overlay.appendChild(pop);
        search.focus();

        const choose = (apply) => {
            apply();
            pop.remove();
            redraw();
        };
        const entry = (label, detail, apply, foreign) => {
            const item = el("div", {
                display: "flex", gap: "8px", alignItems: "baseline",
                padding: "5px 7px", borderRadius: "4px", cursor: "pointer",
            });
            item.append(
                el("span", { color: INK, flex: "0 0 auto" }, label),
                el("span", { color: foreign ? "#d9a35c" : DIM,
                             overflow: "hidden", textOverflow: "ellipsis",
                             whiteSpace: "nowrap" }, detail));
            item.addEventListener("mouseenter",
                                  () => { item.style.background = FILL; });
            item.addEventListener("mouseleave",
                                  () => { item.style.background = "none"; });
            item.addEventListener("click", () => choose(apply));
            return item;
        };

        async function paint() {
            const query = search.value.trim().toLowerCase();
            results.replaceChildren();
            results.appendChild(
                el("div", { color: DIM, padding: "4px 6px" }, "Primitives"));
            for (const basic of BASIC) {
                const hay = (basic.kind + " " + basic.label).toLowerCase();
                if (query && !hay.includes(query)) continue;
                results.appendChild(entry(basic.label, basic.hint, () => {
                    row.kind = basic.kind;
                    row.ref = "";
                    if (!argHint({ kind: basic.kind })) row.arg = "";
                }));
            }
            const types = await fetchTypes();
            results.appendChild(el(
                "div", { color: DIM, padding: "10px 6px 4px" },
                "Use a dropdown type from a node"));
            let shown = 0;
            let group = null;
            for (const type of types) {
                const address = type.node + "." + type.input;
                const hay = (address + " " + type.pack).toLowerCase();
                if (query && !hay.includes(query)) continue;
                // the list runs to hundreds on a full install; the search
                // box is the way through it, not a longer scroll
                if (++shown > 200) break;
                // the server sorts by pack (this one, core, the rest), so
                // a header whenever the pack changes groups the list
                if (type.pack !== group) {
                    group = type.pack;
                    results.appendChild(el(
                        "div", { color: DIM, font: "11px sans-serif",
                                 padding: "8px 6px 2px", opacity: "0.8" },
                        type.pack));
                }
                const detail = type.count + " choices — "
                    + type.sample.join(", ")
                    + (type.mine || type.core ? ""
                       : "    ⚠ from " + type.pack + ", so this "
                         + "schema needs that pack installed");
                results.appendChild(entry(
                    type.node + " · " + type.input, detail,
                    () => {
                        row.kind = "ref";
                        row.ref = address;
                        row.arg = "";
                    },
                    !type.mine));
            }
            if (!shown) {
                results.appendChild(el(
                    "div", { color: DIM, padding: "4px 6px" },
                    "No dropdown matches that."));
            }
        }
        void paint();
    }

    /** Rows whose name changed while the dialog was open. */
    function renamesIn(list) {
        return list
            .filter((row) => row.was && String(row.name ?? "").trim()
                    && String(row.name).trim() !== row.was)
            .map((row) => [row.was, String(row.name).trim()]);
    }

    const footer = el("div", {
        display: "flex", gap: "6px", justifyContent: "flex-end",
        paddingTop: "4px",
    });
    const note = el("div", { color: DIM, alignSelf: "center",
                             marginRight: "auto" });
    const say = (text) => { note.textContent = text; };

    /**
     * Replace the rows with schema TEXT -- IN THE DIALOG. Nothing
     * reaches the node until Apply, so the edit can still be cancelled,
     * and it goes through the server first like every other edit: a
     * schema that does not parse is reported, not loaded half-way.
     */
    async function useText(text) {
        const check = await describe(text);
        if (check.error) {
            error.textContent = check.error;
            error.style.display = "block";
            return false;
        }
        error.style.display = "none";
        // fresh identities: nothing here is a rename of a row that was
        // open, so no stored value is carried onto a retyped name
        rows.splice(0, rows.length,
                    ...(check.fields ?? []).map((f) => ({ ...rowOf(f), was: "",
                                                          on: !off.has(f.name) })));
        draw();
        say((check.fields ?? []).length + " field(s) -- Apply to keep them.");
        return true;
    }

    /**
     * The schema as text, editable. The rows are a view over this text
     * (see the section comment above); this is the text itself, for
     * what a row per field is bad at -- pasting a whole schema in,
     * copying one out, or writing several lines at once.
     */
    function openTextEditor() {
        const pop = el("div", {
            position: "fixed", inset: "0", zIndex: "10001",
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.35)",
        });
        const box = el("div", {
            background: PANEL, border: "1px solid " + EDGE,
            borderRadius: "8px", padding: "12px", width: "min(760px, 92vw)",
            display: "flex", flexDirection: "column", gap: "6px",
            boxShadow: "0 8px 40px rgba(0,0,0,0.5)", color: INK, font: TEXT,
        });
        const area = el("textarea", {
            background: FILL, color: INK, border: "1px solid " + EDGE,
            borderRadius: "4px", padding: "6px 8px", font: "13px monospace",
            minHeight: "260px", resize: "vertical", boxSizing: "border-box",
            whiteSpace: "pre", overflowWrap: "normal", overflowX: "auto",
        });
        area.value = schemaOf(rows);
        area.placeholder = "name: type [range] [= default] [when field = value] [# tooltip]";
        area.spellcheck = false;
        const legend = el("div", { color: DIM, font: "12px sans-serif" },
            "One field per line: name: type [range or choices] [= default] "
            + "[when field = value] [# tooltip]. Types: text, int, float, bool, "
            + "choice a, b, c, @Node.input. A line `## Title` puts a heading over "
            + "the fields below it; other lines starting with # are comments.");
        const buttons = el("div", { display: "flex", gap: "6px",
                                    justifyContent: "flex-end" });
        buttons.append(
            pushButton("Cancel", () => pop.remove()),
            pushButton("Use this schema", async () => {
                if (await useText(area.value)) pop.remove();
            }, { fontWeight: "600" }));
        box.append(el("div", { font: TITLE }, "Schema as text"), legend, area,
                   buttons);
        pop.appendChild(box);
        pop.addEventListener("mousedown", (ev) => {
            if (ev.target === pop) pop.remove();
        });
        pop.dataset.obvpmPop = "1";      // Escape closes this first
        overlay.appendChild(pop);
        area.focus();
    }

    const textButton = pushButton("edit as text", openTextEditor);
    textButton.title = "Edit the schema as text: paste one in, copy this one "
        + "out, or write lines by hand. Nothing changes on the node until Apply.";

    const schemaTools = el("div", { display: "flex", gap: "6px" });
    schemaTools.append(
        pushButton("+ add field", () => {
            // under the row last worked in, in its group; else at the end
            const at = lastRow >= 0 && lastRow < rows.length ? lastRow + 1 : rows.length;
            rows.splice(at, 0, { name: "", kind: "text", ref: "", arg: "", def: "",
                                 when: "", hint: "", on: true,
                                 group: at > 0 ? rows[at - 1].group : "" });
            lastRow = at;
            draw();
            const added = list.querySelector(`[data-obvpm-row="${at}"]`);
            added?.querySelector("input[placeholder=name]")?.focus();
            added?.scrollIntoView?.({ block: "nearest" });
        }),
        textButton);
    const schemaPane = el("div", {
        display: "flex", flexDirection: "column", gap: "6px",
        flex: "1 1 auto", minHeight: "0",
    });
    schemaPane.append(columns, list, error, schemaTools);
    const presets = presetsPane(node, overlay, say);
    const filters = filtersPane(answer.fields, presets.typeId);
    const setter = setPane(node);
    const pages = { schema: schemaPane, presets: presets.element,
                    filters: filters.element, set: setter.element };
    // the pages as one segmented toggle: a track with the chosen segment
    // filled, like the frontend's own on/off toggles
    const tabs = {};
    const toggle = el("div", {
        display: "inline-flex", gap: "2px", padding: "2px",
        background: FILL, border: "1px solid " + EDGE, borderRadius: "6px",
    });
    toggle.setAttribute("role", "tablist");
    function show(which) {
        if (which === "filters") void filters.refresh();
        for (const [key, page] of Object.entries(pages)) {
            const on = key === which;
            page.style.display = on ? "flex" : "none";
            const t = tabs[key];
            if (!t) continue;
            t.style.background = on ? "var(--comfy-menu-secondary-bg, #4a4a4a)" : "transparent";
            t.style.color = on ? INK : DIM;
            t.style.fontWeight = on ? "600" : "400";
            t.style.boxShadow = on ? "0 1px 2px rgba(0,0,0,0.35)" : "none";
            t.setAttribute("aria-selected", on ? "true" : "false");
        }
    }
    for (const [key, label] of [["presets", "Presets"], ["schema", "Schema"],
                                ["filters", "Filters"], ["set", "Set"]]) {
        const t = el("button", {
            border: "none", borderRadius: "4px", padding: "4px 14px",
            font: TEXT, cursor: "pointer", background: "transparent", color: DIM,
        }, label);
        t.type = "button";
        t.setAttribute("role", "tab");
        t.addEventListener("click", () => show(key));
        tabs[key] = t;
        toggle.append(t);
    }
    title.append(toggle);

    footer.append(
        note,
        pushButton("Cancel", close),
        pushButton("Apply", async () => {
            const text = schemaOf(rows);
            // Checked by the SERVER before it lands. The dialog cannot
            // decide for itself whether a schema parses without becoming
            // a second parser, which is the thing this node exists to
            // avoid -- so it asks the one that will actually run it.
            const check = await describe(text);
            if (check.error) {
                error.textContent = check.error;
                error.style.display = "block";
                show("schema");
                return;
            }
            const problem = (await presets.apply()) || (await filters.apply())
                || setter.apply();
            if (problem) {
                say(problem);
                return;
            }
            // Carry the stored values across a rename BEFORE the
            // schema lands. Without this a rename is silent data loss:
            // nothing would be called by the old name any more, so every
            // preset's value for it would stop being read and the field
            // would come back at its default -- not reported as modified
            // either, because it is no longer a field anyone compares.
            carryRenames(node, renamesIn(rows));
            const offW = widget(node, DISABLED_W);
            if (offW) {
                offW.value = rows.filter((r) => r.on === false)
                    .map((r) => String(r.name ?? "").trim()).filter(Boolean).join("\n");
            }
            const w = widget(node, SCHEMA);
            if (w) {
                w.value = text;
                w.callback?.(text);
            }
            close();
            await rebuild(node, true);
        }, { fontWeight: "600" }),
    );

    panel.append(title, schemaPane, presets.element, filters.element, setter.element, footer);
    draw();
    show(pages[tab] ? tab : "presets");
    document.body.appendChild(overlay);
}

/**
 * Re-key a stored set, so a renamed field keeps its value.
 *
 * Renames are applied in a SECOND pass so they win over any stale key of
 * the same name -- an orphan left by an earlier edit must not shadow the
 * value being carried onto it. Two passes also make a swap (a -> b and
 * b -> a in one edit) come out right, which one pass over a mutating
 * object does not.
 */
function renameKeys(store, pairs) {
    const map = new Map(pairs);
    const out = Object.create(null);
    for (const [key, value] of Object.entries(store)) {
        if (!map.has(key)) out[key] = value;
    }
    for (const [key, value] of Object.entries(store)) {
        if (map.has(key)) out[map.get(key)] = value;
    }
    return out;
}

/**
 * Carry stored values across a set of renames, everywhere they are kept.
 *
 * Both stores, because both are keyed by name: the values on the node
 * AND every preset in the library. Missing either one is the whole bug --
 * the node would look right until you switched preset.
 */
function carryRenames(node, pairs) {
    if (!pairs || !pairs.length) return;
    writeJson(node, VALUES, renameKeys(readJson(node, VALUES), pairs));
    const library = readJson(node, PRESETS);
    for (const name of Object.keys(library)) {
        const saved = library[name];
        if (saved && typeof saved === "object" && !Array.isArray(saved)) {
            library[name] = renameKeys(saved, pairs);
        }
    }
    writeJson(node, PRESETS, library);
}

// ---------------------------------------------------------------------
// The button row
//
// A DOM widget, like the timeline's own toolbar -- not a canvas one.
//
// This was drawn on canvas first, in what were literally the timeline's
// hex values, and it came out a colour that appears nowhere in this
// file: the host renders a widget whose `type` it does not know with its
// own component, in its own accent, and `draw` was never called at all.
// Matching a DOM toolbar by repainting it on a canvas was the wrong
// idea twice over -- it depended on a rendering path that was not being
// taken, and even when taken it could only ever be an imitation that
// drifts. The timeline's buttons look like the timeline's buttons
// because they ARE buttons, with those styles. So are these.
//
// Still ONE widget, because the set CHANGES: update and revert only mean
// anything while a preset is modified. As separate node widgets they had
// to be added and removed, so the node's height moved under the cursor
// every time a value was edited, and five stacked rows spent more space
// on the buttons than on the fields they act on. Here they are five
// elements in one row of fixed height, at their natural widths; one
// that does not apply is removed from the row (display:none) -- the
// height cannot move because the ROW owns it, not the buttons.
// ---------------------------------------------------------------------

const ROW_NAME = "obvpm_presets_bar";
// Fixed rows, timeline-style: just the 24px button bar of CONTENT --
// no padding either side; the host's 10px widget margins breathe
// (the status line is gone -- the chooser's "✎ modified" label and the
// starred fields already say everything it said).
// But computeLayoutSize heights are node-space
// INCLUDING the DOM widget margin: in both modes the host sizes the
// element to computedHeight - 2*DEFAULT_MARGIN(10) (domWidget.ts
// onDraw and DomWidgets.vue agree), so the budget is content + 20.
// The original 52 gave the content a 32px box, which is where the
// clipping came from. No bottom padding: the host margin already
// stands under the buttons.
const ROW_CONTENT = 24;
// Vue cards sit the widgets tighter above this row than classic does,
// so the row carries a little top padding there and none in classic.
// Applied in paintButtonRow and budgeted in rowHeight -- the two must
// move together or the pad comes back out of the buttons' own box.
function rowTopPad() {
    const vue = typeof LiteGraph !== "undefined"
        && !!LiteGraph.vueNodesMode;
    return vue ? 4 : 0;
}
// Classic mode stacks 12px more under the LAST widget's slot --
// LGraphNode.computeSize adds `+ 4` per widget and `+ 8` after the
// stack -- so on top of the 10px host margin the buttons floated on
// 22px of nothing. Report a 12px-shorter slot there and let the
// container (overflow visible, no frame or fill of its own) spill
// into the dead band; what remains below the buttons is the plain
// 10px margin. Vue lays its cards out in CSS and has no such tail,
// so it keeps the honest budget.
function rowHeight() {
    const vue = typeof LiteGraph !== "undefined"
        && !!LiteGraph.vueNodesMode;
    return ROW_CONTENT + rowTopPad() + 20 - (vue ? 0 : 12);
}

// The timeline's buttons are painted TWICE: mkBtn's declarations are a
// placeholder that applyChrome() immediately overwrites with
// themePalette() -- background from --comfy-input-bg, the border a
// darkened mix of it, per-theme ink. Copying mkBtn verbatim copied the
// layer that never reaches the screen. So: shape here, colors from the
// SAME themePalette() at paint time.
// The pack's face-button look lives in obvpm_ui.js (NODE_BUTTON, taken
// from this row) so every node's face buttons match; the row budget
// above assumes its 24 px height.
const BTN_SHAPE = NODE_BUTTON;
const BTN_HOVER = NODE_BUTTON_HOVER;

/**
 * What the row offers right now.
 *
 * Always the same five, in the same order. `on` decides whether one is
 * live. `edit schema` sits LAST: it is the only one that is not about
 * the preset the other four act on.
 */
function rowButtons(node) {
    const name = selected(node);
    const named = name !== CUSTOM;
    const changed = node.__obvpmChanged ?? [];
    const quantity = changed.length === 1 ? "1 change"
        : changed.length + " changes";
    // Short labels: the chooser above already names the preset, so
    // repeating it inside every button doubled the same fact and forced
    // ellipses at ordinary node widths. The tooltip keeps the full story.
    return [
        // On "custom" the fuller label carries the noun: nothing else
        // on the row says what saving would make.
        { key: "save", label: named ? "save as" : "save as preset", on: true,
          tip: "Store these values under a new name.",
          run: () => { void savePreset(node, null); } },
        { key: "update", label: "save",
          on: named && changed.length > 0,
          tip: "Save these values into '" + name + "' (" + quantity
               + "): " + changed.join(", "),
          run: () => { void savePreset(node, name); } },
        { key: "revert", label: "revert",
          on: named && changed.length > 0,
          tip: "Put back what '" + name + "' holds, discarding: "
               + changed.join(", "),
          run: () => { void applyPreset(node); } },
        // Only while the values ARE the preset's: with edits pending,
        // "rename" next to "save" and "revert" reads as a question about
        // which values the new name would get.
        { key: "rename", label: "rename",
          on: named && changed.length === 0,
          tip: "Give '" + name + "' another name; its values stay.",
          run: () => { void renamePreset(node); } },
        { key: "delete", label: "delete", on: named,
          tip: "Remove '" + name + "'. The values stay on the node.",
          run: () => { void deletePreset(node); } },
        { key: "schema", label: "config", on: true,
          tip: "The fields (add, rename, retype, reorder), the presets "
               + "(user presets, which workflow presets show, export / "
               + "import) and the set option.",
          run: () => openConfig(node) },
    ];
}

/** Is this node object still in its graph? (See rebuild.) */
function isLive(node) {
    const g = node.graph;
    if (!g) return false;
    if (typeof g.getNodeById !== "function") return true;   // test doubles
    return g.getNodeById(node.id) === node;
}

/** Why isLive answered as it did, for the trace and the report. */
function liveness(node) {
    const g = node.graph;
    if (!g) return "the node has no graph (removed)";
    const held = typeof g.getNodeById === "function" ? g.getNodeById(node.id) : node;
    if (held === node) return "live";
    const same = (g._nodes ?? []).filter((n) => String(n.id) === String(node.id)).length;
    return held
        ? "its graph holds ANOTHER node under id " + node.id + " (" + held.type
          + "); nodes with this id in the graph: " + same
        : "its graph has no node with id " + node.id + " (removed, or the id changed)"
          + "; graph is " + (g === app.graph ? "the open graph" : "not the open graph");
}

// ------------------------------------------------------------------ watchdog

// How long after a create/load/build a node has to be built by. Long,
// on purpose: a big workflow on a busy server takes seconds to settle,
// and a false alarm on a node that was about to finish is worse than a
// late one.
const WATCH_MS = 12000;

/**
 * One timer per node, re-armed on every create/configure: when it fires
 * it checks the node is built, retries once if it is not, and says what
 * is wrong on the node itself instead of leaving it blank.
 */
function watch(node) {
    clearTimeout(node.__obvpmWatch);
    node.__obvpmWatch = setTimeout(() => void checkBuilt(node), WATCH_MS);
    node.__obvpmWatch?.unref?.();       // node's test runner: never hold it open
}

async function checkBuilt(node) {
    if (!node.graph || node.__obvpmRemoved) return;    // removed: nothing to say
    const schema = String(widget(node, SCHEMA)?.value ?? "");
    const built = node.__obvpmBuilt === schema && !!node.__obvpmRow;
    if (built) return;
    let why;
    if (node.__obvpmBuilding) {
        why = "still waiting for the schema from the server after "
            + Math.round((Date.now() - (node.__obvpmBuildingSince ?? Date.now())) / 1000) + " s";
    } else if (!isLive(node)) {
        why = liveness(node);
    } else if (node.__obvpmBuildError) {
        why = "could not build its fields: " + node.__obvpmBuildError;
    } else if (!schema && node.__obvpmLoadedSchemaLen > 0) {
        why = "the workflow had a schema (" + node.__obvpmLoadedSchemaLen
            + " chars) but the node's schema is empty now";
    } else {
        why = "its fields were never built";
    }
    trace(node, "watchdog", why);
    // one quiet retry first: most of these clear once a load settles
    if (!node.__obvpmWatchRetried) {
        node.__obvpmWatchRetried = true;
        await rebuild(node, true);
        if (node.__obvpmBuilt === String(widget(node, SCHEMA)?.value ?? "") && node.__obvpmRow) {
            trace(node, "watchdog", "the retry built it");
            return;
        }
    }
    showProblem(node, why);
}

/**
 * Say what is wrong ON the node: a read-only line where the fields would
 * be. A built node drops it (clearBuilt removes every widget this file
 * made), so it goes away by itself once things work.
 */
function showProblem(node, why) {
    // never on a removed node: a widget added to it now is never taken
    // down, and shows over whatever node took its place
    if (node.__obvpmRemoved) return;
    node.__obvpmProblem = why;
    const text = "⚠ " + why + " -- right-click the node, Copy Value Presets diagnostics";
    // console too, once per problem: the one place a user may already be
    // looking, and it names the node
    if (node.__obvpmProblemLogged !== why) {
        node.__obvpmProblemLogged = why;
        console.warn("[obvpm] Value Presets #" + node.id + ": " + why
                     + " (right-click the node > Copy Value Presets diagnostics)");
    }
    try {
        let w = widget(node, PROBLEM);
        if (!w) {
            // A DOM line, not a text widget: a disabled text widget
            // shows its label and drops a value this long, which leaves
            // "⚠ problem" and none of the problem. Fixed height, two
            // lines at most; the whole text is the tooltip.
            const line = document.createElement("div");
            Object.assign(line.style, {
                color: "#ff8a8a", font: "12px/16px sans-serif", padding: "0 4px",
                overflow: "hidden", display: "-webkit-box", WebkitLineClamp: "2",
                WebkitBoxOrient: "vertical", boxSizing: "border-box",
            });
            w = node.addDOMWidget(PROBLEM, "div", line, { hideOnZoom: false, margin: 6 });
            w.serialize = false;
            w.options.serialize = false;
            w.computeLayoutSize = () => ({ minHeight: 44, maxHeight: 44, minWidth: 0 });
            Object.defineProperty(w, "width", {
                configurable: true, get: () => undefined, set: () => {},
            });
            w[MARK] = true;
            w.__obvpmLine = line;
            dropWidgetSockets(node, [PROBLEM]);
        }
        w.__obvpmLine.textContent = text;             // text, never markup
        w.__obvpmLine.title = text;
        node.setSize?.([node.size[0], Math.max(node.size[1], node.computeSize?.()[1] ?? 0)]);
        node.setDirtyCanvas?.(true, true);
    } catch (err) {
        // the DOM widget is what failed: the plain one, label only
        trace(node, "problem-line-failed", String(err?.message ?? err));
        try {
            const w = node.addWidget("string", "⚠ " + why, "", () => {});
            w.serialize = false;
            w[MARK] = true;
            w.disabled = true;
        } catch (e) { /* the console line above still says it */ }
    }
}
const PROBLEM = "obvpm_problem";

// ------------------------------------------------------------------ report

function diagnostics(node) {
    const g = node.graph;
    const schema = String(widget(node, SCHEMA)?.value ?? "");
    const ids = (g?._nodes ?? []).filter((n) => String(n.id) === String(node.id)).length;
    const own = Object.keys(node).filter((k) => typeof node[k] === "function");
    return reportText(node, {
        "frontend": String(window.__COMFYUI_FRONTEND_VERSION__ ?? "?"),
        "renderer": typeof LiteGraph !== "undefined" && LiteGraph.vueNodesMode ? "Nodes 2.0" : "classic",
        "node": "#" + node.id + " " + node.type + (node.title && node.title !== node.type ? " '" + node.title + "'" : ""),
        "graph": g ? (g === app.graph ? "the open graph" : "another graph (a subgraph?)") : "none",
        "live": liveness(node),
        "nodes with this id in its graph": ids,
        "mode / flags": node.mode + " / " + JSON.stringify(node.flags ?? {}),
        "size": JSON.stringify(Array.from(node.size ?? [], (v) => Math.round(v))),
        "schema": schema.length + " chars (workflow carried "
            + (node.__obvpmLoadedSchemaLen ?? "?") + "), first line: " + schema.split("\n")[0],
        "built from the current schema": node.__obvpmBuilt === schema,
        "building": !!node.__obvpmBuilding,
        "button row": !!node.__obvpmRow,
        "fields": Object.keys(node.__obvpmFieldMap ?? {}).length,
        "schema error": node.__obvpmSchemaError ?? "none",
        "build error": node.__obvpmBuildError ?? "none",
        "problem shown": node.__obvpmProblem ?? "none",
        "widgets": (node.widgets ?? []).map((w) => w.name + " [" + w.type
            + (w.hidden || w.options?.hidden ? ", hidden" : "") + "]"),
        "methods set on this node by extensions": own.join(", ") || "none",
        "extensions": (app.extensions ?? []).length + ": "
            + (app.extensions ?? []).map((e) => e.name).join(", "),
    });
}

async function copyDiagnostics(node) {
    const text = diagnostics(node);
    const ok = await copyText(text);
    app.extensionManager?.toast?.add?.(ok
        ? { severity: "success", summary: "Diagnostics copied",
            detail: "Paste them into the bug report.", life: 4000 }
        : { severity: "warn", summary: "Could not copy",
            detail: "The browser refused clipboard access. In the console: obvpmPresetsDiag(" + node.id + ")",
            life: 6000 });
}

function addButtonRow(node) {
    if (!isLive(node)) return null;      // never a row on a dead node
    if (node.__obvpmRow) {
        // Kept across a rebuild, so it has to be put back at the END:
        // clearBuilt spared it and the fields were appended after.
        const at = (node.widgets ?? []).indexOf(node.__obvpmRow.widget);
        if (at >= 0 && at !== node.widgets.length - 1) {
            node.widgets.push(node.widgets.splice(at, 1)[0]);
        }
        placeConstantRow(node);
        paintButtonRow(node);
        return node.__obvpmRow;
    }
    const container = document.createElement("div");
    Object.assign(container.style, {
        display: "flex", flexDirection: "column", gap: "6px",
        // no vertical padding here: the host's widget margins stand
        // above and below, and the Vue-only top pad is applied in
        // paintButtonRow (rowTopPad)
        padding: "0 2px", overflow: "visible",
        font: "12px sans-serif", boxSizing: "border-box",
    });

    const bar = document.createElement("div");
    Object.assign(bar.style, {
        // HARD-FIXED like the timeline's info rows: content changes
        // must never reflow the widget, and the widget's own height is
        // budgeted from these numbers (see ROW_CONTENT)
        display: "flex", gap: "3px", alignItems: "center",
        flexWrap: "nowrap", overflow: "hidden",
        height: "24px", flexShrink: "0",
    });

    const elements = rowButtons(node).map((spec) => {
        const b = document.createElement("button");
        Object.assign(b.style, BTN_SHAPE);
        // natural width, but still allowed to shrink with ellipsis
        // when the node is dragged narrow
        b.style.flex = "0 1 auto";
        b.style.minWidth = "0";
        // schema stands apart on the right, the way the timeline
        // groups export away from the editing buttons: it is the one
        // button about the fields rather than the preset
        if (spec.key === "schema") b.style.marginLeft = "auto";
        b.style.overflow = "hidden";
        b.style.textOverflow = "ellipsis";
        b.addEventListener("mouseenter", () => {
            b.style.background = BTN_HOVER;
        });
        b.addEventListener("mouseleave", () => {
            b.style.background = themePalette().rest;
        });
        b.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            b.__obvpmRun?.();
        });
        bar.appendChild(b);
        return { key: spec.key, el: b };
    });

    container.append(bar);
    const widget = node.addDOMWidget(ROW_NAME, "div", container,
                                     { hideOnZoom: false });
    widget.serialize = false;
    widget.options.serialize = false;
    widget.computeLayoutSize = () => {
        const h = rowHeight();  // read per layout: mode can change
        return { minHeight: h, maxHeight: h, minWidth: 0 };
    };
    // The frozen-width guard the timeline's own DOM widgets carry: once
    // anything stores widget.width, DomWidgets.vue prefers it forever and
    // the element stops tracking the node. Reads yield undefined so the
    // live node width always wins.
    Object.defineProperty(widget, "width", {
        configurable: true, get: () => undefined, set: () => {},
    });
    widget[MARK] = true;

    node.__obvpmRow = { widget, container, elements };
    // Repaint when the theme flips, the way the timeline reskins its
    // chrome: PAL.text and PAL.edge are computed per-theme values, not
    // live var() strings, so a theme change strands them until repainted.
    let themeTimer = null;
    const themeMO = new MutationObserver(() => {
        clearTimeout(themeTimer);
        themeTimer = setTimeout(() => paintButtonRow(node), 150);
    });
    for (const t of [document.documentElement, document.body]) {
        themeMO.observe(t, { attributes: true,
            attributeFilter: ["class", "style", "data-theme"] });
    }
    const onRemoved = node.onRemoved;
    node.onRemoved = function () {
        themeMO.disconnect();
        return onRemoved?.apply(this, arguments);
    };
    // A widget gets an input socket, and this one is added after the node
    // was built -- so the drop that cleared the declared widgets' sockets
    // never saw it. Left alone it shows as a pin carrying nothing.
    dropWidgetSockets(node, [ROW_NAME]);
    placeConstantRow(node);
    paintButtonRow(node);
    return node.__obvpmRow;
}

/** Restate the buttons from the node's current state. */
function paintButtonRow(node) {
    const row = node.__obvpmRow;
    if (!row) return;
    // The SAME palette applyChrome() paints the timeline's header with,
    // read fresh so a theme flip repaints true.
    const PAL = themePalette();
    row.container.style.paddingTop = rowTopPad() + "px";

    const specs = rowButtons(node);
    for (const { key, el } of row.elements) {
        const spec = specs.find((s) => s.key === key);
        if (!spec) continue;
        el.textContent = spec.label;
        el.title = spec.tip;
        // A button that does not apply is GONE (display:none via the
        // hidden attribute), not disabled: at natural widths an
        // invisible placeholder just reads as a hole in the row.
        el.hidden = !spec.on;
        el.style.background = PAL.rest;
        el.style.borderColor = PAL.edge;
        el.style.color = PAL.text;
        el.__obvpmRun = spec.on ? spec.run : null;
    }
}
