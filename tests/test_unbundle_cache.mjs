// The Unbundle cache fix (web/obvpm_dynamic.js): the per-field resolver,
// the virtuality gate and the prototype hooks, on the REAL modules with
// only the sibling imports mocked.
//
// Every wiring the fix models must resolve field by field, and every
// wiring it cannot model must fall back to "stay a real server node":
// a muted or bypassed packer, a switch or presets packer on the wire, a
// subgraph used more than once, a gapped names list -- the node keeps
// unpacking server-side, exactly as before the patch.
//
// Run: node --experimental-vm-modules --test tests/test_unbundle_cache.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const root = new URL("../web/", import.meta.url);

// ---- module loading -----------------------------------------------------
const extensions = [];
const app = { registerExtension: (ext) => extensions.push(ext),
              graph: null, rootGraph: null };
const context = vm.createContext({ console, URL,
    setTimeout: (fn) => fn(), clearTimeout() {} });
const mock = (values) => new vm.SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) {
        this.setExport(name, value);
    }
}, { context });

const appMock = mock({ app });
const uiMock = mock({ iconButton: () => "", dropWidgetSockets: () => {} });
const limitsMock = mock({ cssString: () => "" });
const configMock = mock({ addConfigButton() {}, applyUnbundleLayout() {},
    hasUnbundleLayout: () => false, openBundleConfig() {},
    openUnbundleConfig() {} });
const foldMock = mock({ foldButton: () => null, installFold() {},
    isFolded: () => false, syncFold() {} });

async function load(file, link) {
    const mod = new vm.SourceTextModule(
        await readFile(new URL(file, root), "utf8"),
        { context, identifier: file });
    await mod.link(link);
    await mod.evaluate();
    return mod;                     // the MODULE: linking needs it as-is
}

const constantsMod = await load("obvpm_constants.js", (spec) => {
    if (spec.endsWith("scripts/app.js")) return appMock;
    if (spec === "./obvpm_ui.js") return uiMock;
    throw new Error("unexpected import " + spec);
});
const dynamicMod = await load("obvpm_dynamic.js", (spec) => {
    if (spec.endsWith("scripts/app.js")) return appMock;
    if (spec === "./obvpm_constants.js") return constantsMod;
    if (spec === "./obvpm_image_limits.js") return limitsMock;
    if (spec === "./obvpm_bundle_config.js") return configMock;
    if (spec === "./obvpm_ui.js") return uiMock;
    if (spec === "./obvpm_fold.js") return foldMock;
    throw new Error("unexpected import " + spec);
});
const { resolveUnbundleOutput, unbundleIsVirtual, bundleNamesFor } =
    dynamicMod.namespace;
const { BUNDLE, UNBUNDLE, MODE_NEVER, MODE_BYPASS } = constantsMod.namespace;

// ---- fake graph toolkit -------------------------------------------------
let nextLinkId = 1;
function makeGraph(name) {
    return {
        name, _nodes: [], links: new Map(),
        inputNode: { id: "__in__", type: "SubgraphInputNode",
                     inputs: [], outputs: [{ name: "out0" }] },
        outputNode: { id: "__out__", type: "SubgraphOutputNode",
                      inputs: [], isVirtualNode: false },
        add(n) { this._nodes.push(n); n.graph = this; },
        getNodeById(id) { return this._nodes.find((n) => n.id === id)
            ?? (id === "__in__" ? this.inputNode
            : id === "__out__" ? this.outputNode : null); },
    };
}
function makeNode(graph, id, type, opts = {}) {
    const n = {
        id, type, graph,
        inputs: opts.inputs ?? [], outputs: opts.outputs ?? [],
        widgets: opts.widgets ?? [],
        properties: opts.properties ?? {},
        mode: opts.mode ?? 0,
        subgraph: opts.subgraph ?? null,
        isVirtualNode: !!opts.virtual,
    };
    graph.add(n);
    return n;
}
function wire(graph, origin, originSlot, target, targetSlot) {
    const link = {
        id: nextLinkId++, origin_id: origin.id, origin_slot: originSlot,
        target_id: target.id, target_slot: targetSlot,
    };
    graph.links.set(link.id, link);
    target.inputs[targetSlot].link = link.id;
    (origin.outputs[originSlot].links ??= []).push(link.id);
    return link;
}
function widgetOf(node, name, value) {
    const w = { name, value, type: "text" };
    node.widgets.push(w);
    return w;
}
// A Bundle fake the way the real node looks to the tracer: hidden names
// widget, in_N sockets, one OBVPM_BUNDLE output.
function makeBundle(graph, id, names, nInputs, opts = {}) {
    const inputs = [];
    for (let i = 1; i <= nInputs; i++) inputs.push({ name: `in_${i}` });
    const b = makeNode(graph, id, BUNDLE, {
        ...opts, inputs,
        outputs: [{ name: "out", type: "OBVPM_BUNDLE" }],
    });
    widgetOf(b, "names", names);
    return b;
}
function makeUnbundle(graph, id, outputs, opts = {}) {
    return makeNode(graph, id, UNBUNDLE, {
        ...opts,
        inputs: opts.getMode ? [] : [{ name: "in" }],
        outputs: outputs.map((label, i) =>
            ({ name: `out_${i + 1}`, label, links: [] })),
    });
}
const outs = (labels) => labels;
const answer = (r, node, slot) => !!r && r.node === node && r.slot === slot;

