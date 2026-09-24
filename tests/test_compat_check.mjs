// Compatibility Check in the browser: the real web/compat_check.js in a vm
// with the framework mocked. The face is a summary; View Details shows the
// results as tables and edits them; the tables write the rules text back
// line by line, leaving what was not edited exactly as written.
//
// Run: node --experimental-vm-modules --test tests/test_compat_check.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const root = new URL("../web/", import.meta.url);

/** Just enough DOM: elements with style, children, text, listeners. */
function fakeDocument() {
    class Node {
        constructor(tag) {
            this.tag = tag; this.style = {}; this.children = []; this._text = "";
            this.attrs = {}; this.dataset = {}; this.listeners = {}; this.parent = null;
            this.value = ""; this.disabled = false;
        }
        get tagName() { return this.tag.toUpperCase(); }
        appendChild(c) { c.parent = this; this.children.push(c); return c; }
        append(...cs) { for (const c of cs) this.appendChild(typeof c === "string" ? text(c) : c); }
        replaceChildren(...cs) { this.children = []; this.append(...cs); }
        remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
        addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
        fire(type) { for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {}, stopPropagation() {}, target: this }); }
        focus() { doc.focused = this; }
        get textContent() { return this._text + this.children.map((c) => c.textContent ?? "").join(""); }
        set textContent(v) { this._text = String(v); this.children = []; }
        set href(v) { this.attrs.href = v; } get href() { return this.attrs.href; }
        set target(v) { this.attrs.target = v; }
        set rel(v) { this.attrs.rel = v; }
        all() { return [this, ...this.children.flatMap((c) => (c.all ? c.all() : [c]))]; }
        querySelector(sel) { return this.all().slice(1).find((n) => sel.split(",").map((s) => s.trim()).includes(n.tag)) ?? null; }
    }
    const text = (t) => ({ tag: "#text", textContent: String(t), children: [] });
    const doc = { createElement: (tag) => new Node(tag), createTextNode: text, focused: null };
    doc.body = new Node("body");
    return doc;
}

