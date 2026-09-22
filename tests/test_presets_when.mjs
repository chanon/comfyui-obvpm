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
    const api = { fetchApi: async (url) => {
        if (url === "/obvpm/presets/schema") return { json: async () => ({ fields: FIELDS }) };
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
                    "textBox", "pushButton", "openOverlay", "dropWidgetSockets"].map((k) => [k, noop])) });
        } else {
            let source = await readFile(new URL(name, root), "utf8");
            source += "\nexport { rebuild, isShown, applyVisibility, rowOf, lineOf, schemaOf, readJson };";
            mod = new vm.SourceTextModule(source, { context, identifier: name });
        }
        cache.set(name, mod);
        await mod.link((spec) => load(spec.startsWith("./") ? spec.slice(2) : spec));
        return mod;
    }
    const mod = await load("value_presets.js");
    await mod.evaluate();
    return { p: mod.namespace, extensions };
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