// The PR's example graph: a checkpoint, its own VAELoader (the branch you
// would swap), a Bundle packing model/clip/vae, an Unbundle reading it.
function packedGraph() {
    const g = makeGraph("root");
    app.rootGraph = g;
    const ckpt = makeNode(g, 1, "CheckpointLoaderSimple", {
        outputs: [{ name: "MODEL" }, { name: "CLIP" }, { name: "VAE" }],
    });
    const vaeLoader = makeNode(g, 2, "VAELoader",
        { outputs: [{ name: "VAE" }] });
    const bundle = makeBundle(g, 10, "model\nclip\nvae", 3);
    const unbundle = makeUnbundle(g, 11, outs(["model", "vae"]));
    wire(g, ckpt, 0, bundle, 0);      // model
    wire(g, ckpt, 1, bundle, 1);      // clip
    wire(g, vaeLoader, 0, bundle, 2); // vae -- its own loader, easy to swap
    wire(g, bundle, 0, unbundle, 0);
    return { g, ckpt, vaeLoader, bundle, unbundle };
}

// ---- the resolver -------------------------------------------------------

test("packed model/clip/vae resolves field by field", () => {
    const { ckpt, vaeLoader, bundle, unbundle } = packedGraph();
    assert.equal(JSON.stringify(bundleNamesFor(unbundle, "in")),
                 JSON.stringify(["model", "clip", "vae"]));
    assert.equal(unbundleIsVirtual(unbundle), true);
    assert.ok(answer(resolveUnbundleOutput(unbundle, 0), ckpt, 0));
    assert.ok(answer(resolveUnbundleOutput(unbundle, 1), vaeLoader, 0));
    assert.ok(bundle);
});

test("an unlabelled spare output carries no field", () => {
    const { unbundle } = packedGraph();
    unbundle.outputs.push({ name: "out_4", links: [] });
    assert.equal(resolveUnbundleOutput(unbundle, 3), undefined);
});

test("the gate reads only the outputs a consumer actually reads", () => {
    const { g, vaeLoader, unbundle } = packedGraph();
    assert.equal(unbundleIsVirtual(unbundle), true,
                 "no Unbundle output is wired to anything yet");
    assert.ok(answer(resolveUnbundleOutput(unbundle, 1), vaeLoader, 0),
              "it still answers what vae IS");
    const decode = makeNode(g, 12, "VAEDecode", {
        inputs: [{ name: "samples" }, { name: "vae" }],
        outputs: [{ name: "IMAGE" }],
    });
    wire(g, unbundle, 1, decode, 1);      // only the vae output is read
    assert.equal(unbundleIsVirtual(unbundle), true,
                 "the wired output resolves; the unwired one does not "
                 + "block");
});

test("constants: Bundle set -> Unbundle get", () => {
    const { g, ckpt } = packedGraph();
    const setter = makeBundle(g, 20, "model", 1);
    widgetOf(setter, "set", "my_bundle");
    setter.properties.obvpm_constant = true;
    wire(g, ckpt, 0, setter, 0);
    const getter = makeUnbundle(g, 21, outs(["model"]), { getMode: true });
    widgetOf(getter, "get", "my_bundle");
    getter.properties.obvpm_constant = true;
    assert.equal(unbundleIsVirtual(getter), true);
    assert.ok(answer(resolveUnbundleOutput(getter, 0), ckpt, 0));
});

