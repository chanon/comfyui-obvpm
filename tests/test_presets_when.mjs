// Value Presets: conditional fields on the node's face, hints, and the
// schema editor's line round-trip. Runs the real web/value_presets.js in
// a vm with the framework mocked and the server's `describe` answered
// from a fixed field list -- the Python side (test_presets_when.py) owns
// the parsing; this checks what the browser does with what it is told.
//
// Run: node --experimental-vm-modules --test tests/test_presets_when.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const root = new URL("../web/", import.meta.url);
const tick = () => new Promise((resolve) => setImmediate(resolve));

// What /obvpm/presets/schema would answer for the turbo schema.
const FIELDS = [
    { name: "turbo_loader", kind: "choice", ref: null, lo: null, hi: null, span: "",
      decimals: null, default_text: "off", choices: ["off", "normal", "larryvrh"],
      default: "off", hint: "which loader applies the LoRA", when: null, when_text: "" },
    { name: "turbo_lora", kind: "choice", ref: "LoraName (obvpm).lora_name", lo: null,
      hi: null, span: "", decimals: null, default_text: "", choices: ["a.safetensors", "b.safetensors"],
      default: "a.safetensors", hint: "the LoRA file",
      when: { field: "turbo_loader", not: true, values: ["off"] }, when_text: "turbo_loader != off" },
    { name: "turbo_strength", kind: "float", ref: null, lo: 0, hi: 1, span: "0..1.00",
      decimals: 2, default_text: "1.0", choices: null, default: 1, hint: "",
      when: { field: "turbo_loader", not: true, values: ["off"] }, when_text: "turbo_loader != off" },
    { name: "spectrum", kind: "bool", ref: null, lo: null, hi: null, span: "", decimals: null,
      default_text: "false", choices: null, default: false, hint: "", when: null, when_text: "" },
    { name: "spectrum_amount", kind: "int", ref: null, lo: 0, hi: 10, span: "0..10", decimals: 0,
      default_text: "3", choices: null, default: 3, hint: "",
      when: { field: "spectrum", not: false, values: ["true"] }, when_text: "spectrum = true" },
    { name: "steps", kind: "int", ref: null, lo: null, hi: null, span: "", decimals: 0,
      default_text: "20", choices: null, default: 20, hint: "", when: null, when_text: "" },
];

