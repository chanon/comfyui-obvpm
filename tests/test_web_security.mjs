// Run: node --experimental-vm-modules --test tests/test_web_security.mjs
// Actual modules/functions, framework-only mocks; no browser/network required.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const root = new URL("../web/", import.meta.url);
const tick = () => new Promise(resolve => setImmediate(resolve));
async function harness() {
    const extensions = [];
    const alerts = [];
    const requests = [];
    const style = { textContent: "" };
    const app = { registerExtension: ext => extensions.push(ext), canvas: {} };
    const api = { apiURL: x => x, fetchApi: async (url, options) => {
        requests.push(url);
        if (url === "/obvpm/input_images") return { json: async () => ({ files: [] }) };
        throw new Error("Offline test: no fetch allowed");
    } };
    const context = vm.createContext({ console, TextEncoder, AbortController, Blob, URL, FormData,
        setTimeout, clearTimeout, alert: msg => alerts.push(msg),
        document: { getElementById: () => style, addEventListener() {}, body: {} },
        window: { addEventListener() {}, removeEventListener() {} }, LiteGraph: {}, Image: class {} });
    const cache = new Map();
    const mock = values => new vm.SyntheticModule(Object.keys(values), function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
    const noop = () => {};
    async function load(name) {
        if (cache.has(name)) return cache.get(name);
        let mod;
        if (name.endsWith("scripts/app.js")) mod = mock({ app });
        else if (name.endsWith("scripts/api.js")) mod = mock({ api });
        else if (name === "obvpm_ui.js") mod = mock({ themePalette: () => ({}), el: noop,
            ...Object.fromEntries(["TEXT", "TITLE", "INK", "DIM", "EDGE", "FILL", "PANEL", "textBox", "pushButton", "openOverlay", "dropWidgetSockets", "valueTooltip", "askText", "askConfirm", "notice"].map(k => [k, noop])),
            legacyCanvasBox: (ctx, w, h) => [w, h] });
        else if (name === "obvpm_artius.js") mod = mock({ ARTIUS_MIME: "test/artius", ARTIUS_ROUTE_BASE: "/artius", artiusRelativePath: () => null, readArtiusAssets: () => null });
        else if (name === "obvpm_bundle_config.js") mod = mock(Object.fromEntries(["addConfigButton", "applyUnbundleLayout", "hasUnbundleLayout", "openBundleConfig", "openUnbundleConfig"].map(k => [k, noop])));
        else if (name === "obvpm_fold.js") mod = mock({ foldButton: noop, installFold: noop, isFolded: n => !!n.flags?.collapsed, syncFold: noop });
        else {
            let source = await readFile(new URL(name, root), "utf8");
            if (name === "obvpm_dynamic.js") source += "\nexport { refreshCompactCss, COMPACT_NODES, FOLD_NODES };";
            if (name === "value_presets.js") source += `
export { applyPreset, savePreset, readJson, renameKeys, carryRenames };`;
            if (name === "compose_images.js") source += "\nexport { thumbs, planLayout };";
            mod = new vm.SourceTextModule(source, { context, identifier: name });
        }
        cache.set(name, mod);
        await mod.link(spec => load(spec.startsWith("./") ? spec.slice(2) : spec));
        return mod;
    }
    async function module(name) { const mod = await load(name); await mod.evaluate(); return mod.namespace; }
    return { module, extensions, alerts, requests, style, api };
}

test("quoted CSS id serialization and actual compact/fold refresh", async () => {
    const h = await harness();
    const limits = await h.module("obvpm_image_limits.js");
    const dynamic = await h.module("obvpm_dynamic.js");
    const attack = 'audit"]{} body{--injected:yes} [data-audit="';
    assert.equal(limits.cssString(String.fromCharCode(0)), String.raw`\fffd `);
    const ids = [Array.from({ length: 127 }, (_, n) => String.fromCharCode(n + 1)).join(""), 42, "42", "uuid-abc", attack, 'quote"\\\n\r\f', "雪😀", "1abc"];
    for (const id of ids) {
        const escaped = limits.cssString(id);
        assert.match(escaped, /^(?:\\[0-9a-f]+ )*$/);
        assert.equal(escaped.replace(/\\([0-9a-f]+) /g, (_, n) => String.fromCodePoint(parseInt(n, 16))), String(id));
        dynamic.COMPACT_NODES.set(String(id), 50);
        dynamic.FOLD_NODES.add(String(id));
    }
    dynamic.refreshCompactCss();
    assert.ok(!h.style.textContent.includes("--injected:yes"));
    assert.ok(h.style.textContent.includes(`[data-node-id="${limits.cssString(attack)}"][data-collapsed]`));
    for (const match of h.style.textContent.matchAll(/\[data-node-id="([^"]*)"\]/g)) assert.match(match[1], /^(?:\\[0-9a-f]+ )*$/);
});

test("layer, byte, crop, aspect and planner-input limits", async () => {
    const { module } = await harness();
    const l = await module("obvpm_image_limits.js");
    assert.equal(l.parseLayers('["nested/a.png",{"image":"b.png","crop":{"x":0,"y":0,"w":0.5,"h":1},"aspect":"1:2"}]').length, 2);
    assert.equal(l.parseLayers(JSON.stringify(Array(64).fill("a.png"))).length, 64);
    assert.throws(() => l.parseLayers(JSON.stringify(Array(65).fill("a.png"))), /64/);
    assert.throws(() => l.parseLayers(" ".repeat(256 * 1024 + 1)), /256/);
    assert.throws(() => l.parseLayers('[{"image":"a","crop":{"x":1e300,"y":0,"w":1,"h":1}}]'), /Crop/);
    assert.throws(() => l.parseLayers('[{"image":"a","aspect":"Infinity:1"}]'), /aspect/);
    assert.throws(() => l.checkFiles([{ size: 64 * 1024 * 1024 + 1 }]), /64 MiB/);
    assert.throws(() => l.checkFiles(Array(5).fill({ size: 64 * 1024 * 1024 })), /256 MiB/);
    assert.ok(l.safePlanInputs([[32, 16]], 0, 0, "auto"));
    for (const [mp, gap] of [[Infinity, 0], [0, Infinity], [0, 1e300], [NaN, 0]]) assert.equal(l.safePlanInputs([[32, 16]], mp, gap, "auto"), false);
});

test("streamed thumbnail/upload responses are capped before blob allocation", async () => {
    const h = await harness();
    const { boundedBlob } = await h.module("obvpm_image_limits.js");
    let cancelled = false;
    const response = { headers: new Headers(), body: { getReader: () => ({
        read: async () => ({ value: new Uint8Array(10), done: false }),
        cancel: async () => { cancelled = true; }, releaseLock() {},
    }) } };
    await assert.rejects(boundedBlob(response, 15), /byte limit/);
    assert.ok(cancelled);
});

test("actual Compose editor refuses oversized persisted data without overwriting or uploading", async () => {
    const h = await harness();
    const compose = await h.module("compose_images.js");
    class Node {
        constructor(value) { this.widgets = [{ name: "layers", value }]; this.inputs = []; this.size = [400, 300]; }
        addWidget(type, name, value, callback, options) { const w = { type, name, value, callback, options }; this.widgets.push(w); return w; }
        addCustomWidget(w) { this.widgets.push(w); return w; }
        setDirtyCanvas() {}
    }
    await h.extensions.find(e => e.name === "obvpm.compose_images").beforeRegisterNodeDef(Node, { name: "LoadImagesCompose (obvpm)" });
    const persisted = JSON.stringify(Array(65).fill("a.png"));
    const node = new Node(persisted);
    node.onNodeCreated();
    assert.equal(node.obvpmAddLayer("b.png"), false);
    await node.obvpmAddFiles([{ name: "c.png", size: 20 }]);
    assert.equal(node.widgets[0].value, persisted);
    assert.ok(!h.requests.includes("/upload/image"));
    node.widgets[0].value = "[]";
    node.onConfigure();
    assert.equal(node.obvpmAddLayer("a.png"), true);
    assert.equal(JSON.parse(node.widgets[0].value)[0].image, "a.png");
    h.api.fetchApi = async (url, options) => {
        if (url === "/upload/image") {
            assert.equal(options.body.get("image").name, "normal.png");
            return { status: 200, json: async () => ({ name: "renamed.png", subfolder: "nested" }) };
        }
        throw new Error("Offline preview");
    };
    await node.obvpmAddFiles([new File([new Uint8Array([1, 2])], "normal.png", { type: "image/png" })]);
    assert.equal(JSON.parse(node.widgets[0].value)[1].image, "nested/renamed.png");
    // Draw the actual editor/currentPlan with source dimensions.
    for (const entry of compose.thumbs.values()) entry.img = {
        src: "test", width: 1024, height: 768, naturalWidth: 1024, naturalHeight: 768,
    };
    const mp = { name: "max_megapixels", value: Infinity };
    node.widgets.push(mp);
    const messages = [];
    const ctx = new Proxy({ globalAlpha: 1, measureText: text => ({ width: text.length }),
        fillText: text => messages.push(text) }, {
        get: (target, key) => key in target ? target[key] : () => {},
    });
    const editor = node.widgets.find(w => w.name === "compose_editor");
    editor.draw(ctx, node, 400, 0, 250, false);
    assert.ok(messages.some(m => m.includes("Invalid or oversized")));
    messages.length = 0;
    mp.value = 0;
    editor.draw(ctx, node, 400, 0, 250, false);
    assert.ok(!messages.some(m => m.includes("Invalid or oversized")), "fixing numeric inputs clears the error");
    for (const entry of compose.thumbs.values()) { entry.img.width = 16384; entry.img.height = 2048; }
    messages.length = 0;
    editor.draw(ctx, node, 400, 0, 250, false);
    assert.ok(messages.some(m => m.includes("Compose canvas exceeds")), "zero MP cannot disable the canvas cap");
    node.onRemoved();
    const full = new Node(JSON.stringify(Array(64).fill("same.png")));
    full.onNodeCreated();
    assert.equal(full.obvpmAddLayer("overflow.png"), false);
    assert.equal(JSON.parse(full.widgets[0].value).length, 64);
    full.onRemoved();
    await tick();
});

test("actual preset apply/save/read/rename retain prototype-like names", async () => {
    const h = await harness();
    const p = await h.module("value_presets.js");
    const keys = ["__proto__", "constructor", "toString"];
    const original = JSON.parse('{"__proto__":{"marker":"data"},"constructor":"ctor","toString":"stringer","normal":3}');
    const node = {
        widgets: [
            { name: "values", value: JSON.stringify(original) },
            { name: "presets", value: "{}" },
            { name: "preset", value: "custom" },
        ],
        __obvpmFieldMap: Object.fromEntries(keys.map(k => [k, { default: "default" }])),
        // The real rebuild's in-flight guard keeps this store test independent
        // of rendering and HTTP, without replacing any implementation function.
        __obvpmBuilding: true,
    };
    const value = name => node.widgets.find(w => w.name === name);
    for (const name of keys) {
        p.savePreset(node, name);
        assert.equal(value("preset").value, name);
        value("values").value = "{}";
        await p.applyPreset(node);
        assert.deepEqual(JSON.parse(value("values").value), original);
        assert.equal(Object.getPrototypeOf(p.readJson(node, "values")), null);
    }
    const library = JSON.parse(value("presets").value);
    assert.deepEqual(Object.keys(library).sort(), keys.slice().sort());
    for (const key of keys) assert.deepEqual(library[key], original);
    const pairs = keys.map((key, i) => [key, keys[(i + 1) % keys.length]]);
    const expected = JSON.parse('{"normal":3,"constructor":{"marker":"data"},"toString":"ctor","__proto__":"stringer"}');
    const renamed = p.renameKeys(original, pairs);
    assert.equal(Object.getPrototypeOf(renamed), null);
    assert.deepEqual(JSON.parse(JSON.stringify(renamed)), expected);
    p.carryRenames(node, pairs);
    assert.deepEqual(JSON.parse(value("values").value), expected);
    for (const saved of Object.values(JSON.parse(value("presets").value))) assert.deepEqual(saved, expected);
    for (const name of keys) {
        p.savePreset(node, name);
        value("values").value = "{}";
        await p.applyPreset(node);
        assert.deepEqual(JSON.parse(value("values").value), expected);
    }
    assert.equal(h.requests.length, 0);
});