test("KJ Set/Get carrying a bundle", () => {
    const { g, ckpt, bundle } = packedGraph();
    const set = makeNode(g, 30, "SetNode", {
        inputs: [{ name: "set" }], virtual: true,
        outputs: [{ name: "OUTPUT", type: "*" }],
    });
    widgetOf(set, "name", "kj_bundle");
    wire(g, bundle, 0, set, 0);
    const get = makeNode(g, 31, "GetNode", {
        inputs: [], virtual: true,
        outputs: [{ name: "OUTPUT", type: "*" }],
    });
    widgetOf(get, "name", "kj_bundle");
    const consumer = makeUnbundle(g, 32, outs(["model", "clip", "vae"]));
    wire(g, get, 0, consumer, 0);
    assert.equal(unbundleIsVirtual(consumer), true);
    assert.ok(answer(resolveUnbundleOutput(consumer, 0), ckpt, 0));
    assert.ok(answer(resolveUnbundleOutput(consumer, 1), ckpt, 1));
});

test("a switch on the wire: stays real (the server unpacks)", () => {
    const { g, bundle } = packedGraph();
    const sw = makeNode(g, 40, "LazyCaseSwitch (obvpm)", {
        inputs: [{ name: "on_case_1" }],
        outputs: [{ name: "out", type: "*" }],
    });
    wire(g, bundle, 0, sw, 0);
    const unbundle = makeUnbundle(g, 41, outs(["model"]));
    wire(g, sw, 0, unbundle, 0);
    assert.equal(unbundleIsVirtual(unbundle), false);
    assert.equal(resolveUnbundleOutput(unbundle, 0), undefined);
});

test("a Value Presets packer on the wire: stays real", () => {
    const { g } = packedGraph();
    const vp = makeNode(g, 50, "ValuePresets (obvpm)", {
        outputs: [{ name: "out", type: "OBVPM_BUNDLE" }],
    });
    const unbundle = makeUnbundle(g, 51, outs(["model"]));
    wire(g, vp, 0, unbundle, 0);
    assert.equal(unbundleIsVirtual(unbundle), false);
});

test("nothing on `in`: stays real", () => {
    const { g } = packedGraph();
    const unbundle = makeUnbundle(g, 60, outs(["model"]));
    assert.equal(unbundleIsVirtual(unbundle), false);
});

test("a muted packer: stays real, the server keeps its loud error", () => {
    const { g, ckpt } = packedGraph();
    const muted = makeBundle(g, 95, "model", 1, { mode: MODE_NEVER });
    wire(g, ckpt, 0, muted, 0);
    const unbundle = makeUnbundle(g, 96, outs(["model"]));
    wire(g, muted, 0, unbundle, 0);
    assert.equal(resolveUnbundleOutput(unbundle, 0), undefined);
    assert.equal(unbundleIsVirtual(unbundle), false);
});

test("a bypassed packer: stays real", () => {
    const { g, ckpt } = packedGraph();
    const bypassed = makeBundle(g, 97, "model", 1, { mode: MODE_BYPASS });
    wire(g, ckpt, 0, bypassed, 0);
    const unbundle = makeUnbundle(g, 98, outs(["model"]));
    wire(g, bypassed, 0, unbundle, 0);
    assert.equal(unbundleIsVirtual(unbundle), false);
});

test("duplicate names: the later line wins, as the server packs", () => {
    const { g } = packedGraph();
    const dup = makeBundle(g, 100, "a\na", 2);
    const l1 = makeNode(g, 101, "VAELoader", { outputs: [{ name: "VAE" }] });
    const l2 = makeNode(g, 102, "VAELoader", { outputs: [{ name: "VAE" }] });
    wire(g, l1, 0, dup, 0);
    wire(g, l2, 0, dup, 1);
    const unbundle = makeUnbundle(g, 103, outs(["a"]));
    wire(g, dup, 0, unbundle, 0);
    assert.ok(answer(resolveUnbundleOutput(unbundle, 0), l2, 0));
});

test("a configured subset pulls BY NAME, not by position", () => {
    const { g, ckpt, vaeLoader, bundle } = packedGraph();
    const byVae = makeUnbundle(g, 105, outs(["vae"]));
    wire(g, bundle, 0, byVae, 0);
    widgetOf(byVae, "names", "vae");
    assert.ok(answer(resolveUnbundleOutput(byVae, 0), vaeLoader, 0));
    const byClip = makeUnbundle(g, 106, outs(["clip"]));
    wire(g, bundle, 0, byClip, 0);
    widgetOf(byClip, "names", "clip");
    assert.ok(answer(resolveUnbundleOutput(byClip, 0), ckpt, 1));
});