async function harness() {
    const extensions = [];
    const app = { registerExtension: (ext) => extensions.push(ext), canvas: {} };
    const asked = { schema: 0 };
    const api = { fetchApi: async (url) => {
        if (url === "/obvpm/presets/schema") {
            asked.schema += 1;
            return { json: async () => ({ fields: FIELDS }) };
        }
        throw new Error("Offline test: " + url);
    } };
    const context = vm.createContext({
        console, setTimeout, clearTimeout, setImmediate,
        document: { body: {}, createElement: () => ({ style: {}, addEventListener() {},
            appendChild() {}, append() {} }), documentElement: {}, addEventListener() {} },
        window: {}, LiteGraph: {}, MutationObserver: class { observe() {} disconnect() {} },
        navigator: {},
    });
    const noop = () => {};
    const cache = new Map();
    const mock = (values) => new vm.SyntheticModule(Object.keys(values), function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
    async function load(name) {
        if (cache.has(name)) return cache.get(name);
        let mod;
        if (name.endsWith("scripts/app.js")) mod = mock({ app });
        else if (name.endsWith("scripts/api.js")) mod = mock({ api });
        else if (name === "obvpm_ui.js") {
            mod = mock({ themePalette: () => ({}), el: noop,
                valueTooltip: (w, width, base) => base,
                ...Object.fromEntries(["TEXT", "TITLE", "INK", "DIM", "EDGE", "FILL", "PANEL",
                    "textBox", "pushButton", "openOverlay", "dropWidgetSockets",
                    "askText", "askConfirm", "notice", "NODE_BUTTON", "NODE_BUTTON_HOVER",
                    "nodeButton", "nodeButtonBar", "paintNodeButton"].map((k) => [k, noop])) });
        } else {
            let source = await readFile(new URL(name, root), "utf8");
            if (name === "value_presets.js") {
                source += "\nexport { rebuild, isShown, applyVisibility, rowOf, lineOf, schemaOf, readJson, asDropdown };";
            }
            mod = new vm.SourceTextModule(source, { context, identifier: name });
        }
        cache.set(name, mod);
        await mod.link((spec) => load(spec.startsWith("./") ? spec.slice(2) : spec));
        return mod;
    }
    const mod = await load("value_presets.js");
    await mod.evaluate();
    return { p: mod.namespace, extensions, asked };
}

/** A litegraph-shaped node: enough for rebuild() to run against. */
class Node {
    constructor(values) {
        this.id = 1;
        this.size = [300, 100];
        this.widgets = [
            { name: "schema", value: "turbo_loader: choice off, normal, larryvrh = off" },
            { name: "preset", value: "custom", type: "combo", options: {} },
            { name: "values", value: JSON.stringify(values) },
            { name: "presets", value: "{}" },
            { name: "names", value: "" },
        ];
        this.inputs = [];
        this.graph = { getNodeById: () => this };
    }
    addWidget(type, name, value, callback, options) {
        const w = { type, name, value, callback, options: options ?? {} };
        this.widgets.push(w);
        // frontend 1.53: a widget added under a name the node already
        // has is renamed "name#1" on registration (ensureUniqueWidgetNames)
        if (this.widgets.some((o) => o !== w && o.name === name)) w.name = name + "#1";
        return w;
    }
    addDOMWidget(name, type, element, options) {
        const w = { name, type, element, options: options ?? {} };
        this.widgets.push(w);
        return w;
    }
    computeSize() {
        const shown = this.widgets.filter((w) => !w.hidden).length;
        return [this.size[0], 30 + shown * 24];
    }
    setSize(size) { this.size = size; }
    setDirtyCanvas() {}
}

function field(node, name) {
    return node.widgets.find((w) => w.name === name);
}

test("a false condition hides the widget and keeps its value", async () => {
    const { p } = await harness();
    const node = new Node({ turbo_loader: "off", turbo_lora: "b.safetensors",
                            turbo_strength: 0.5, spectrum: false, spectrum_amount: 7, steps: 20 });
    await p.rebuild(node, true);
    await tick();
    assert.equal(field(node, "turbo_lora").hidden, true);
    assert.equal(field(node, "turbo_lora").options.hidden, true);
    assert.equal(field(node, "turbo_strength").hidden, true);
    assert.equal(field(node, "spectrum_amount").hidden, true);
    assert.equal(!!field(node, "turbo_loader").hidden, false);
    assert.equal(!!field(node, "steps").hidden, false);
    // the value is still there, for when the condition holds again
    assert.equal(field(node, "turbo_lora").value, "b.safetensors");
    assert.equal(p.readJson(node, "values").turbo_lora, "b.safetensors");
    // and the node shrank to the widgets it shows
    assert.equal(node.size[1], node.computeSize()[1]);
});

test("changing the deciding widget shows and hides its dependents at once", async () => {
    const { p } = await harness();
    const node = new Node({ turbo_loader: "off", spectrum: false });
    await p.rebuild(node, true);
    await tick();
    assert.equal(field(node, "turbo_lora").hidden, true);
    const before = node.size[1];
    field(node, "turbo_loader").callback("normal");
    assert.equal(field(node, "turbo_lora").hidden, false);
    assert.equal(field(node, "turbo_lora").options.hidden, false);
    assert.equal(field(node, "turbo_strength").hidden, false);
    assert.ok(node.size[1] > before, "the node grew for the shown fields");
    assert.equal(field(node, "spectrum_amount").hidden, true);
    field(node, "spectrum").callback(true);
    assert.equal(field(node, "spectrum_amount").hidden, false);
    field(node, "turbo_loader").callback("off");
    assert.equal(field(node, "turbo_lora").hidden, true);
    assert.equal(field(node, "turbo_strength").hidden, true);
    assert.equal(field(node, "spectrum_amount").hidden, false);
});

test("a field decided by a hidden field is hidden", async () => {
    const { p } = await harness();
    const map = {
        a: { name: "a", kind: "bool", when: null },
        b: { name: "b", kind: "choice", when: { field: "a", not: false, values: ["true"] } },
        c: { name: "c", kind: "int", when: { field: "b", not: true, values: ["x"] } },
    };
    const shown = {};
    for (const f of Object.values(map)) shown[f.name] = p.isShown(f, map, { a: false, b: "y" }, shown);
    assert.deepEqual(shown, { a: true, b: false, c: false });
    const again = {};
    for (const f of Object.values(map)) again[f.name] = p.isShown(f, map, { a: true, b: "y" }, again);
    assert.deepEqual(again, { a: true, b: true, c: true });
    // a numeric choice decides by its text, as on the server
    const depth = { depth: { name: "depth", kind: "choice", when: null },
                    fast: { name: "fast", kind: "bool", when: { field: "depth", not: false, values: ["8", "10"] } } };
    assert.equal(p.isShown(depth.fast, depth, { depth: 8 }, { depth: true }), true);
    assert.equal(p.isShown(depth.fast, depth, { depth: "auto" }, { depth: true }), false);
});

test("the hint is the widget's tooltip, after an error when there is one", async () => {
    const { p } = await harness();
    const node = new Node({});
    await p.rebuild(node, true);
    await tick();
    assert.equal(field(node, "turbo_loader").tooltip, "which loader applies the LoRA");
    assert.equal(field(node, "steps").tooltip, undefined);
});

test("editor rows carry the condition and hint and round-trip to the line", async () => {
    const { p } = await harness();
    const rows = FIELDS.map(p.rowOf);
    assert.equal(rows[1].when, "turbo_loader != off");
    assert.equal(rows[1].hint, "the LoRA file");
    assert.equal(p.lineOf(rows[0]),
                 "turbo_loader: choice off, normal, larryvrh = off # which loader applies the LoRA");
    assert.equal(p.lineOf(rows[1]),
                 "turbo_lora: @LoraName (obvpm).lora_name when turbo_loader != off # the LoRA file");
    assert.equal(p.lineOf(rows[2]), "turbo_strength: float 0..1.00 = 1.0 when turbo_loader != off");
    assert.equal(p.lineOf(rows[4]), "spectrum_amount: int 0..10 = 3 when spectrum = true");
    assert.equal(p.lineOf(rows[5]), "steps: int = 20");
    // a typed "when x = y" is not doubled
    assert.equal(p.lineOf({ name: "z", kind: "int", when: "when spectrum = true" }),
                 "z: int when spectrum = true");
    assert.ok(p.schemaOf(rows).endsWith("steps: int = 20\n"));
    assert.equal(p.schemaOf(rows).split("\n").length, FIELDS.length + 1);
});

test("the preset chooser keeps its name on a frontend that renames duplicates", async () => {
    const { p } = await harness();
    const node = new Node({});
    // as declared by the server: a plain text widget, not yet swapped
    Object.assign(field(node, "preset"), { type: "text", value: "vanilla" });
    const combo = p.asDropdown(node, "preset", () => ["custom", "vanilla"]);
    assert.equal(combo.name, "preset", "issue #12: renamed to preset#1 when the old widget was still there");
    assert.equal(combo.type, "combo");
    assert.equal(combo.value, "vanilla", "the value carried over");
    assert.equal(node.widgets.filter((w) => w.name === "preset" || w.name === "preset#1").length, 1);
    assert.equal(node.widgets.indexOf(combo), 1, "in the old widget's place");
});

// issue #12 diagnostics: a node that cannot build says why, and is not
// left believing it is built -- nor re-asking the server every frame
test("a build that throws is recorded, not latched, and not retried per frame", async () => {
    const { p, asked } = await harness();
    const node = new Node({});
    const addWidget = node.addWidget.bind(node);
    let fail = true;
    node.addWidget = (...args) => {
        if (fail) throw new TypeError("another pack broke addWidget");
        return addWidget(...args);
    };
    await p.rebuild(node, true);
    assert.equal(node.__obvpmBuilt, null, "not left marked as built");
    assert.match(node.__obvpmBuildError, /another pack broke addWidget/);
    assert.ok(node.__obvpmTrace.some((e) => e.e === "build-threw" && /another pack/.test(e.d)));
    // the draw loop calls rebuild(node) every frame: no request for a
    // schema whose build just failed
    const before = asked.schema;
    for (let frame = 0; frame < 5; frame++) await p.rebuild(node);
    assert.equal(asked.schema, before, "no request per frame");
    // a forced retry (the spaced ones are forced) builds once it can
    fail = false;
    await p.rebuild(node, true);
    await tick();
    assert.equal(node.__obvpmBuildError, null);
    assert.ok(field(node, "steps"), "the fields are there");
    assert.ok(node.__obvpmTrace.some((e) => e.e === "built"));
});

// issue #12, the reporter's trace: on a canvas that redraws every frame
// (a pack animating), the draw loop's rebuild() during each request was
// taken as "a rebuild was asked for meanwhile", the answer discarded,
// and the node asked forever without building.
test("a canvas redrawing during the request does not discard its answer", async () => {
    const { p, asked } = await harness();
    const node = new Node({});
    const flight = p.rebuild(node);
    // a frame or two while the answer is in the air, every time
    for (let frame = 0; frame < 50 && node.__obvpmBuilding !== false; frame++) {
        void p.rebuild(node);
        await tick();
    }
    await flight;
    assert.equal(node.__obvpmBuilt, field(node, "schema").value, "built");
    assert.ok(field(node, "steps"), "the fields are there");
    assert.equal(asked.schema, 1, "asked once");
    assert.ok(!node.__obvpmTrace.some((e) => e.e === "stale"), "no answer discarded");
});

test("a different schema, or a forced build, during the request still asks again", async () => {
    // the load case: the default schema is in the air when the workflow's
    // own arrives (onConfigure) -- that answer must not be built from
    for (const how of ["new text", "forced"]) {
        const { p, asked } = await harness();
        const node = new Node({});
        const flight = p.rebuild(node);
        if (how === "new text") {
            field(node, "schema").value += "\nsteps: int = 20";
            void p.rebuild(node);
        } else {
            void p.rebuild(node, true);
        }
        await flight;
        await tick(); await tick();
        assert.equal(asked.schema, 2, how + ": asked again");
        assert.equal(node.__obvpmBuilt, field(node, "schema").value, how + ": built from the current text");
    }
});

test("a node its graph does not hold is recorded with why, and not re-asked per frame", async () => {
    const { p, asked } = await harness();
    const node = new Node({});
    const other = { type: "KSampler" };
    node.graph = { getNodeById: () => other, _nodes: [node, other] };
    other.id = node.id;
    await p.rebuild(node, true);
    const ev = node.__obvpmTrace.find((e) => e.e === "not-live");
    assert.ok(ev, "traced");
    assert.match(ev.d, /ANOTHER node under id 1 \(KSampler\).*this id in the graph: 2/);
    const before = asked.schema;
    for (let frame = 0; frame < 5; frame++) await p.rebuild(node);
    assert.equal(asked.schema, before, "no request per frame");
    assert.equal(field(node, "steps"), undefined, "no fields built on it");
});
