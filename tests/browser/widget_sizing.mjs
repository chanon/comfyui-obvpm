// Measure the Compatibility Check panel in Nodes 2.0: does its content
// dictate the node's minimum height, and does it scroll when the node is
// shorter than the content?
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true, args: ["--no-sandbox", "--window-size=1600,1000"] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const logs = [];
page.on("console", (m) => { if (m.type() === "error") logs.push(m.text().slice(0, 300)); });
await page.goto(process.argv[2], { waitUntil: "networkidle2", timeout: 120000 });
await page.waitForFunction(() => window.app?.graph && window.app?.canvas, { timeout: 120000 });
await new Promise((r) => setTimeout(r, 4000));
const vue = process.argv.includes("--vue");
await page.evaluate(async (vue) => { await window.app.extensionManager?.setting?.set?.("Comfy.VueNodes.Enabled", vue); }, vue);
await new Promise((r) => setTimeout(r, 2000));
const nodeType = process.argv.find((a) => a.startsWith("--node="))?.slice(7) ?? "CompatibilityCheck (obvpm)";
const out = await page.evaluate(async (nodeType) => {
    const app = window.app;
    app.graph.clear();
    const node = LiteGraph.createNode(nodeType);
    node.pos = [100, 100];
    app.graph.add(node);
    const rules = node.widgets.find((w) => w.name === "rules");
    rules.value = Array.from({ length: 25 }, (_, i) => `node Missing_${i}   https://example.com/${i}   # note ${i}`).join("\n");
    rules.callback?.(rules.value);
    await new Promise((r) => setTimeout(r, 2500));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const card = document.querySelector(`[data-node-id="${node.id}"]`);
    const panel = node.widgets.map((w) => w.element).find((e) => e && e.scrollHeight > 0);
    const measure = () => {
        if (!card) return null;
        const savedH = card.style.getPropertyValue("--node-height");
        card.style.setProperty("--node-height", "0px");
        const min = card.getBoundingClientRect().height;
        card.style.setProperty("--node-height", savedH);
        return Math.round(min);
    };
    const snap = (label) => ({
        label, nodeSize: node.size.map(Math.round),
        cardH: card ? Math.round(card.getBoundingClientRect().height) : null,
        cardMinContentH: measure(),
        panelClientH: panel?.clientHeight, panelScrollH: panel?.scrollHeight,
        panelContain: panel ? getComputedStyle(panel).contain : null,
    });
    const before = snap("after check (auto-grown)");
    node.setSize([node.size[0], 160]);
    await sleep(600);
    const short = snap("node set to 160 tall");
    node.setSize([node.size[0] + 200, node.size[1]]);
    await sleep(600);
    const wide = snap("then 200 wider");
    // the wheel over the panel scrolls it, not the graph
    let wheel = null;
    if (panel) {
        const inner = panel.firstElementChild ?? panel;
        const r = inner.getBoundingClientRect();
        const scaleBefore = app.canvas.ds.scale;
        const topBefore = panel.scrollTop;
        inner.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5, deltaY: 120, deltaMode: 0 }));
        await sleep(100);
        wheel = { scrollTopBefore: topBefore, scrollTopAfter: panel.scrollTop, scaleBefore, scaleAfter: app.canvas.ds.scale };
    }
    return { vueMode: LiteGraph.vueNodesMode, cardFound: !!card, before, short, wide, wheel };
}, nodeType);
await page.evaluate(async () => { await window.app.extensionManager?.setting?.set?.("Comfy.VueNodes.Enabled", false); });
console.log(JSON.stringify(out, null, 1));
if (logs.length) console.log("console errors:", logs.slice(0, 5));
await browser.close();
