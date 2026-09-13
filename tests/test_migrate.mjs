// Run: node --test tests/test_migrate.mjs
// The real obvpm_migrate.js with only the app import mocked.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const WEB = new URL("../web/", import.meta.url);
const dir = mkdtempSync(path.join(tmpdir(), "obvpm-migrate-"));
const calls = [];
const app = { registerExtension: (ext) => calls.push(ext), loadGraphData: null };
writeFileSync(path.join(dir, "app.js"), "export const app = globalThis.__obvpmApp;");
globalThis.__obvpmApp = app;
let src = readFileSync(new URL("obvpm_migrate.js", WEB), "utf8");
src = src.replace('from "../../scripts/app.js"', 'from "./app.js"');
writeFileSync(path.join(dir, "obvpm_migrate.js"), src);
const m = await import(pathToFileURL(path.join(dir, "obvpm_migrate.js")).href);

const ours = (id, type, inputs = [], props = {}) => ({
    id, type, inputs: inputs.map((name) => ({ name, link: null })),
    properties: { "Node name for S&R": type, ...props },
});
const registered = { "Bundle (obvpm)": 1, Bundle: 1, "Dropdown (obvpm)": 1 };   // another pack owns "Bundle"

test("our Bundle migrates, the other pack's Bundle does not", () => {
    const g = { nodes: [
        ours(1, "Bundle", ["in_1", "in_2"]),
        ours(2, "Bundle", ["input_1", "input_2", "name"]),
    ] };
    assert.equal(m.migrateGraph(g, registered), 1);
    assert.equal(g.nodes[0].type, "Bundle (obvpm)");
    assert.equal(g.nodes[0].properties["Node name for S&R"], "Bundle (obvpm)");
    assert.equal(g.nodes[1].type, "Bundle");
    assert.equal(g.nodes[1].properties["Node name for S&R"], "Bundle");
});

test("unclaimed old ids migrate; an id another pack now owns is left alone", () => {
    const g = { nodes: [ours(1, "UnbundleAuto", ["in"]), ours(2, "Dropdown"), ours(3, "LoadImage")] };
    assert.equal(m.migrateGraph(g, { ...registered, Dropdown: 1 }), 1);
    assert.equal(g.nodes[0].type, "Unbundle (obvpm)");
    assert.equal(g.nodes[1].type, "Dropdown");
    assert.equal(g.nodes[2].type, "LoadImage");
});

test("a pack stamp wins over the ownership test", () => {
    const g = { nodes: [
        ours(1, "Dropdown", [], { cnr_id: "comfyui-obvpm" }),
        ours(2, "Dropdown", [], { aux_id: "chanon/comfyui-obvpm" }),
    ] };
    assert.equal(m.migrateGraph(g, { ...registered, Dropdown: 1 }), 2);
    assert.ok(g.nodes.every((n) => n.type === "Dropdown (obvpm)"));
});

test("subgraph definitions are rewritten too, and a second pass is a no-op", () => {
    const g = {
        nodes: [ours(1, "ValuePresets")],
        definitions: { subgraphs: [{ id: "s", nodes: [ours(5, "Bundle", ["in_1"]), ours(6, "CleanVRAM")] }] },
    };
    assert.equal(m.migrateGraph(g, registered), 3);
    assert.deepEqual(g.definitions.subgraphs[0].nodes.map((n) => n.type), ["Bundle (obvpm)", "CleanVRAM (obvpm)"]);
    assert.equal(m.migrateGraph(g, registered), 0);
});

test("a Value Presets schema that borrows dropdowns by old id is rewritten", () => {
    const schema = "turbo_lora: @LoraName.lora_name\nsampler: @SamplerName.sampler_name\nnote: keep @Bundle.x";
    const node = { ...ours(1, "ValuePresets"), widgets_values: [schema, "{}", "custom", 3],
                   widgets_values_named: { schema, presets: "{}" } };
    const already = { ...ours(2, "ValuePresets (obvpm)"), widgets_values: ["a: @LoraName (obvpm).lora_name"] };
    const g = { nodes: [node, already] };
    assert.equal(m.migrateGraph(g, registered), 3);   // array + named copy + the type
    assert.equal(node.type, "ValuePresets (obvpm)");
    assert.equal(node.widgets_values[0],
        "turbo_lora: @LoraName (obvpm).lora_name\nsampler: @SamplerName (obvpm).sampler_name\nnote: keep @Bundle (obvpm).x");
    assert.deepEqual(node.widgets_values.slice(1), ["{}", "custom", 3]);
    assert.equal(node.widgets_values_named.schema, node.widgets_values[0]);
    assert.equal(node.widgets_values_named.presets, "{}");
    assert.equal(already.widgets_values[0], "a: @LoraName (obvpm).lora_name");
    assert.equal(m.migrateGraph(g, registered), 0);
});

test("malformed input is tolerated", () => {
    assert.equal(m.migrateGraph(null), 0);
    assert.equal(m.migrateGraph("{}"), 0);
    assert.equal(m.migrateGraph({ nodes: "nope", definitions: { subgraphs: [{}] } }), 0);
    assert.equal(m.migrateGraph({ nodes: [{ type: "Bundle" }] }, registered), 0);
});

test("setup wraps loadGraphData once and migrates on the way in", async () => {
    const ext = calls.find((e) => e.name === "obvpm.migrate");
    const seen = [];
    app.loadGraphData = async function (g, ...rest) { seen.push([g.nodes[0].type, rest]); return "ok"; };
    ext.setup();
    const wrapped = app.loadGraphData;
    ext.setup();
    assert.equal(app.loadGraphData, wrapped, "second setup must not wrap twice");
    globalThis.LiteGraph = { registered_node_types: registered };
    assert.equal(await app.loadGraphData({ nodes: [ours(1, "Bundle", ["in_1"])] }, true, "x"), "ok");
    assert.deepEqual(seen, [["Bundle (obvpm)", [true, "x"]]]);
    const g = { nodes: [ours(1, "MuteGate")] };
    ext.beforeConfigureGraph(g);
    assert.equal(g.nodes[0].type, "MuteGate (obvpm)");
});
