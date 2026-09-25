// Run: node --experimental-vm-modules --test tests/test_notify_vue.mjs
// notifyVue hands the renderer fresh slot objects. A frontend whose slots
// are class instances (1.52 and newer) serializes them through `toJSON`;
// a plain copy loses that and keeps the slot's own `_node`, so the
// frontend's own cloneObject over live slots (configuring a subgraph
// instance) threw "Converting circular structure to JSON" and aborted the
// workflow load (issues obvpm #13 / timeline #6, frontend 1.52 + Nodes 2.0).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const root = new URL("../web/", import.meta.url);

async function dynamic() {
    const context = vm.createContext({ console, setTimeout, clearTimeout,
        document: { getElementById: () => ({ textContent: "" }), addEventListener() {}, body: {} },
        window: { addEventListener() {}, removeEventListener() {} }, LiteGraph: {} });
    const mock = values => new vm.SyntheticModule(Object.keys(values), function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
    const noop = () => {};
    const cache = new Map();
    async function load(name) {
        if (cache.has(name)) return cache.get(name);
        let mod;
        if (name.endsWith("scripts/app.js")) mod = mock({ app: { registerExtension: noop, canvas: {} } });
        else if (name.endsWith("scripts/api.js")) mod = mock({ api: { fetchApi: async () => { throw new Error("offline"); } } });
        else if (name === "obvpm_ui.js") mod = mock({ themePalette: () => ({}), el: noop, icon: noop, iconButton: noop,
            ...Object.fromEntries(["TEXT", "TITLE", "INK", "DIM", "EDGE", "FILL", "PANEL", "textBox", "pushButton", "openOverlay", "dropWidgetSockets", "addPanelWidget", "valueTooltip", "askText", "askConfirm", "notice", "NODE_BUTTON", "NODE_BUTTON_HOVER", "nodeButton", "nodeButtonBar", "paintNodeButton"].map(k => [k, noop])),
            legacyCanvasBox: (ctx, w, h) => [w, h] });
        else if (name === "obvpm_bundle_config.js") mod = mock(Object.fromEntries(["addConfigButton", "applyUnbundleLayout", "hasUnbundleLayout", "openBundleConfig", "openUnbundleConfig"].map(k => [k, noop])));
        else if (name === "obvpm_fold.js") mod = mock({ foldButton: noop, installFold: noop, isFolded: n => !!n.flags?.collapsed, syncFold: noop });
        else mod = new vm.SourceTextModule(await readFile(new URL(name, root), "utf8"), { context, identifier: name });
        cache.set(name, mod);
        await mod.link(spec => load(spec.startsWith("./") ? spec.slice(2) : spec));
        return mod;
    }
    const mod = await load("obvpm_dynamic.js");
    await mod.evaluate();
    return mod.namespace;
}

// The frontend's NodeSlot: (slot, node) constructor, own `_node`, toJSON.
class Slot {
    constructor(slot, node) {
        const { _node, ...rest } = slot;
        Object.assign(this, rest);
        this._node = node;
    }
    toJSON() { return { name: this.name, type: this.type, link: this.link ?? null }; }
}

function nodeWith(slots) {
    const node = { id: 7, type: "Bundle (obvpm)", inputs: [], outputs: [], graph: null };
    node.inputs = slots.map(s => new Slot(s, node));
    node.outputs = [new Slot({ name: "bundle", type: "OBVPM_BUNDLE", links: [] }, node)];
    return node;
}

test("fresh slots are still slots: no circular JSON, same node, same fields", async () => {
    const { notifyVue } = await dynamic();
    const node = nodeWith([{ name: "in_1", type: "*", link: 3, label: "width" }, { name: "in_2", type: "*", link: null }]);
    const before = [...node.inputs];
    notifyVue(node);
    // new identities, as the renderer snapshot needs
    node.inputs.forEach((slot, i) => assert.notEqual(slot, before[i]));
    for (const slot of [...node.inputs, ...node.outputs]) {
        assert.ok(slot instanceof Slot, "slot kept its class");
        assert.equal(slot._node, node);
    }
    assert.equal(node.inputs[0].label, "width");
    assert.equal(node.inputs[0].link, 3);
    // what cloneObject does to live slots on frontend 1.52 while a subgraph instance configures
    assert.doesNotThrow(() => JSON.stringify(node.inputs));
    assert.doesNotThrow(() => JSON.stringify(node.outputs));
    assert.deepEqual(JSON.parse(JSON.stringify(node.inputs))[0], { name: "in_1", type: "*", link: 3 });
});

test("plain-object slots (older frontends) still get plain copies", async () => {
    const { notifyVue } = await dynamic();
    const node = { id: 8, type: "Bundle (obvpm)", inputs: [{ name: "in_1", type: "*", link: null }], outputs: [], graph: null };
    const first = node.inputs[0];
    notifyVue(node);
    assert.notEqual(node.inputs[0], first);
    // a plain object of the module's realm, not this one's
    assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(node.inputs[0])), null);
    assert.equal(node.inputs[0].constructor.name, "Object");
    assert.deepEqual({ ...node.inputs[0] }, first);
});
