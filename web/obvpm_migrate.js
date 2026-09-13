// Load-time migration of the bare node ids this pack used before 0.2.0.
//
// A node's class id is the key in ComfyUI's registry and the `type` in
// every saved workflow; it is the one name that has to be unique across
// packs. "Bundle" collided with another pack's node of the same id, so
// every id now carries the " (obvpm)" suffix. This module rewrites the old
// ids in a workflow BEFORE the graph is configured, so they never reach
// the missing-node check and the old files load as if nothing changed.
//
// Which nodes are ours is decided per node, not per id, because the
// collision is exactly the case where the old id is also somebody
// else's node: a saved "Bundle" with `in_N` inputs is ours, one with
// `input_N` inputs is theirs and is left alone. For the other ids the
// rule is "migrate unless another pack now registers that id", so a
// pack that adopts "Dropdown" tomorrow does not get its nodes hijacked.
//
// RENAMED mirrors ids.py; tests/test_ids.py keeps the two identical.
import { app } from "../../scripts/app.js";

export const RENAMED = {
    ImageOptionalGate: "ImageOptionalGate (obvpm)",
    VideoOptionalGate: "VideoOptionalGate (obvpm)",
    AudioOptionalGate: "AudioOptionalGate (obvpm)",
    ModelOptionalGate: "ModelOptionalGate (obvpm)",
    LatentOptionalGate: "LatentOptionalGate (obvpm)",
    AnyOptionalGate: "AnyOptionalGate (obvpm)",
    MuteGate: "MuteGate (obvpm)",
    LazySwitch: "LazySwitch (obvpm)",
    LazySwitch2: "LazySwitch2 (obvpm)",
    LazySwitch3: "LazySwitch3 (obvpm)",
    LazyCaseSwitch: "LazyCaseSwitch (obvpm)",
    LazyCaseSwitchAuto: "LazyCaseSwitchAuto (obvpm)",
    DownscaleImageToMegapixels: "DownscaleImageToMegapixels (obvpm)",
    FirstFloat: "FirstFloat (obvpm)",
    FirstInt: "FirstInt (obvpm)",
    Dropdown: "Dropdown (obvpm)",
    Bundle: "Bundle (obvpm)",
    UnbundleAuto: "Unbundle (obvpm)",
    BundlePeek: "PeekBundle (obvpm)",
    ValuePresets: "ValuePresets (obvpm)",
    LoadImageCrop: "LoadImageCrop (obvpm)",
    LoadImagesCompose: "LoadImagesCompose (obvpm)",
    LoraName: "LoraName (obvpm)",
    SamplerName: "SamplerName (obvpm)",
    SchedulerName: "SchedulerName (obvpm)",
    CleanVRAM: "CleanVRAM (obvpm)",
};

const OUR_IN = /^in_\d+$/;

/**
 * Is this saved node one of ours? `registered` says which ids some pack
 * currently registers (LiteGraph.registered_node_types, or a test's
 * stand-in).
 */
export function isOurs(node, registered) {
    const type = node?.type;
    if (!(type in RENAMED)) return false;
    const props = node.properties ?? {};
    if (props.cnr_id === "comfyui-obvpm"
        || /(^|\/)comfyui-obvpm$/.test(String(props.aux_id ?? ""))) return true;
    if (type === "Bundle") {
        // The colliding id: the slot names are the fingerprint. Ours
        // are in_N; the other pack's are input_N.
        return (node.inputs ?? []).some((s) => OUR_IN.test(String(s?.name)));
    }
    // Unclaimed by anyone else: it can only be ours.
    return !(registered && type in registered);
}

// A Value Presets schema borrows dropdowns by node id ("@LoraName.lora_name"),
// so the old ids also live inside that node's widget text.
const REF = new RegExp(`@(${Object.keys(RENAMED).join("|")})\\.`, "g");
const PRESETS = new Set(["ValuePresets", RENAMED.ValuePresets]);

function migrateRefs(node, log) {
    if (!PRESETS.has(node.type)) return 0;
    let n = 0;
    const fix = (v) => {
        if (typeof v !== "string" || !REF.test(v)) return v;
        REF.lastIndex = 0;
        n++;
        return v.replace(REF, (_, id) => `@${RENAMED[id]}.`);
    };
    // the positional array, and the by-name copy newer frontends save
    if (Array.isArray(node.widgets_values)) {
        node.widgets_values = node.widgets_values.map(fix);
    }
    const named = node.widgets_values_named;
    if (named && typeof named === "object") {
        for (const key of Object.keys(named)) named[key] = fix(named[key]);
    }
    if (n) log.push(`schema refs in #${node.id}`);
    return n;
}

function migrateNodes(nodes, registered, log) {
    if (!Array.isArray(nodes)) return 0;
    let n = 0;
    for (const node of nodes) {
        n += migrateRefs(node, log);
        if (!isOurs(node, registered)) continue;
        const to = RENAMED[node.type];
        log.push(`${node.type} -> ${to} (#${node.id})`);
        node.type = to;
        const props = node.properties;
        if (props && props["Node name for S&R"] in RENAMED) {
            props["Node name for S&R"] = RENAMED[props["Node name for S&R"]];
        }
        n++;
    }
    return n;
}

/**
 * Rewrite the old ids in a serialised workflow, top level and inside
 * every subgraph definition. Returns how many nodes changed. Idempotent:
 * a migrated workflow has nothing left to match.
 */
export function migrateGraph(graphData, registered) {
    if (!graphData || typeof graphData !== "object") return 0;
    const log = [];
    let n = migrateNodes(graphData.nodes, registered, log);
    for (const sub of graphData.definitions?.subgraphs ?? []) {
        n += migrateNodes(sub?.nodes, registered, log);
    }
    if (n) console.info(`obvpm: migrated ${n} node id(s) to the " (obvpm)" suffix:`, log);
    return n;
}

const registeredTypes = () => globalThis.LiteGraph?.registered_node_types;

app.registerExtension({
    name: "obvpm.migrate",
    setup() {
        // Everything a user opens -- a file, a template, a drop, undo
        // history -- comes through loadGraphData, and subgraph
        // definitions are instantiated inside it BEFORE the
        // beforeConfigureGraph hook fires. Rewriting on the way in is
        // the only point that is early enough for both.
        const orig = app.loadGraphData;
        if (typeof orig !== "function" || orig.__obvpmMigrate) return;
        const wrapped = async function (graphData, ...rest) {
            try { migrateGraph(graphData, registeredTypes()); } catch (e) {
                console.warn("obvpm: id migration skipped", e);
            }
            return orig.call(this, graphData, ...rest);
        };
        wrapped.__obvpmMigrate = true;
        app.loadGraphData = wrapped;
    },
    // Belt and braces for a host that hands the graph in by another
    // route: the hook runs before the missing-node scan, so a rewrite
    // here still keeps the old ids out of it.
    beforeConfigureGraph(graphData) {
        try { migrateGraph(graphData, registeredTypes()); } catch (e) {
            console.warn("obvpm: id migration skipped", e);
        }
    },
});