test("a gap in the in_N sockets: line i still maps to in_i", () => {
    // The server packs line i from in_i BY NUMBER, wired or not; picking
    // the carrier by its position among the CONNECTED inputs would hand
    // "model" whatever in_2 carries.
    const { g } = packedGraph();
    const sink = (id) => makeNode(g, id, "PreviewImage",
        { inputs: [{ name: "images" }] });
    const ckpt2 = makeNode(g, 110, "CheckpointLoaderSimple", {
        outputs: [{ name: "MODEL" }, { name: "CLIP" }],
    });
    const bundle = makeBundle(g, 111, "model\nclip", 2);
    wire(g, ckpt2, 1, bundle, 1);         // in_1 left UNWIRED, in_2 <- clip
    const full = makeUnbundle(g, 112, outs(["model", "clip"]));
    wire(g, bundle, 0, full, 0);
    wire(g, full, 0, sink(114), 0);       // both outputs are read
    wire(g, full, 1, sink(115), 0);
    assert.equal(resolveUnbundleOutput(full, 0), undefined,
                 "model's input is unwired, it unpacks as None");
    assert.ok(answer(resolveUnbundleOutput(full, 1), ckpt2, 1),
              "clip still maps to in_2, not to whatever is connected");
    assert.equal(unbundleIsVirtual(full), false,
                 "one wired output cannot be answered: stay real");
    const clipOnly = makeUnbundle(g, 113, outs(["model", "clip"]));
    wire(g, bundle, 0, clipOnly, 0);      // only the clip output is read
    wire(g, clipOnly, 1, sink(116), 0);
    assert.ok(answer(resolveUnbundleOutput(clipOnly, 1), ckpt2, 1));
    assert.equal(unbundleIsVirtual(clipOnly), true);
});

test("a field wire through a Reroute answers the Reroute", () => {
    const { g, ckpt } = packedGraph();
    const rr = makeNode(g, 115, "Reroute", {
        inputs: [{ name: "Reroute" }], virtual: true,
        outputs: [{ name: "Reroute", type: "*" }],
    });
    const bundle = makeBundle(g, 116, "model", 1);
    wire(g, ckpt, 0, rr, 0);
    wire(g, rr, 0, bundle, 0);
    const unbundle = makeUnbundle(g, 117, outs(["model"]));
    wire(g, bundle, 0, unbundle, 0);
    assert.ok(answer(resolveUnbundleOutput(unbundle, 0), rr, 0),
              "the core keeps resolving from there");
});

// ---- nested bundles -----------------------------------------------------

test("a field that IS a whole bundle answers that bundle's own wire", () => {
    const { g, ckpt } = packedGraph();
    const inner = makeBundle(g, 120, "model", 1);
    wire(g, ckpt, 0, inner, 0);
    const outer = makeBundle(g, 121, "model\nnested", 2);
    wire(g, ckpt, 0, outer, 0);
    wire(g, inner, 0, outer, 1);
    const unbundle = makeUnbundle(g, 122, outs(["model", "nested"]));
    wire(g, outer, 0, unbundle, 0);
    assert.equal(unbundleIsVirtual(unbundle), true);
    assert.ok(answer(resolveUnbundleOutput(unbundle, 0), ckpt, 0));
    assert.ok(answer(resolveUnbundleOutput(unbundle, 1), inner, 0),
              "whoever reads it wants A bundle; here is where it is made");
});

test("a nested bundle fed by a Value Presets node answers the presets", () => {
    const { g, ckpt } = packedGraph();
    const vp = makeNode(g, 125, "ValuePresets (obvpm)", {
        outputs: [{ name: "out", type: "OBVPM_BUNDLE" }],
    });
    const outer = makeBundle(g, 126, "model\nnested", 2);
    wire(g, ckpt, 0, outer, 0);
    wire(g, vp, 0, outer, 1);
    const unbundle = makeUnbundle(g, 127, outs(["model", "nested"]));
    wire(g, outer, 0, unbundle, 0);
    assert.ok(answer(resolveUnbundleOutput(unbundle, 1), vp, 0));
});

test("an Unbundle of a nested field resolves through the virtual one", () => {
    const { g, ckpt } = packedGraph();
    const inner = makeBundle(g, 130, "model", 1);
    wire(g, ckpt, 0, inner, 0);
    const outer = makeBundle(g, 131, "model\nnested", 2);
    wire(g, ckpt, 0, outer, 0);
    wire(g, inner, 0, outer, 1);
    const first = makeUnbundle(g, 132, outs(["model", "nested"]));
    wire(g, outer, 0, first, 0);
    const second = makeUnbundle(g, 133, outs(["model"]));
    wire(g, first, 1, second, 0);         // the nested bundle travels on
    assert.equal(unbundleIsVirtual(first), true);
    assert.equal(unbundleIsVirtual(second), true,
                 "the answer is a virtual Unbundle; the builder keeps "
                 + "resolving through it");
    assert.ok(answer(resolveUnbundleOutput(second, 0), ckpt, 0));
});

