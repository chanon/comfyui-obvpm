import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
// Imported rather than copied: hiding a widget leaves its input socket
// behind -- invisible, still hit-tested, and ready to take a wire aimed
// at nothing. One implementation of that fix, and of the dialog kit and
// palette (the bundle config and Load Images & Compose use them too).
import { el, TEXT, TITLE, INK, DIM, EDGE, FILL, PANEL,
         textBox, pushButton, openOverlay,
         dropWidgetSockets, themePalette, valueTooltip } from "./obvpm_ui.js";

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
// Hidden on the node's face. The schema joins them: "edit schema…" is
// the way in, and a multiline box of syntax sitting above the controls
// is a second, worse one. It stays a real widget -- it is still the
// store, still what a workflow carries, and still wire-able.
const OWNED = [SCHEMA, VALUES, PRESETS, NAMES];

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
async function describe(schema) {
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
function fieldWidget(node, field, value, onChange) {
    const set = (v) => { onChange(field.name, v); };
    const shown = field.error ? field.name + "  ⚠" : field.name;
    let w, coerced;
    if (field.choices) {
        // A values FUNCTION because litegraph wants one -- and it must
        // close over the node and the NAME, not this build's field
        // object: a re-created widget keeps the FIRST build's options in
        // the surviving state, so an old closure over an old field would
        // serve stale choices forever. Looked up live, even the old
        // closure answers with this build's list.
        coerced = String(value ?? "");
        w = node.addWidget("combo", shown, coerced, set, {
            values: () => node.__obvpmFieldMap?.[field.name]?.choices ?? [],
        });
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
    // The schema's hint for the field, and the error if it has one --
    // both are schema text, shown as text (the tooltip is rendered as
    // text by the host, never as markup).
    const baseTip = [field.error, field.hint].filter(Boolean).join("\n\n")
        || undefined;
    // The full value on hover whenever the widget draws it cut off -- a
    // long file name in a narrow node. A getter, not a stored string: the
    // frontend reads widget.tooltip at hover time, and both the value and
    // the node's width change long after this build.
    Object.defineProperty(w, "tooltip", {
        configurable: true,
        get: () => valueTooltip(w, node.size?.[0] ?? 0, baseTip),
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
    const values = readJson(node, VALUES);
    const shown = Object.create(null);
    for (const field of Object.values(fieldMap)) {
        shown[field.name] = isShown(field, fieldMap, values, shown);
    }
    let moved = false;
    for (const w of node.widgets ?? []) {
        if (!w[MARK] || w.name === ROW_NAME) continue;
        const field = w.name.replace(/ {2}⚠$/, "");
        const hidden = shown[field] === false;
        // either flag: the options object can outlive a rebuild with
        // the widget's state while the instance comes back fresh
        if (!!(w.hidden || w.options?.hidden) !== hidden) {
            hide(w, hidden);
            moved = true;
        }
    }
    if (moved && typeof node.computeSize === "function" && node.size) {
        node.setSize?.([node.size[0], node.computeSize()[1]]);
        notifyVue(node);
    }
    return shown;
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
    const saved = readJson(node, PRESETS)[name];
    if (!saved || typeof saved !== "object") return [];
    const now = readJson(node, VALUES);
    // Over the CURRENT fields, not the preset's keys: a field added to
    // the schema after the preset was saved is not among its keys, and
    // an edit to it went unreported (2026-09-09). A key the preset holds
    // for a field the schema lost is nothing to report either way.
    const fields = node.__obvpmFieldMap
        ? Object.keys(node.__obvpmFieldMap) : Object.keys(now);
    return fields.filter((key) => key in now
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
}

function presetNames(node) {
    return Object.keys(readJson(node, PRESETS)).sort(
        (a, b) => a.localeCompare(b));
}

function selected(node) {
    return String(widget(node, PRESET)?.value ?? CUSTOM);
}

app.registerExtension({
    name: "obvpm.value_presets",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE) return;

        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = created?.apply(this, arguments);
            setup(this);
            return r;
        };

        // A workflow load replaces widget values AFTER creation, so the
        // controls have to be rebuilt once the real schema and values
        // are in place -- otherwise every loaded node shows the defaults.
        const configure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = configure?.apply(this, arguments);
            void rebuild(this);
            return r;
        };

        // The catch-all. rebuild() is a string compare against the text
        // it last built from, so this costs one comparison per frame and
        // picks up every route a schema can change by -- including the
        // ones that fire no callback at all.
        const draw = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (...args) {
            void rebuild(this);
            return draw?.apply(this, args);
        };
    },
});

function setup(node) {
    for (const name of OWNED) hide(widget(node, name));
    // ... and their sockets with them. Anything genuinely wired is left
    // alone, so the schema or the preset name can still be driven from
    // elsewhere.
    dropWidgetSockets(node, OWNED);

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
        return old;
    }
    const combo = node.addWidget("combo", name, old.value ?? CUSTOM,
                                 () => {}, { values: valuesFn });
    combo.serialize = true;             // this one IS declared server-side
    const appended = node.widgets.indexOf(combo);
    if (appended >= 0) node.widgets.splice(appended, 1);
    node.widgets[index] = combo;
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
    const schema = String(widget(node, SCHEMA)?.value ?? "");
    if (!force && node.__obvpmBuilt === schema) return;
    if (node.__obvpmBuilding) {
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
    let answer;
    try {
        answer = await describe(schema);
    } finally {
        node.__obvpmBuilding = false;
    }
    // Deleted while we were asking? `node.graph` is not the test: a
    // graph clear (a workflow reloaded over itself, undo) fires the
    // node's removal but never unsets that reference, and the same
    // graph object is reused for the next load. A build that lands
    // after that would add its button row to a dead node -- registered
    // with the overlay, drawn at the dead node's position, and never
    // removed, because a removed node is not removed twice. That was
    // the duplicate row under a reloaded workflow (2026-09-10). The
    // graph has to still hold THIS node object.
    if (!isLive(node)) return;
    const rerun = node.__obvpmRerun ?? 0;
    node.__obvpmRerun = 0;
    // An answer for text the widget no longer holds is stale: building
    // from it would be wrong, and its write-back would destroy values
    // keyed to the real schema. Discard and ask again -- BEFORE
    // __obvpmBuilt is touched, so the retry does not think it is done.
    if (String(widget(node, SCHEMA)?.value ?? "") !== schema || rerun) {
        return rebuild(node, force || rerun === 2);
    }
    node.__obvpmBuilt = schema;

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

    for (const field of fields) {
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

function savePreset(node, name) {
    const chosen = name ?? window.prompt(
        "Save these values as a preset called:", "");
    const clean = String(chosen ?? "").trim();
    if (!clean) return;
    if (clean === CUSTOM) {
        window.alert("'" + CUSTOM + "' is the name for values that are not "
                     + "a preset; pick another.");
        return;
    }
    const library = readJson(node, PRESETS);
    if (!name && Object.prototype.hasOwnProperty.call(library, clean)
            && !window.confirm("Replace the preset '" + clean + "'?")) {
        return;
    }
    library[clean] = readJson(node, VALUES);
    writeJson(node, PRESETS, library);
    const chooser = widget(node, PRESET);
    if (chooser) chooser.value = clean;
    void rebuild(node, true);
}

function deletePreset(node) {
    const name = selected(node);
    if (name === CUSTOM) return;
    if (!window.confirm("Delete the preset '" + name + "'? The values stay "
                        + "on the node.")) {
        return;
    }
    const library = readJson(node, PRESETS);
    delete library[name];
    writeJson(node, PRESETS, library);
    const chooser = widget(node, PRESET);
    if (chooser) chooser.value = CUSTOM;
    void rebuild(node, true);
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
    const saved = readJson(node, PRESETS)[name];
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
    const hint = String(row.hint ?? "").trim();
    return name + ": " + spec + (def ? " = " + def : "")
        + (when ? " when " + when : "") + (hint ? " # " + hint : "");
}

/** The schema text the editor's rows stand for. */
function schemaOf(rows) {
    return rows.map(lineOf).join("\n") + "\n";
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

async function openSchemaEditor(node) {
    const answer = await describe(widget(node, SCHEMA)?.value ?? "");
    const rows = (answer.fields ?? []).map(rowOf);

    // wider than the kit's default: a row is name, type, range,
    // default, condition and hint, and wrapping them would lose the
    // column-per-part reading that makes the dialog a table
    const { overlay, panel, close } = openOverlay("min(1180px, 96vw)");

    const title = el("div", { font: TITLE }, "Schema");
    const columns = el("div", {
        display: "flex", gap: "5px", color: DIM, font: "12px sans-serif",
        padding: "0 2px",
    });
    for (const [label, width] of [["", "58px"], ["name", "150px"],
                                  ["type", "200px"], ["range / choices", "160px"],
                                  ["default", "110px"], ["shown when", "160px"],
                                  ["hint", "160px"]]) {
        columns.appendChild(el("div", { flex: "0 0 " + width,
                                        overflow: "hidden" }, label));
    }
    const list = el("div", {
        display: "flex", flexDirection: "column", gap: "4px",
        overflowY: "auto", padding: "4px 2px",
    });
    const error = el("div", {
        color: "#e88", whiteSpace: "pre-wrap", display: "none",
    });

    function draw() {
        list.replaceChildren();
        rows.forEach((row, index) => list.appendChild(drawRow(row, index)));
        if (!rows.length) {
            list.appendChild(el("div", { color: DIM, padding: "8px 2px" },
                                "No fields yet."));
        }
    }

    function drawRow(row, index) {
        const line = el("div", {
            display: "flex", gap: "5px", alignItems: "center",
        });
        const move = (by) => {
            const to = index + by;
            if (to < 0 || to >= rows.length) return;
            rows.splice(to, 0, rows.splice(index, 1)[0]);
            draw();
        };
        line.append(
            pushButton("▲", () => move(-1), { padding: "1px 5px" }),
            pushButton("▼", () => move(1), { padding: "1px 5px" }),
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
        line.append(
            textBox(row.def, "default", (v) => { row.def = v; }, "110px"),
            when,
            textBox(row.hint, "hint", (v) => { row.hint = v; }, "160px"),
            pushButton("✕", () => { rows.splice(index, 1); draw(); },
                       { padding: "1px 6px" }),
        );
        return line;
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
                    ...(check.fields ?? []).map((f) => ({ ...rowOf(f), was: "" })));
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
        area.placeholder = "name: type [range] [= default] [when field = value] [# hint]";
        area.spellcheck = false;
        const legend = el("div", { color: DIM, font: "12px sans-serif" },
            "One field per line: name: type [range or choices] [= default] "
            + "[when field = value] [# hint]. Types: text, int, float, bool, "
            + "choice a, b, c, @Node.input. Lines starting with # are comments.");
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
        overlay.appendChild(pop);
        area.focus();
    }

    const textButton = pushButton("edit as text", openTextEditor);
    textButton.title = "Edit the schema as text: paste one in, copy this one "
        + "out, or write lines by hand. Nothing changes on the node until Apply.";

    footer.append(
        pushButton("+ add field", () => {
            rows.push({ name: "", kind: "text", ref: "", arg: "", def: "",
                        when: "", hint: "" });
            draw();
        }),
        textButton, note,
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
                return;
            }
            // Carry the stored values across a rename BEFORE the
            // schema lands. Without this a rename is silent data loss:
            // nothing would be called by the old name any more, so every
            // preset's value for it would stop being read and the field
            // would come back at its default -- not reported as modified
            // either, because it is no longer a field anyone compares.
            carryRenames(node, renamesIn(rows));
            const w = widget(node, SCHEMA);
            if (w) {
                w.value = text;
                w.callback?.(text);
            }
            close();
            await rebuild(node, true);
        }, { fontWeight: "600" }),
    );

    panel.append(title, columns, list, error, footer);
    draw();
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
const BTN_SHAPE = {
    borderRadius: "4px", padding: "2px 8px", cursor: "pointer",
    whiteSpace: "nowrap", borderWidth: "1px", borderStyle: "solid",
    // explicit line-height, as in mkBtn: without it button heights
    // drift with the glyphs in their labels. Below the timeline's 12px
    // -- these five are secondary to the fields above them -- with the
    // line-height kept at 18 so the 24px row budget (and the row budget with
    // it) is untouched.
    font: "10px/18px sans-serif",
    height: "24px", boxSizing: "border-box",
};
// snapBtn's off-state hover, the only hover the timeline's chrome has
const BTN_HOVER = "rgba(127,127,127,0.3)";

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
          run: () => savePreset(node, null) },
        { key: "update", label: "save",
          on: named && changed.length > 0,
          tip: "Save these values into '" + name + "' (" + quantity
               + "): " + changed.join(", "),
          run: () => savePreset(node, name) },
        { key: "revert", label: "revert",
          on: named && changed.length > 0,
          tip: "Put back what '" + name + "' holds, discarding: "
               + changed.join(", "),
          run: () => { void applyPreset(node); } },
        { key: "delete", label: "delete", on: named,
          tip: "Remove '" + name + "'. The values stay on the node.",
          run: () => deletePreset(node) },
        { key: "schema", label: "schema", on: true,
          tip: "Add, rename, retype or reorder the fields.",
          run: () => openSchemaEditor(node) },
    ];
}

/** Is this node object still in its graph? (See rebuild.) */
function isLive(node) {
    const g = node.graph;
    if (!g) return false;
    if (typeof g.getNodeById !== "function") return true;   // test doubles
    return g.getNodeById(node.id) === node;
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
