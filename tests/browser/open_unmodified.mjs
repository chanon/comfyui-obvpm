// Opening a workflow must not mark it modified. Loads <file.json> through
// the real frontend (headless Edge), touches nothing, waits, and asks
// ComfyUI's change tracker whether the workflow now counts as changed --
// listing what differs between the state it took as the workflow opened
// and the state now. Exits 1 when it is marked modified.
//
// (Bundle and Unbundle named their sockets a moment after the tracker took
// its first state: a Bundle's spare input "+", an Unbundle's outputs
// "out_N (no line N)" while its bundle could not be traced yet -- every
// workflow with them opened as modified.)
//
// usage: node open_unmodified.mjs <url> <file.json> [--vue] [--web <dir>] [--wait ms]
//   --web <dir>  serve comfyui-obvpm's web files from <dir> (test a working
//                copy against a server that has another one installed)
// It writes nothing: settings and user-data writes are answered in flight
// and the settings are rewritten for this tab only.
import puppeteer from "puppeteer-core";
import { existsSync, readFileSync } from "node:fs";

const [url, file, ...rest] = process.argv.slice(2);
const VUE = rest.includes("--vue");
const opt = (k) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : null);
const WEB = opt("--web")?.replace(/[\\/]*$/, "/") ?? null;
const WAIT = Number(opt("--wait") ?? 8000);
const wf = JSON.parse(readFileSync(file, "utf-8"));

const browser = await puppeteer.launch({
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true, args: ["--no-sandbox", "--window-size=1600,1000"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e?.message ?? e).slice(0, 200)));
page.on("dialog", (d) => d.accept().catch(() => {}));
page.on("console", (m) => { if (m.text().includes("[obvpm-dbg]")) console.log(m.text().slice(0, 700)); });
await page.setRequestInterception(true);
page.on("request", async (r) => {
    const u = r.url(), m = r.method();
    try {
        if (m === "GET" && /\/api\/settings$/.test(u)) {
            const json = await (await fetch(u)).json();
            json["Comfy.VueNodes.Enabled"] = VUE;
            json["Comfy.Workflow.Persist"] = false;
            json["Comfy.TutorialCompleted"] = true;
            json["Comfy.Workflow.ShowMissingNodesWarning"] = false;
            return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
        }
        if (m !== "GET" && /\/api\/(settings|userdata)/.test(u)) {
            return r.respond({ status: 200, contentType: "application/json", body: "{}" });
        }
        const own = WEB && m === "GET" && u.match(/\/extensions\/comfyui-obvpm\/([\w./-]+\.js)(\?|$)/)?.[1];
        if (own && existsSync(WEB + own)) {
            return r.respond({ status: 200, contentType: "text/javascript", body: readFileSync(WEB + own, "utf-8") });
        }
        if (/^https?:\/\/(?!127\.0\.0\.1|localhost)/.test(u)) return r.abort();
        return r.continue();
    } catch (e) {
        if (!r.isInterceptResolutionHandled?.()) r.continue().catch(() => {});
    }
});
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => window.app?.graph && window.app.extensionManager, { timeout: 120000, polling: 100 });
await new Promise((r) => setTimeout(r, 2000));
// opened as a workflow file is: a workflow of its own, with a change tracker
await page.evaluate(async (wf) => {
    await window.app.loadGraphData(wf, true, true, "open_unmodified_check");
}, wf);
await new Promise((r) => setTimeout(r, WAIT));
// one click on the canvas, away from the nodes: ComfyUI re-checks for
// changes on a click, so that is when the unsaved mark would show
await page.mouse.click(5, 990);
await new Promise((r) => setTimeout(r, 1500));
const got = await page.evaluate(() => {
    const wfs = window.app.extensionManager?.workflow?.activeWorkflow;
    const ct = wfs?.changeTracker;
    try { ct?.checkState?.(); } catch (e) { /* older frontend */ }
    const diffs = [];
    const a = ct?.initialState, b = ct?.activeState;
    const cmpNodes = (where, na, nb) => {
        const m = new Map((nb ?? []).map((n) => [n.id, n]));
        for (const n of na ?? []) {
            const o = m.get(n.id);
            if (!o) { diffs.push(`${where} node ${n.id} ${n.type}: gone`); continue; }
            for (const f of new Set([...Object.keys(n), ...Object.keys(o)])) {
                if (JSON.stringify(n[f]) === JSON.stringify(o[f])) continue;
                const plain = (v) => v && typeof v === "object" && !Array.isArray(v);
                if (plain(n[f]) && plain(o[f])) {
                    // name the keys that changed, not the whole object
                    for (const k of new Set([...Object.keys(n[f]), ...Object.keys(o[f])])) {
                        if (JSON.stringify(n[f][k]) !== JSON.stringify(o[f][k])) {
                            diffs.push(`${where} node ${n.id} ${n.type} ${f}.${k}: ${JSON.stringify(n[f][k])?.slice(0, 160)} -> ${JSON.stringify(o[f][k])?.slice(0, 160)}`);
                        }
                    }
                } else {
                    diffs.push(`${where} node ${n.id} ${n.type} ${f}: ${JSON.stringify(n[f])?.slice(0, 160)} -> ${JSON.stringify(o[f])?.slice(0, 160)}`);
                }
            }
        }
    };
    if (a && b) {
        cmpNodes("main", a.nodes, b.nodes);
        const gb = new Map((b.definitions?.subgraphs ?? []).map((g) => [g.id, g]));
        for (const g of a.definitions?.subgraphs ?? []) cmpNodes(`subgraph "${g.name}"`, g.nodes, gb.get(g.id)?.nodes);
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
            if (k === "nodes" || k === "definitions") continue;
            if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(`${k} differs`);
        }
    }
    return { modified: wfs?.isModified ?? null, tracked: !!(a && b), diffs };
});
console.log(`${VUE ? "Nodes 2.0" : "classic"}: modified on open: ${got.modified}` + (got.tracked ? "" : " (no change tracker states)")
            + (errors.length ? ` | page errors: ${errors.join(" / ")}` : ""));
for (const d of got.diffs.slice(0, 30)) console.log("  " + d);
await browser.close();
process.exit(got.modified === false ? 0 : 1);