test("Bundle to List / Peek Bundle on a nested field keeps working", () => {
    // A real consumer of the whole inner bundle (its input is required):
    // the answer is the wire that inner bundle came in on, so the
    // consumer is fed exactly as if the Unbundle were not there.
    const { g, ckpt } = packedGraph();
    const inner = makeBundle(g, 136, "model", 1);
    wire(g, ckpt, 0, inner, 0);
    const outer = makeBundle(g, 137, "model\nnested", 2);
    wire(g, ckpt, 0, outer, 0);
    wire(g, inner, 0, outer, 1);
    const unbundle = makeUnbundle(g, 138, outs(["nested", "model"]));
    wire(g, outer, 0, unbundle, 0);
    const toList = makeNode(g, 139, "Bundle to List (obvpm)", {
        inputs: [{ name: "bundle" }],
        outputs: [{ name: "list", type: "*" }],
    });
    wire(g, unbundle, 0, toList, 0);
    assert.equal(unbundleIsVirtual(unbundle), true);
    assert.ok(answer(resolveUnbundleOutput(unbundle, 0), inner, 0));
});

// ---- subgraphs ----------------------------------------------------------

test("Unbundle inside a subgraph, Bundle outside: climbs out", () => {
    const { g, ckpt, bundle } = packedGraph();
    const sub = makeGraph("sub A");
    const inUnbundle = makeUnbundle(sub, 70, outs(["model"]));
    wire(sub, sub.inputNode, 0, inUnbundle, 0);   // from the boundary
    const inst = makeNode(g, 71, "SubgraphNode", {
        inputs: [{ name: "in0" }],
        outputs: [{ name: "out0", type: "*" }],
        subgraph: sub,
    });
    inst.isSubgraphNode = () => true;
    wire(g, bundle, 0, inst, 0);                  // the bundle enters here
    assert.equal(unbundleIsVirtual(inUnbundle), true);
    assert.ok(answer(resolveUnbundleOutput(inUnbundle, 0), ckpt, 0),
              "the answer is the wire's origin outside the subgraph");
});

test("Bundle packed inside a subgraph, consumer outside: reads through",
     () => {
    const { g } = packedGraph();
    const sub = makeGraph("sub B");
    sub.outputNode.inputs = [{ name: "pass" }];
    const innerBundle = makeBundle(sub, 80, "model", 1);
    const innerLoader = makeNode(sub, 81, "VAELoader",
        { outputs: [{ name: "VAE" }] });
    wire(sub, innerLoader, 0, innerBundle, 0);
    wire(sub, innerBundle, 0, sub.outputNode, 0);
    const inst = makeNode(g, 82, "SubgraphNode", {
        outputs: [{ name: "out0", type: "OBVPM_BUNDLE" }],
        subgraph: sub,
    });
    inst.isSubgraphNode = () => true;
    const unbundle = makeUnbundle(g, 83, outs(["model"]));
    wire(g, inst, 0, unbundle, 0);
    assert.equal(unbundleIsVirtual(unbundle), true);
    assert.ok(answer(resolveUnbundleOutput(unbundle, 0), innerLoader, 0));
});

test("a subgraph used twice: the inner Unbundle stays real", () => {
    // Copies share their inner node objects, and the prompt builder picks
    // a virtual answer's DTO by object identity -- resolving through the
    // definition would hand every copy the first copy's values.
    const { g, ckpt, bundle } = packedGraph();
    const sub = makeGraph("sub used twice");
    const innerBundle = makeBundle(sub, 140, "model", 1);
    const innerLoader = makeNode(sub, 141, "VAELoader",
        { outputs: [{ name: "VAE" }] });
    wire(sub, innerLoader, 0, innerBundle, 0);
    const innerUnbundle = makeUnbundle(sub, 142, outs(["model"]));
    wire(sub, innerBundle, 0, innerUnbundle, 0);
    const sink = makeNode(sub, 145, "PreviewImage",
        { inputs: [{ name: "images" }] });
    wire(sub, innerUnbundle, 0, sink, 0); // something reads its output
    for (const id of [143, 144]) {
        const inst = makeNode(g, id, "SubgraphNode", { subgraph: sub });
        inst.isSubgraphNode = () => true;
    }
    assert.equal(unbundleIsVirtual(innerUnbundle), false);
    assert.equal(resolveUnbundleOutput(innerUnbundle, 0), undefined);
    assert.ok(ckpt && bundle);
});

