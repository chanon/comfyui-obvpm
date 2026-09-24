// Load a workflow (json or mp4) into a running ComfyUI through the real
// frontend in headless Edge and report any load error.
// usage: node load.mjs <url> <file> [--json]
import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const [url, file, ...rest] = process.argv.slice(2);
let bytes = readFileSync(file);
const dump = rest.includes("--dump") ? rest[rest.indexOf("--dump") + 1] : null;
const renames = rest.filter((a) => a.includes("=>")).map((a) => a.split("=>"));
if (renames.length) {
    const wf = JSON.parse(bytes.toString("utf-8"));
    const walk = (nodes) => nodes?.forEach((n) => { for (const [a, b] of renames) if (n.type === a) n.type = b; });
    walk(wf.nodes); wf.definitions?.subgraphs?.forEach((sg) => walk(sg.nodes));
    bytes = Buffer.from(JSON.stringify(wf));
}
const browser = await puppeteer.launch({
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    args: ["--no-sandbox", "--window-size=1600,1000"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const logs = [];
page.on("console", async (m) => {
    let t = m.text();
    if (t === "JSHandle@error") {
        const parts = await Promise.all(m.args().map((a) =>
            a.evaluate((v) => (v && v.stack) || String(v)).catch(() => "?")));
        t = parts.join(" ");
    }
    if (m.type() === "error" || /patching|circular|obvpm|TypeError|Loading aborted/i.test(t)) logs.push(`[${m.type()}] ${t}`);
});
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });
await page.waitForFunction(() => window.app?.graph && window.app?.canvas, { timeout: 120000 });
await new Promise((r) => setTimeout(r, 6000));
const vue = rest.includes("--vue");
await page.evaluate(async (vue) => {
    const st = window.app.extensionManager?.setting;
    await st?.set?.("Comfy.VueNodes.Enabled", vue);
    await st?.set?.("Comfy.Workflow.ShowMissingNodesWarning", false);
}, vue);
await new Promise((r) => setTimeout(r, 1500));
console.log("vue mode:", await page.evaluate(() => window.LiteGraph?.vueNodesMode ?? window.app.canvas?.constructor?.name));
const version = await page.evaluate(() => window.__COMFYUI_FRONTEND_VERSION__ ?? document.querySelector('meta[name="comfyui-frontend-version"]')?.content ?? "?");
if (rest.includes("--spread")) await page.evaluate(() => {
    let P = null;
    for (let p = Object.getPrototypeOf(window.app.graph._nodes[0]); p; p = Object.getPrototypeOf(p)) {
        if (Object.prototype.hasOwnProperty.call(p, "configure")) P = p;   // last owner = LGraphNode
    }
    console.log("patching configure on", P?.constructor?.name);
    const orig = P.configure;
    P.configure = function (info) {
        const r = orig.call(this, info);
        if (String(this.type).includes("(obvpm)")) {
            if (this.inputs) this.inputs = this.inputs.map((slot) => ({ ...slot }));
            if (this.outputs) this.outputs = this.outputs.map((slot) => ({ ...slot }));
        }
        return r;
    };
});
await page.evaluate(() => {
    const orig = JSON.stringify;
    window.__trap = [];
    const holdsNode = (v, depth, seen) => {
        if (!v || typeof v !== "object" || depth > 6 || seen.has(v)) return false;
        seen.add(v);
        if (Object.prototype.hasOwnProperty.call(v, "_node")) return true;
        for (const k in v) if (holdsNode(v[k], depth + 1, seen)) return true;
        return false;
    };
    JSON.stringify = function (v, ...r) {
        try {
            if (holdsNode(v, 0, new Set())) {
                const el = Array.isArray(v) ? v.find((e) => e && Object.prototype.hasOwnProperty.call(e, "_node")) : null;
                const n = el?._node;
                const info = el ? {
                    elCtor: el.constructor?.name, elKeys: Object.keys(el).join(","),
                    nodeCtor: n?.constructor?.name, nodeType: n?.type, nodeKeys: Object.keys(n ?? {}).slice(0, 40).join(","),
                    nodeHasToJSON: typeof n?.toJSON, nodeInputs0IsEl: n?.inputs?.[0] === el,
                    nodeInputsCtor: n?.inputs?.[0]?.constructor?.name, sameArray: n?.inputs === v,
                } : { vCtor: v?.constructor?.name, vKeys: Object.keys(v ?? {}).slice(0, 30).join(",") };
                window.__trap.push(JSON.stringify(info) + " || " + new Error().stack.split("\n").slice(2, 5).join(" <- "));
            }
        } catch (e) {}
        return orig.call(this, v, ...r);
    };
});
const result = await page.evaluate(async (b64, name) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const type = name.endsWith(".mp4") ? "video/mp4" : "application/json";
    const f = new File([arr], name, { type });
    const caught = [];
    const origErr = console.error;
    try {
        await window.app.handleFile(f, "file_drop");
    } catch (e) {
        caught.push("thrown: " + (e?.stack || e));
    }
    const dialog = [...document.querySelectorAll(".p-dialog")].map((d) => d.innerText.slice(0, 1500));
    return {
        serialized: JSON.stringify(window.app.graph.serialize()),
        trap: window.__trap,
        plainSlots: window.app.graph._nodes.filter((n) => (n.inputs ?? []).some((i) => i && i.constructor === Object && Object.prototype.hasOwnProperty.call(i, "_node"))).map((n) => `${n.id}:${n.type}`),
        slotCtor: [...new Set(window.app.graph._nodes.flatMap((n) => (n.inputs ?? []).map((i) => i?.constructor?.name)))],
        nodes: window.app.graph._nodes.length,
        types: [...new Set(window.app.graph._nodes.map((n) => n.type))].slice(0, 60),
        caught, dialog,
    };
}, bytes.toString("base64"), basename(file));
console.log("frontend", version);
if (dump) { (await import("node:fs")).writeFileSync(dump, result.serialized); console.log("dumped", dump); }
delete result.serialized;
await page.evaluate(async () => { const st = window.app.extensionManager?.setting; await st?.set?.("Comfy.VueNodes.Enabled", false); await st?.set?.("Comfy.Workflow.ShowMissingNodesWarning", true); });
console.log(JSON.stringify(result, null, 1));
console.log("--- console:");
for (const l of logs) console.log(l.slice(0, 2500));
await browser.close();