async function load({ fetchApi, confirm } = {}) {
    const document = fakeDocument();
    const overlays = [];
    const context = vm.createContext({ console, document, setTimeout, clearTimeout,
        requestAnimationFrame: (fn) => fn(),
        window: { __COMFYUI_FRONTEND_VERSION__: "1.53.6" },
        navigator: { userAgent: "TestBrowser/1" },
        LiteGraph: { vueNodesMode: true } });
    const mock = (values) => new vm.SyntheticModule(Object.keys(values), function () {
        for (const [k, v] of Object.entries(values)) this.setExport(k, v);
    }, { context });
    const cache = new Map();
    const confirms = [];
    async function get(name) {
        if (cache.has(name)) return cache.get(name);
        let mod;
        if (name.endsWith("scripts/app.js")) mod = mock({ app: { registerExtension() {},
            extensionManager: { setting: { get: (k) => ({ "Comfy.Locale": "de" })[k] } } } });
        else if (name.endsWith("scripts/api.js")) mod = mock({ api: { fetchApi: async (url, init) => {
            if (url === "/obvpm/compat/report") return { json: async () => REPORT };
            if (fetchApi) return { json: async () => fetchApi(url, JSON.parse(init?.body ?? "{}")) };
            throw new Error("offline");
        } } });
        else if (name === "obvpm_ui.js") mod = mock({
            el: (tag, style, text) => { const n = document.createElement(tag); Object.assign(n.style, style ?? {}); if (text != null) n.textContent = String(text); return n; },
            DIM: "#999", TEXT: "14px sans-serif", TITLE: "600 16px sans-serif", INK: "#ddd", EDGE: "#444", FILL: "#222", PANEL: "#333",
            pushButton: (label, onClick) => { const b = document.createElement("button"); b.textContent = label; b.onClick = onClick; return b; },
            openOverlay: (width, onClose, opts) => {
                const o = { overlay: document.createElement("div"), panel: document.createElement("div"),
                            closed: false, dismiss: opts?.dismiss };
                o.close = () => { o.closed = true; };
                o.escape = () => {
                    const pops = o.overlay.children.filter((c) => c.dataset.obvpmPop);
                    if (pops.length) return pops.at(-1).obvpmClose();
                    return o.dismiss ? o.dismiss(o.close) : o.close();
                };
                overlays.push(o);
                return o;
            },
            askConfirm: async (message, opts) => { confirms.push({ message, ...opts }); return confirm ? confirm() : true; },
            themePalette: () => ({ text: "#eee", edge: "#444", rest: "#333" }), dropWidgetSockets() {}, addPanelWidget() {} });
        else {
            const source = (await readFile(new URL(name, root), "utf8"))
                + "\nexport { paint, faceButtons, reportText, lineOf, entriesOf, serialize, openDetails };";
            mod = new vm.SourceTextModule(source, { context, identifier: name });
        }
        cache.set(name, mod);
        await mod.link((spec) => get(spec.startsWith("./") ? spec.slice(2) : spec));
        return mod;
    }
    const mod = await get("compat_check.js");
    await mod.evaluate();
    return { ...mod.namespace, document, overlays, confirms };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const GEAR = "⚙︎";            // the dialog's settings (edit rules) button
const buttons = (root) => root.all().filter((n) => n.tag === "button");
const press = async (root, label) => {
    const b = buttons(root).find((n) => n.textContent === label);
    assert.ok(b, "no button " + label + " in " + buttons(root).map((n) => n.textContent));
    await b.onClick?.();
    b.fire("click");
    await tick();
};

const REPORT = { comfyui: "0.37.2", python: "3.13.1", torch: "2.13.0+cu130", os: "Windows 11",
    packs: [{ name: "comfyui-obvpm", version: "0.2.5", commit: "64ef45b" },
            { name: "comfyui-workflow-encrypt", version: "", commit: "" }] };

// A rules text and the answer compat.py gives for it.
const TEXT = [
    "# what the workflow needs",
    "comfyui>=0.35",
    "",
    "node X has y   https://github.com/LBH-123-AI/x   # the original, not the Plus fork",
    "node Z   javascript:alert(1)",
    "q >= 1.0 node: Q",
].join("\n");
const ANSWER = { lines: TEXT.split("\n"), results: [
    { rule: "comfyui>=0.35", line: 1, kind: "core", ok: true, state: "ok", title: "ComfyUI 0.37.0",
      detail: "needs 0.35.0 or newer", fix: "", note: "", url: "", name: "ComfyUI", version: "0.35.0",
      node: "", input_name: "", required: ">= 0.35.0", installed: "0.37.0" },
    { rule: "node X has y   https://github.com/LBH-123-AI/x   # the original, not the Plus fork", line: 3,
      kind: "node", ok: false, state: "fail", title: "The wrong X is installed",
      detail: "<b>fork</b>", fix: "Install the original.", note: "the original, not the Plus fork",
      url: "https://github.com/LBH-123-AI/x", name: "X", version: "", node: "", input_name: "y",
      required: "with input y", installed: "installed, without y" },
    { rule: "node Z   javascript:alert(1)", line: 4, kind: "node", ok: false, state: "fail",
      title: "Node Z is not installed", detail: "no such node", fix: "Install it.", note: "",
      url: "javascript:alert(1)", name: "Z", version: "", node: "", input_name: "",
      required: "installed", installed: "not installed" },
    { rule: "q >= 1.0 node: Q", line: 5, kind: "pack", ok: true, state: "unknown",
      title: "q (version unknown)", detail: "installed, but…", fix: "", note: "", url: "",
      name: "q", version: "1.0.0", node: "Q", input_name: "", required: ">= 1.0.0",
      installed: "version unknown" },
] };

test("the face is a summary: verdict, what fails, a tally; two buttons outside it", async () => {
    const { paint, faceButtons, document } = await load();
    const panel = document.createElement("div");
    assert.equal(paint(panel, ANSWER), 2);
    const text = panel.textContent;
    assert.match(text, /2 things to fix/);
    assert.ok(text.indexOf("✗ The wrong X is installed") < text.indexOf("✗ Node Z is not installed"));
    assert.match(text, /✓ 1 check passed · \? 1 could not be checked/);
    // the details are in the dialog now, not on the face
    assert.ok(!text.includes("Install the original."), "no fix on the face");
    assert.ok(!text.includes("<b>fork</b>"), "no detail on the face");
    assert.equal(panel.all().filter((n) => n.tag === "a").length, 0, "no links on the face");
    // the buttons are not in the painted (scrolling) part
    assert.deepEqual(buttons(panel), []);
    assert.equal(panel.style.borderColor, "rgba(220,80,80,0.6)");
    // painting a list can colour the frame around it instead
    const frame = document.createElement("div"), list = document.createElement("div");
    paint(list, ANSWER, frame);
    assert.equal(frame.style.borderColor, "rgba(220,80,80,0.6)");
    assert.equal(list.style.borderColor, undefined);
    let details = 0, reports = 0;
    const row = faceButtons({ details: () => { details += 1; }, report: () => { reports += 1; } });
    assert.deepEqual(buttons(row).map((n) => n.textContent), ["View Details", "Copy Report"]);
    buttons(row)[0].fire("click");
    buttons(row)[1].fire("click");
    assert.deepEqual([details, reports], [1, 1]);

    assert.equal(paint(panel, { results: [ANSWER.results[0]] }), 0);
    assert.match(panel.textContent, /This install can run the workflow/);
    assert.equal(panel.style.borderColor, "rgba(80,180,110,0.6)");
    assert.equal(paint(panel, { results: [] }), 0);
    assert.match(panel.textContent, /No requirements listed/);
    assert.equal(paint(panel, { error: "the rules are larger than 16 KB." }), 1);
    assert.match(panel.textContent, /✗ the rules are larger/);
});

test("View Details: one table per kind, failures first, required / installed / link / fix", async () => {
    const { openDetails, document, overlays } = await load();
    openDetails({}, { rules: { value: TEXT }, answer: () => ANSWER, refresh: async () => {} });
    const { panel, overlay } = overlays[0];
    assert.ok(document.body.children.includes(overlay), "the overlay is on the page");
    const text = panel.textContent;
    assert.match(text, /2 things to fix before this workflow can run, then restart ComfyUI\./);
    const tables = panel.all().filter((n) => n.tag === "table");
    assert.equal(tables.length, 3, "ComfyUI, Node packs, Nodes -- empty kinds not shown");
    const heads = tables.map((t) => t.all().filter((n) => n.tag === "th").map((n) => n.textContent));
    assert.deepEqual(heads[0], ["Result", "Required version", "Installed", "Link", "Note"]);
    assert.deepEqual(heads[1], ["Result", "Pack", "Required version", "Installed", "Found by node", "Link", "Note"]);
    assert.deepEqual(heads[2], ["Result", "Node", "Must have input", "Installed", "Link", "Note"]);
    assert.match(tables[0].textContent, /✓ OK>= 0\.35\.00\.37\.0/);
    assert.match(tables[1].textContent, /\? Unknownq>= 1\.0\.0version unknownQ/);
    const nodes = tables[2].textContent;
    assert.ok(nodes.indexOf("✗ Fix") === nodes.indexOf("✗ FixX"), "failing row first");
    assert.match(nodes, /✗ FixXyinstalled, without y/);
    assert.ok(nodes.includes("<b>fork</b>"), "detail is text, not markup");
    assert.match(nodes, /Fix: Install the original\./);
    const anchors = panel.all().filter((n) => n.tag === "a");
    assert.equal(anchors.length, 1, "the javascript: url is not a link");
    assert.equal(anchors[0].href, "https://github.com/LBH-123-AI/x");
    assert.equal(anchors[0].attrs.rel, "noopener noreferrer");
    assert.deepEqual(buttons(panel.children.at(-1)).map((n) => n.textContent),
                     ["Check Again", "Copy Report", GEAR, "Close"]);
});

test("rows become lines compat.py reads back (the strings test_compat.py parses)", async () => {
    const { lineOf } = await load();
    const row = (o) => ({ kind: "node", name: "", version: "", node: "", input: "", url: "", note: "", raw: "", ...o });
    assert.equal(lineOf(row({ kind: "core", version: "0.35.0", url: "https://x.y/c", note: "core note" })),
                 "comfyui >= 0.35.0   https://x.y/c   # core note");
    assert.equal(lineOf(row({ kind: "pack", name: "comfyui-obvpm", version: "0.2.5", node: "ValuePresets (obvpm)",
                              url: "https://github.com/chanon/comfyui-obvpm" })),
                 "comfyui-obvpm >= 0.2.5   node: ValuePresets (obvpm)   https://github.com/chanon/comfyui-obvpm");
    assert.equal(lineOf(row({ name: "MinimaxH3LatentUpscaler3D", input: "enable_temporal_chunking",
                              note: "the original, not #2" })),
                 "node MinimaxH3LatentUpscaler3D has enable_temporal_chunking   # the original, not #2");
    assert.equal(lineOf(row({ name: " ModelPreviewOverrideKJ " })), "node ModelPreviewOverrideKJ");
    assert.equal(lineOf(row({ kind: "no_node", name: "Fork", url: "https://x.y/f" })), "not node Fork   https://x.y/f");
    assert.equal(lineOf(row({ kind: "no_pack", name: "ComfyUI-Workflow-Encrypt", note: "rewrites saved workflows" })),
                 "not pack ComfyUI-Workflow-Encrypt   # rewrites saved workflows");
    assert.equal(lineOf(row({ kind: "error", raw: "  what is this  " })), "what is this");
});

test("the tables write back only what changed; comments, blanks and spacing stay", async () => {
    const { entriesOf, serialize } = await load();
    let entries = entriesOf(ANSWER.lines, ANSWER.results);
    assert.equal(serialize(entries).text, TEXT, "untouched = exactly as written");
    // edit one rule: only its line is rewritten
    entries[1].row.version = "0.36.0";
    let out = serialize(entries).text.split("\n");
    assert.equal(out[0], "# what the workflow needs");
    assert.equal(out[1], "comfyui >= 0.36.0");
    assert.equal(out[2], "");
    assert.equal(out[3], TEXT.split("\n")[3]);
    // remove one, add a blank one (dropped) and a filled one (kept)
    entries[4].removed = true;
    entries.push({ row: { kind: "no_pack", name: "", version: "", node: "", input: "", url: "", note: "", raw: "" }, fresh: true });
    entries.push({ row: { kind: "no_pack", name: "Enc", version: "", node: "", input: "", url: "", note: "", raw: "" }, fresh: true });
    const { text, owners } = serialize(entries);
    out = text.split("\n");
    assert.ok(!text.includes("node Z"));
    assert.equal(out.at(-1), "not pack Enc");
    assert.equal(owners.at(-1).row.name, "Enc", "each line knows its row");
    assert.equal(out.length, owners.length);
});

test("the settings button: inputs, Apply checks first and marks the row a new line breaks", async () => {
    const posts = [];
    let reply;
    const rules = { value: TEXT, callbacks: 0 };
    rules.callback = () => { rules.callbacks += 1; };
    let refreshed = 0;
    const { openDetails, overlays } = await load({ fetchApi: (url, body) => { posts.push(body.rules); return reply(body.rules); } });
    const dlg = openDetails({}, { rules, answer: () => ANSWER, refresh: async () => { refreshed += 1; } });
    const { panel } = overlays[0];
    await press(panel, GEAR);
    assert.equal(dlg.state.mode, "edit");
    assert.deepEqual(buttons(panel.children.at(-1)).map((n) => n.textContent),
                     ["Edit as Text", "Cancel", "Apply"]);
    const tables = panel.all().filter((n) => n.tag === "table");
    assert.equal(tables.length, 4, "every kind that can be added to, even empty ones");
    // the pack's version input: break it
    const packInputs = tables[1].all().filter((n) => n.tag === "input");
    assert.deepEqual(packInputs.map((n) => n.value), ["q", "1.0.0", "Q", ""]);
    assert.match(tables[1].textContent, /\? Unknown/, "the last result, while untouched");
    packInputs[1].value = "one";
    packInputs[1].fire("input");
    assert.ok(!tables[1].textContent.includes("? Unknown"), "a changed row's old result is gone");
    assert.match(tables[1].textContent, /edited/);
    // one ComfyUI rule is enough: no + Add under a table that has it
    const addsIn = (t) => buttons(t.parent.parent).filter((b) => b.textContent === "+ Add").length;
    assert.equal(addsIn(tables[0]), 0);
    assert.equal(addsIn(tables[1]), 1);
    reply = (text) => ({ lines: text.split("\n"), results: [
        { kind: "error", line: 5, ok: false, rule: "q >= one   node: Q", detail: "'q >= one   node: Q' has a version that is not written like 1.2.3" },
    ] });
    await press(panel, "Apply");
    assert.equal(posts.at(-1).split("\n")[5], "q >= one   node: Q");
    assert.equal(rules.value, TEXT, "nothing written while a line cannot be read");
    assert.equal(dlg.state.mode, "edit");
    assert.match(panel.textContent, /One rule cannot be read\. Fix or remove the marked rows/);
    assert.match(panel.textContent, /✗ 'q >= one   node: Q' has a version/);
    // fix it and apply: written, checked again, back to the tables
    const again = panel.all().filter((n) => n.tag === "table")[1].all().filter((n) => n.tag === "input");
    again[1].value = "1.2";
    again[1].fire("input");
    reply = (text) => ({ lines: text.split("\n"), results: [] });
    await press(panel, "Apply");
    assert.equal(rules.value.split("\n")[5], "q >= 1.2   node: Q");
    assert.equal(rules.value.split("\n")[1], "comfyui>=0.35", "the untouched line kept as written");
    assert.equal(rules.callbacks, 1);
    assert.equal(refreshed, 1);
    assert.equal(dlg.state.mode, "view");
});

test("Escape: the text box, then the edit (asking if changed), then the dialog", async () => {
    let answerConfirm = false;
    const { openDetails, overlays, confirms } = await load({
        confirm: () => answerConfirm,
        fetchApi: (url, body) => ({ lines: body.rules.split("\n"), results: [
            { kind: "no_pack", line: 0, ok: true, state: "ok", rule: body.rules.split("\n")[0], name: "Enc" }] }),
    });
    const dlg = openDetails({}, { rules: { value: TEXT }, answer: () => ANSWER, refresh: async () => {} });
    const o = overlays[0];
    await press(o.panel, GEAR);
    // Edit as Text is a pop over the dialog: Escape closes it alone
    await press(o.panel, "Edit as Text");
    const pop = o.overlay.children.find((c) => c.dataset.obvpmPop);
    assert.ok(pop, "a pop in the overlay");
    assert.equal(pop.all().find((n) => n.tag === "textarea").value, TEXT);
    o.escape();
    assert.ok(!o.overlay.children.includes(pop), "the pop is gone");
    assert.equal(dlg.state.mode, "edit", "the edit is still on");
    assert.equal(o.closed, false);
    // unchanged edit: Escape leaves it without asking
    o.escape();
    await tick();
    assert.equal(dlg.state.mode, "view");
    assert.equal(confirms.length, 0);
    // changed edit: Escape asks; "keep editing" keeps it, "discard" leaves
    await press(o.panel, GEAR);
    const input = o.panel.all().find((n) => n.tag === "input");
    input.value = "0.99.0";
    input.fire("input");
    o.escape();
    await tick();
    assert.equal(confirms.length, 1);
    assert.equal(confirms[0].ok, "Discard");
    assert.equal(dlg.state.mode, "edit");
    answerConfirm = true;
    o.escape();
    await tick();
    assert.equal(dlg.state.mode, "view");
    assert.equal(o.closed, false);
    // viewing: Escape closes the dialog
    o.escape();
    assert.equal(o.closed, true);
});

test("Edit as Text: Apply to Tables re-reads the rows from the server", async () => {
    const { openDetails, overlays } = await load({
        fetchApi: (url, body) => ({ lines: body.rules.split("\n"), results: [
            { kind: "no_pack", line: 1, ok: true, state: "ok", rule: "not pack Enc", name: "Enc", installed: "not installed" }] }),
    });
    const rules = { value: TEXT };
    const dlg = openDetails({}, { rules, answer: () => ANSWER, refresh: async () => {} });
    const o = overlays[0];
    await press(o.panel, GEAR);
    await press(o.panel, "Edit as Text");
    const pop = o.overlay.children.find((c) => c.dataset.obvpmPop);
    pop.all().find((n) => n.tag === "textarea").value = "# only this\nnot pack Enc";
    await press(pop, "Apply to Tables");
    assert.ok(!o.overlay.children.includes(pop), "closed after taking the text");
    assert.equal(dlg.state.mode, "edit", "still editing: the tables Apply saves");
    assert.equal(rules.value, TEXT, "not saved yet");
    const tables = o.panel.all().filter((n) => n.tag === "table");
    assert.equal(tables.length, 4);
    assert.deepEqual(tables[3].all().filter((n) => n.tag === "input").map((n) => n.value), ["Enc", ""]);
});

test("a note is a button: View opens it in a pop, and editing edits it there", async () => {
    const { openDetails, overlays } = await load();
    const rules = { value: TEXT };
    const dlg = openDetails({}, { rules, answer: () => ANSWER, refresh: async () => {} });
    const o = overlays[0];
    // viewing: only the row with a note has a button, and the text is not in the table
    const nodes = o.panel.all().filter((n) => n.tag === "table")[2];
    const views = buttons(nodes).filter((b) => b.textContent === "View");
    assert.equal(views.length, 1, "only X has a note");
    assert.ok(!nodes.textContent.includes("the original, not the Plus fork"), "note not shown in the table");
    await views[0].onClick();
    let pop = o.overlay.children.find((c) => c.dataset.obvpmPop);
    assert.match(pop.textContent, /Note: X/);
    assert.match(pop.textContent, /the original, not the Plus fork/);
    assert.equal(pop.all().filter((n) => n.tag === "textarea").length, 0, "read-only while viewing");
    o.escape();
    assert.ok(!o.overlay.children.includes(pop), "Escape closed the note only");
    assert.equal(dlg.state.mode, "view");
    // editing: Add on a row without a note, typed, OK -> the row changed
    await press(o.panel, GEAR);
    const packTable = o.panel.all().filter((n) => n.tag === "table")[1];
    const add = buttons(packTable).find((b) => b.textContent === "Add");
    await add.onClick();
    pop = o.overlay.children.find((c) => c.dataset.obvpmPop);
    pop.all().find((n) => n.tag === "textarea").value = "needs the\nnew presets";
    await press(pop, "OK");
    assert.ok(!o.overlay.children.includes(pop));
    assert.equal(add.textContent, "Edit");
    assert.match(packTable.textContent, /edited/);
    const { serialize } = await load();
    assert.equal(serialize(dlg.state.entries).text.split("\n")[5],
                 "q >= 1.0.0   node: Q   # needs the new presets");
});

test("the dialog's heading: name and verdict on one line; no legend while editing", async () => {
    const { openDetails, overlays } = await load();
    openDetails({}, { rules: { value: TEXT }, answer: () => ({ ...ANSWER, results: [ANSWER.results[0]] }),
                      refresh: async () => {} });
    const o = overlays[0];
    const heading = o.panel.children[0].children[0];
    assert.deepEqual(heading.children.map((c) => c.textContent),
                     ["Compatibility Check", "This install can run the workflow"]);
    assert.equal(heading.children[1].style.font, heading.children[0].style.font, "same size");
    assert.equal(heading.children[1].style.color, "#7fd49a", "green");
    await press(o.panel, GEAR);
    assert.ok(!o.panel.textContent.includes("Each row is one requirement"));
});

test("the report is the install, the browser's facts and the results, as text", async () => {
    const { reportText } = await load();
    const text = await reportText(ANSWER);
    const lines = text.split("\n");
    assert.equal(lines[0], "ComfyUI 0.37.2 · frontend 1.53.6 · Nodes 2.0");
    assert.equal(lines[1], "Python 3.13.1 · torch 2.13.0+cu130 · Windows 11");
    assert.equal(lines[2], "language de · TestBrowser/1");
    assert.equal(lines[4], "Custom node packs (2):");
    assert.equal(lines[5], "  comfyui-obvpm 0.2.5 (64ef45b)");
    assert.equal(lines[6], "  comfyui-workflow-encrypt");
    assert.equal(lines[8], "Compatibility Check:");
    assert.equal(lines[9], "  ok   ComfyUI 0.37.0 — needs 0.35.0 or newer");
    assert.equal(lines[10], "  FAIL The wrong X is installed — <b>fork</b>");
    assert.equal(lines.length, 13);
});