test("a bundle packed inside a twice-used subgraph: stays real outside",
     () => {
    const { g } = packedGraph();
    const sub = makeGraph("sub B, twice");
    sub.outputNode.inputs = [{ name: "pass" }];
    const innerBundle = makeBundle(sub, 146, "model", 1);
    const innerLoader = makeNode(sub, 147, "VAELoader",
        { outputs: [{ name: "VAE" }] });
    wire(sub, innerLoader, 0, innerBundle, 0);
    wire(sub, innerBundle, 0, sub.outputNode, 0);
    for (const id of [148, 149]) {
        const inst = makeNode(g, id, "SubgraphNode",
            { outputs: [{ name: "out0", type: "OBVPM_BUNDLE" }],
              subgraph: sub });
        inst.isSubgraphNode = () => true;
    }
    const unbundle = makeUnbundle(g, 150, outs(["model"]));
    const inst0 = g._nodes.find((n) => n.id === 148);
    wire(g, inst0, 0, unbundle, 0);
    const sink = makeNode(g, 151, "PreviewImage",
        { inputs: [{ name: "images" }] });
    wire(g, unbundle, 0, sink, 0);        // its output is read
    assert.equal(unbundleIsVirtual(unbundle), false);
    assert.equal(resolveUnbundleOutput(unbundle, 0), undefined);
});

test("a field fed through the boundary of a twice-used subgraph: stays real",
     () => {
    const { g, bundle } = packedGraph();
    const sub = makeGraph("boundary, twice");
    const inUnbundle = makeUnbundle(sub, 152, outs(["model"]));
    wire(sub, sub.inputNode, 0, inUnbundle, 0);
    const sink = makeNode(sub, 155, "PreviewImage",
        { inputs: [{ name: "images" }] });
    wire(sub, inUnbundle, 0, sink, 0);    // its output is read
    for (const id of [153, 154]) {
        const inst = makeNode(g, id, "SubgraphNode",
            { inputs: [{ name: "in0" }], subgraph: sub });
        inst.isSubgraphNode = () => true;
    }
    const inst0 = g._nodes.find((n) => n.id === 153);
    wire(g, bundle, 0, inst0, 0);
    assert.equal(unbundleIsVirtual(inUnbundle), false);
    assert.equal(resolveUnbundleOutput(inUnbundle, 0), undefined);
});

test("a value crossing TWO subgraph boundaries resolves to its source", () => {
    const { g, ckpt } = packedGraph();
    const inner = makeGraph("inner");
    const outerSub = makeGraph("outer");
    const inBundle = makeBundle(inner, 156, "model", 1);
    const inUnbundle = makeUnbundle(inner, 157, outs(["model"]));
    wire(inner, inner.inputNode, 0, inBundle, 0);
    wire(inner, inBundle, 0, inUnbundle, 0);
    const sink = makeNode(inner, 160, "PreviewImage",
        { inputs: [{ name: "images" }] });
    wire(inner, inUnbundle, 0, sink, 0);  // its output is read
    const innerInst = makeNode(outerSub, 158, "SubgraphNode", {
        inputs: [{ name: "in0" }], subgraph: inner,
    });
    innerInst.isSubgraphNode = () => true;
    wire(outerSub, outerSub.inputNode, 0, innerInst, 0);
    const outerInst = makeNode(g, 159, "SubgraphNode", {
        inputs: [{ name: "in0" }], subgraph: outerSub,
    });
    outerInst.isSubgraphNode = () => true;
    wire(g, ckpt, 0, outerInst, 0);       // the FIELD enters from the root
    assert.equal(unbundleIsVirtual(inUnbundle), true);
    assert.ok(answer(resolveUnbundleOutput(inUnbundle, 0), ckpt, 0),
              "the climb goes out through both boundaries");
});

// ---- what the prompt builder will have ------------------------------------

