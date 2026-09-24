// Does a node keep its size across workflow loads? Checklist item for
// every node with a custom widget: a node the user dragged small must
// come back that small, and an untouched one must not creep.
//
// Creates the node, optionally drags it to --drag=H, then saves and
// loads the workflow five times, printing the size each round. Exits 1
// if the size ever changes after a load.
//
// usage: node reload_size.mjs <url> [--vue] [--node=<NodeId>] [--drag=H]
//
// Touches nothing on the server: the settings the page reads are
// rewritten in flight (Nodes 2.0 on or off for this tab only) and every
// settings / userdata write is answered without reaching the server.
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://127.0.0.1:8188/";
const VUE = process.argv.includes("--vue");
const NODE = process.argv.find((a) => a.startsWith("--node="))?.slice(7) ?? "CompatibilityCheck (obvpm)";
const DRAG = Number(process.argv.find((a) => a.startsWith("--drag="))?.slice(7) ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true, args: ["--no-sandbox", "--window-size=1600,1000"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 300)));
page.on("dialog", (d) => d.accept().catch(() => {}));
await page.setRequestInterception(true);
page.on("request", async (r) => {
    const u = r.url(), m = r.method();
    try {
        if (m === "GET" && /\/api\/settings$/.test(u)) {
            const json = await (await fetch(u)).json();
            json["Comfy.VueNodes.Enabled"] = VUE;
            return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
        }
        if (m !== "GET" && /\/api\/(settings|userdata)/.test(u)) {
            return r.respond({ status: 200, contentType: "application/json", body: "{}" });
        }
    } catch (err) { errors.push("intercept: " + err.message); }
    return r.continue();
});
await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });
await page.waitForFunction(() => window.app?.graph && window.app?.canvas, { timeout: 120000 });
await sleep(4000);

let wf = await page.evaluate(async (type, drag) => {
    const app = window.app;
    app.graph.clear();
    const node = LiteGraph.createNode(type);
    node.pos = [200, 150];
    app.graph.add(node);
    await new Promise((r) => setTimeout(r, 2500));      // let it settle (and fit)
    if (drag) {
        node.setSize([node.size[0], drag]);
        await new Promise((r) => setTimeout(r, 800));
    }
    return app.graph.serialize();
}, NODE, DRAG);
const sizeOf = (w) => w.nodes.find((n) => n.type === NODE)?.size.map(Math.round);
const saved = sizeOf(wf);
const rounds = [(DRAG ? "dragged " : "created ") + JSON.stringify(saved)];
let moved = false;
for (let i = 1; i <= 5; i++) {
    wf = await page.evaluate(async (wf) => {
        await window.app.loadGraphData(wf);
        await new Promise((r) => setTimeout(r, 2500));
        return window.app.graph.serialize();
    }, wf);
    const now = sizeOf(wf);
    if (JSON.stringify(now) !== JSON.stringify(saved)) moved = true;
    rounds.push("load " + i + " " + JSON.stringify(now));
}
console.log((VUE ? "Nodes 2.0" : "classic") + " · " + NODE);
console.log("  " + rounds.join("\n  "));
if (errors.length) console.log("page errors:\n  " + errors.join("\n  "));
console.log(moved ? "FAIL: the size changed on load" : "ok: the size held");
await browser.close();
process.exit(moved ? 1 : 0);