test("a Bundle inside a muted subgraph: stays real (the 011 upscale VAEs)",
     () => {
    // The subgraph is muted while not upscaling, so its inner nodes are
    // not in the prompt; an answer pointing at one aborted the WHOLE
    // build ("No DTO found for virtual source node").
    const { g } = packedGraph();
    const sub = makeGraph("sub muted");
    sub.outputNode.inputs = [{ name: "pass" }];
    const innerBundle = makeBundle(sub, 120, "vae", 1);
    const innerLoader = makeNode(sub, 121, "VAELoader",
        { outputs: [{ name: "VAE", type: "VAE" }] });
    wire(sub, innerLoader, 0, innerBundle, 0);
    wire(sub, innerBundle, 0, sub.outputNode, 0);
    const inst = makeNode(g, 122, "SubgraphNode", {
        outputs: [{ name: "out0", type: "OBVPM_BUNDLE" }],
        subgraph: sub, mode: MODE_NEVER,
    });
    inst.isSubgraphNode = () => true;
    const unbundle = makeUnbundle(g, 123, outs(["vae"]));
    wire(g, inst, 0, unbundle, 0);
    const decode = makeNode(g, 124, "VAEDecode",
        { inputs: [{ name: "vae", type: "VAE" }] });
    wire(g, unbundle, 0, decode, 0);
    assert.equal(resolveUnbundleOutput(unbundle, 0), undefined);
    assert.equal(unbundleIsVirtual(unbundle), false);
    inst.mode = 0;
    assert.equal(unbundleIsVirtual(unbundle), true,
                 "the same wiring, the subgraph live: left out");
});

test("a field whose source is muted: stays real", () => {
    const { g, vaeLoader, unbundle } = packedGraph();
    const decode = makeNode(g, 125, "VAEDecode",
        { inputs: [{ name: "vae" }] });
    wire(g, unbundle, 1, decode, 0);
    vaeLoader.mode = MODE_NEVER;
    assert.equal(unbundleIsVirtual(unbundle), false);
});

// ---- the server's type check --------------------------------------------
// A real Unbundle's outputs are "*", which the server lets into any input;
// left out, the consumer is wired straight to the source and the server
// compares the two types (validate_node_input).

function typedGraph(sourceType, consumerType) {
    const g = makeGraph("root");
    app.rootGraph = g;
    const src = makeNode(g, 1, "Source",
        { outputs: [{ name: "v", type: sourceType }] });
    const bundle = makeBundle(g, 2, "v", 1);
    wire(g, src, 0, bundle, 0);
    const unbundle = makeUnbundle(g, 3, outs(["v"]));
    wire(g, bundle, 0, unbundle, 0);
    const consumer = makeNode(g, 4, "Consumer",
        { inputs: [{ name: "x", type: consumerType }] });
    return { g, src, bundle, unbundle, consumer };
}

test("text into a dropdown: stays real (the server refuses STRING -> COMBO)",
     () => {
    const { g, unbundle, consumer } = typedGraph("STRING", "COMBO");
    wire(g, unbundle, 0, consumer, 0);
    assert.equal(unbundleIsVirtual(unbundle), false);
});

test("INT into FLOAT: stays real", () => {
    const { g, unbundle, consumer } = typedGraph("INT", "FLOAT");
    wire(g, unbundle, 0, consumer, 0);
    assert.equal(unbundleIsVirtual(unbundle), false);
});

test("matching types, '*', and a shared listed type: left out", () => {
    for (const [got, want] of [["STRING", "STRING"], ["IMAGE", "*"],
                               ["*", "COMBO"], ["INT", "INT,FLOAT"]]) {
        const { g, unbundle, consumer } = typedGraph(got, want);
        wire(g, unbundle, 0, consumer, 0);
        assert.equal(unbundleIsVirtual(unbundle), true, `${got} -> ${want}`);
    }
});

test("through a Reroute into a dropdown: stays real", () => {
    const { g, unbundle, consumer } = typedGraph("STRING", "COMBO");
    const reroute = makeNode(g, 5, "Reroute", {
        inputs: [{ name: "", type: "*" }],
        outputs: [{ name: "", type: "*" }], virtual: true,
    });
    wire(g, unbundle, 0, reroute, 0);
    wire(g, reroute, 0, consumer, 0);
    assert.equal(unbundleIsVirtual(unbundle), false);
});

test("text behind a Reroute on the Bundle's side, into a dropdown: stays real",
     () => {
    const g = makeGraph("root");
    app.rootGraph = g;
    const src = makeNode(g, 1, "Source",
        { outputs: [{ name: "v", type: "STRING" }] });
    const reroute = makeNode(g, 2, "Reroute", {
        inputs: [{ name: "", type: "*" }],
        outputs: [{ name: "", type: "*" }], virtual: true,
    });
    reroute.getInputLink = () => g.links.get(reroute.inputs[0].link);
    wire(g, src, 0, reroute, 0);
    const bundle = makeBundle(g, 3, "v", 1);
    wire(g, reroute, 0, bundle, 0);
    const unbundle = makeUnbundle(g, 4, outs(["v"]));
    wire(g, bundle, 0, unbundle, 0);
    const consumer = makeNode(g, 5, "Consumer",
        { inputs: [{ name: "x", type: "COMBO" }] });
    wire(g, unbundle, 0, consumer, 0);
    assert.equal(unbundleIsVirtual(unbundle), false);
});

test("answered once per prompt build, live outside one", async () => {
    const { g, vaeLoader, unbundle } = packedGraph();
    const decode = makeNode(g, 126, "VAEDecode",
        { inputs: [{ name: "vae" }] });
    wire(g, unbundle, 1, decode, 0);
    const ext = extensions.find((e) => e.name === "obvpm.dynamic");
    const seen = [];
    app.graphToPrompt = async function () {
        seen.push(unbundleIsVirtual(unbundle));
        vaeLoader.mode = MODE_NEVER;          // changed mid-build: not seen
        seen.push(unbundleIsVirtual(unbundle));
        return {};
    };
    ext.setup();
    await app.graphToPrompt();
    assert.deepEqual(seen, [true, true], "one answer for the whole build");
    assert.equal(unbundleIsVirtual(unbundle), false, "live again after it");
    ext.setup();
    assert.equal(app.graphToPrompt.__obvpmVirtualMemo, true);
    vaeLoader.mode = 0;
});

// ---- the prototype hooks ------------------------------------------------

test("the hooks are installed on the Unbundle prototype only, and gate",
     async () => {
    const ext = extensions.find((e) => e.name === "obvpm.dynamic");
    assert.ok(ext, "obvpm.dynamic registered");
    const nodeData = {
        name: "Unbundle (obvpm)",
        output_name: Array.from({ length: 16 }, (_, i) => `out_${i + 1}`),
        input: { optional: { in: {}, names: {}, get: {} } },
    };
    class UnbundleType {
        getInputLink() { return "BASE"; }   // what a real node would do
    }
    let threw = null;
    try {
        await ext.beforeRegisterNodeDef(UnbundleType, nodeData);
    } catch (err) {
        // Anything DOM-shaped later in the hook may throw under node; the
        // cache-fix block runs FIRST, so the hooks must already be there.
        threw = err;
    }
    const proto = UnbundleType.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "isVirtualNode");
    assert.ok(desc?.get, "isVirtualNode installed as a getter");
    assert.equal(typeof proto.resolveVirtualOutput, "function");
    assert.equal(typeof proto.getInputLink, "function");

    // Per-instance, wire-driven answers: two instances of ONE prototype
    // disagreeing, which a flag could never do.
    const g = makeGraph("root");
    app.rootGraph = g;
    const ckpt = makeNode(g, 1, "CheckpointLoaderSimple",
        { outputs: [{ name: "MODEL" }] });
    const bundle = makeBundle(g, 2, "model", 1);
    wire(g, ckpt, 0, bundle, 0);
    const virt = Object.create(proto);
    virt.graph = g;
    virt.inputs = [{ name: "in" }];
    virt.outputs = [{ name: "out_1", label: "model", links: [] }];
    wire(g, bundle, 0, virt, 0);
    assert.equal(virt.isVirtualNode, true);
    assert.ok(answer(proto.resolveVirtualOutput.call(virt, 0), ckpt, 0));
    assert.equal(proto.getInputLink.call(virt, 0), null,
                 "a left-out node answers null on the through-path");
    const lonely = Object.create(proto);
    lonely.graph = g;
    lonely.inputs = [{ name: "in" }];
    lonely.outputs = [{ name: "out_1", label: "model", links: [] }];
    assert.equal(lonely.isVirtualNode, false);
    assert.equal(proto.getInputLink.call(lonely, 0), "BASE",
                 "a real Unbundle keeps the base behaviour");

    const other = class OtherType {};
    try {
        await ext.beforeRegisterNodeDef(other, {
            name: "Bundle (obvpm)", input: { optional: {} },
        });
    } catch { /* same: later DOM work is allowed to fail under node */ }
    assert.equal(Object.getOwnPropertyDescriptor(other.prototype,
                                             "isVirtualNode"), undefined,
                 "the Bundle prototype is untouched");
    if (threw) assert.ok(threw);    // harness noise, not a hook failure
});
