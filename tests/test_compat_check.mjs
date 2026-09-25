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
        setAttribute(k, v) { this.attrs[k] = String(v); }
        get textContent() { return this._text + this.children.map((c) => c.textContent ?? "").join(""); }
        set textContent(v) { this._text = String(v); this.children = []; }
        set href(v) { this.attrs.href = v; } get href() { return this.attrs.href; }
        set target(v) { this.attrs.target = v; }
        set rel(v) { this.attrs.rel = v; }
        all() { return [this, ...this.children.flatMap((c) => (c.all ? c.all() : [c]))]; }
        querySelector(sel) { return this.all().slice(1).find((n) => sel.split(",").map((s) => s.trim()).includes(n.tag)) ?? null; }
    }
    const text = (t) => ({ tag: "#text", textContent: String(t), children: [] });
    const doc = { createElement: (tag) => new Node(tag), createElementNS: (ns, tag) => new Node(tag),
                  createTextNode: text, focused: null };
    doc.body = new Node("body");
    return doc;
}

async function load({ fetchApi, confirm } = {}) {
    const document = fakeDocument();
    const overlays = [];
    const context = vm.createContext({ console, document, setTimeout, clearTimeout, URL,
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
            themePalette: () => ({ text: "#eee", edge: "#444", rest: "#333" }), dropWidgetSockets() {}, addPanelWidget() {},
            nodeButton: (label, run) => { const b = document.createElement("button"); b.textContent = label;
                                          b.nodeButton = true; b.addEventListener("click", () => run?.()); return b; },
            nodeButtonBar: (bs) => { const bar = document.createElement("div"); bar.nodeButtonBar = true;
                                     for (const b of bs) bar.appendChild(b); return bar; },
            paintNodeButton() {},
            icon: (name) => { const n = document.createElement("svg"); n.icon = name; return n; } });
        else {
            const source = (await readFile(new URL(name, root), "utf8"))
                + "\nexport { paint, faceButtons, reportText, lineOf, entriesOf, serialize, openDetails, linkOf, authored, trustedLink, shownOf, storeShown, TRUSTED_SITES };";
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
const GEAR = "Edit the rules";   // the dialog's settings button: an icon, found by its aria-label
const buttons = (root) => root.all().filter((n) => n.tag === "button");
const labelOf = (n) => n.attrs["aria-label"] ?? n.textContent;
const press = async (root, label) => {
    const b = buttons(root).find((n) => labelOf(n) === label);
    assert.ok(b, "no button " + label + " in " + buttons(root).map(labelOf));
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

test("the face: 'Compatibility Issues', a block per issue with versions and link; two buttons outside it", async () => {
    const { paint, faceButtons, document } = await load();
    const panel = document.createElement("div");
    assert.equal(paint(panel, ANSWER), 2);
    const text = panel.textContent;
    const heading = panel.children[0];
    assert.equal(heading.textContent, "2 Compatibility Issues");
    assert.equal(heading.style.font, "700 13px sans-serif", "bold");
    assert.equal(heading.style.color, "#ff8a8a", "red");
    assert.ok(!text.includes("things to fix"), "the long sentence is gone from the face");
    // whose links these are, right under the heading, before any link
    assert.equal(panel.children[1].textContent,
                 "Links come from whoever made this workflow. Check where a link goes before installing anything from it.");
    // one block per failing rule, in order, each with what is needed and what is there
    const blocks = panel.children.slice(2, 4);
    assert.match(blocks[0].textContent, /^✗ The wrong X is installed/);
    assert.match(blocks[0].textContent, /Required with input y/);
    assert.match(blocks[0].textContent, /Installed installed, without y/);
    assert.match(blocks[1].textContent, /^✗ Node Z is not installed/);
    assert.match(blocks[1].textContent, /Installed not installed/);
    assert.ok(blocks.every((b) => b.style.background), "each issue is a block");
    // under issues the passes are "the others", without a tick
    assert.match(text, /1 other check passed · \? 1 could not be checked/);
    assert.ok(!text.includes("✓"), "no tick while something fails");
    // the link to get it: an anchor for http(s) only
    const anchors = panel.all().filter((n) => n.tag === "a");
    assert.equal(anchors.length, 1, "the javascript: url is not a link");
    assert.equal(anchors[0].href, "https://github.com/LBH-123-AI/x");
    assert.equal(anchors[0].attrs.rel, "noopener noreferrer");
    // (and only when a link shown is the author's)
    const quiet = document.createElement("div");
    paint(quiet, { links: { core: "https://github.com/comfy-org/comfyui" },
                   results: [{ ...ANSWER.results[0], ok: false, state: "fail", url: "" },
                             { ...ANSWER.results[2], url: "" }] });
    assert.ok(!quiet.textContent.includes("Links come from"),
              "no author links on the face: no warning");
    // the fix and the detail stay in View Details
    assert.ok(!text.includes("Install the original."), "no fix on the face");
    assert.ok(!text.includes("<b>fork</b>"), "no detail on the face");
    // the buttons are not in the painted (scrolling) part, and no coloured edge
    assert.deepEqual(buttons(panel), []);
    assert.equal(panel.style.borderColor, undefined);
    assert.equal(panel.style.border, undefined);
    let details = 0, reports = 0;
    const row = faceButtons({ details: () => { details += 1; }, report: () => { reports += 1; } });
    assert.deepEqual(buttons(row).map((n) => n.textContent), ["view details", "copy report"], "lower case, like Value Presets' face buttons");
    assert.ok(row.nodeButtonBar && buttons(row).every((b) => b.nodeButton),
              "the pack's shared face buttons, not hand-styled ones");
    buttons(row)[0].fire("click");
    buttons(row)[1].fire("click");
    assert.deepEqual([details, reports], [1, 1]);

    assert.equal(paint(panel, { results: [ANSWER.results[0]] }), 0);
    assert.match(panel.textContent, /This install can run the workflow/);
    assert.equal(panel.children[0].style.color, "#7fd49a", "green text, no border");
    assert.equal(paint(panel, { results: [] }), 0);
    assert.match(panel.textContent, /No requirements listed/);
    assert.equal(paint(panel, { error: "the rules are larger than 16 KB." }), 1);
    assert.match(panel.textContent, /^Compatibility Issues✗ the rules are larger/);
    // an unreadable line has no versions: its problem is shown instead
    paint(panel, { results: [{ kind: "error", ok: false, title: "This rule cannot be read",
                               detail: "'bogus' is not a rule this node knows", required: "", installed: "" }] });
    assert.match(panel.children[1].textContent, /'bogus' is not a rule/);
    assert.equal(panel.children[0].textContent, "1 Compatibility Issue", "singular");
    // all passing: the tick and no "other"
    paint(panel, { results: [ANSWER.results[0], { ...ANSWER.results[0], line: 9 }] });
    assert.match(panel.textContent, /✓ 2 checks passed$/);
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
    assert.deepEqual(heads[0], ["Result", "Part", "Required version", "Installed", "Link", "Note"]);
    assert.deepEqual(heads[1], ["Result", "Pack", "Required version", "Installed", "Repository", "Note"]);
    assert.deepEqual(heads[2], ["Result", "Node", "Must have input", "Installed", "Link", "Note"]);
    assert.match(tables[0].textContent, /✓ OKComfyUI>= 0\.35\.00\.37\.0/);
    assert.match(tables[1].textContent, /\? Unknownq>= 1\.0\.0version unknown/);
    assert.ok(!tables[1].textContent.includes("unknownQ"), "no 'found by node' column");
    const nodes = tables[2].textContent;
    assert.ok(nodes.indexOf("✗ Fix") === nodes.indexOf("✗ FixX"), "failing row first");
    assert.match(nodes, /✗ FixXyinstalled, without y/);
    assert.ok(nodes.includes("<b>fork</b>"), "detail is text, not markup");
    assert.match(nodes, /Fix: Install the original\./);
    const anchors = panel.all().filter((n) => n.tag === "a");
    assert.equal(anchors.length, 1, "the javascript: url is not a link");
    assert.equal(anchors[0].href, "https://github.com/LBH-123-AI/x");
    assert.equal(anchors[0].attrs.rel, "noopener noreferrer");
    assert.deepEqual(buttons(panel.children.at(-1)).map(labelOf),
                     ["Check Again", "Copy Report", "Message & Links", GEAR, "Close"]);
    const gear = buttons(panel.children.at(-1)).find((n) => labelOf(n) === GEAR);
    assert.equal(gear.textContent, "", "no text glyph: its size would depend on the system's symbol font");
    assert.equal(gear.children[0].icon, "gear");
});

test("rows become lines compat.py reads back (the strings test_compat.py parses)", async () => {
    const { lineOf } = await load();
    const row = (o) => ({ kind: "node", name: "", version: "", node: "", input: "", url: "", note: "", raw: "", ...o });
    assert.equal(lineOf(row({ kind: "core", version: "0.35.0", url: "https://x.y/c", note: "core note" })),
                 "comfyui >= 0.35.0   https://x.y/c   # core note");
    assert.equal(lineOf(row({ kind: "pack", name: "comfyui-obvpm", version: "0.2.5", node: "ValuePresets (obvpm)",
                              url: "https://github.com/chanon/comfyui-obvpm" })),
                 "comfyui-obvpm >= 0.2.5   node: ValuePresets (obvpm)   https://github.com/chanon/comfyui-obvpm",
                 "an older rule's node: is kept");
    assert.equal(lineOf(row({ kind: "pack", name: "comfyui-kjnodes", version: "1.1.0",
                              url: "https://github.com/kijai/ComfyUI-KJNodes", note: "Set/Get" })),
                 "comfyui-kjnodes >= 1.1.0   https://github.com/kijai/ComfyUI-KJNodes   # Set/Get",
                 "a new one needs none");
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
    assert.deepEqual(packInputs.map((n) => n.value), ["q", "1.0.0", ""], "name, version, repository");
    assert.match(tables[1].textContent, /\? Unknown/, "the last result, while untouched");
    packInputs[1].value = "one";
    packInputs[1].fire("input");
    assert.ok(!tables[1].textContent.includes("? Unknown"), "a changed row's old result is gone");
    assert.match(tables[1].textContent, /edited/);
    // the ComfyUI table takes one row per part: it has ComfyUI, so + Add
    // is for the frontend (tested below); other tables always add
    const addsIn = (t) => buttons(t.parent.parent).filter((b) => b.textContent === "+ Add").length;
    assert.equal(addsIn(tables[0]), 1);
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

test("the frontend: its own row in the ComfyUI table, and the page sends its version", async () => {
    const posts = [];
    const { openDetails, overlays, lineOf, serialize } = await load({
        fetchApi: (url, body) => { posts.push(body); return { lines: body.rules.split("\n"), results: [] }; },
    });
    const row = { kind: "frontend", name: "Frontend", version: "1.53.0", node: "", input: "", url: "", note: "why", raw: "" };
    assert.equal(lineOf(row), "frontend >= 1.53.0   # why");
    const rules = { value: TEXT, callback() {} };
    const dlg = openDetails({}, { rules, answer: () => ANSWER, refresh: async () => {} });
    const o = overlays[0];
    await press(o.panel, GEAR);
    const comfy = () => o.panel.all().filter((n) => n.tag === "table")[0];
    const addHere = () => buttons(comfy().parent.parent).find((b) => b.textContent === "+ Add");
    await addHere().onClick();
    // the new row is the part the table did not have, and the table is now full
    const selects = comfy().all().filter((n) => n.tag === "select");
    assert.deepEqual(selects.map((s) => s.value), ["core", "frontend"]);
    assert.equal(addHere(), undefined, "one row per part: nothing left to add");
    const version = comfy().all().filter((n) => n.tag === "input")[1];     // the new row's version
    version.value = "1.53.0";
    version.fire("input");
    const { text } = serialize(dlg.state.entries);
    assert.equal(text.split("\n")[2], "frontend >= 1.53.0", "after the ComfyUI rule");
    await press(o.panel, "Apply");
    assert.equal(posts.at(-1).frontend, "1.53.6", "the page's own frontend version goes with the check");
});

test("ComfyUI and the frontend link to their fixed repos: shown, never an input, never written", async () => {
    const { openDetails, overlays, paint, serialize, document } = await load();
    const LINKS = { core: "https://github.com/comfy-org/comfyui",
                    frontend: "https://github.com/comfy-org/ComfyUI_frontend" };
    const withLink = { ...ANSWER, links: LINKS, results: ANSWER.results.map((r) => (r.kind === "core"
        ? { ...r, ok: false, state: "fail", title: "ComfyUI is too old", link: LINKS.core }
        : r)) };
    // the face's block links to it
    const panel = document.createElement("div");
    paint(panel, withLink);
    assert.ok(panel.all().some((n) => n.tag === "a" && n.href === "https://github.com/comfy-org/comfyui"));
    // View Details links to it
    const dlg = openDetails({}, { rules: { value: TEXT }, answer: () => withLink, refresh: async () => {} });
    const o = overlays[0];
    const comfy = () => o.panel.all().filter((n) => n.tag === "table")[0];
    assert.ok(comfy().all().some((n) => n.tag === "a" && n.href === "https://github.com/comfy-org/comfyui"));
    // editing: no Link input in this table, the fixed link still shown, text untouched
    await press(o.panel, GEAR);
    const inputs = comfy().all().filter((n) => n.tag === "input");
    assert.deepEqual(inputs.map((n) => n.value), ["0.35.0"], "only the version is typed");
    const anchors = () => comfy().all().filter((n) => n.tag === "a").map((n) => n.href);
    assert.deepEqual(anchors(), [LINKS.core]);
    assert.equal(serialize(dlg.state.entries).text, TEXT);
    // switching the row's Part moves the link with it
    const part = comfy().all().find((n) => n.tag === "select");
    part.value = "frontend";
    part.fire("change");
    assert.deepEqual(anchors(), [LINKS.frontend]);
    assert.equal(serialize(dlg.state.entries).text.split("\n")[1], "frontend >= 0.35.0");
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

test("only github.com is a link; everything else is shown as plain text", async () => {
    const { linkOf } = await load();
    const shown = (u) => { const n = linkOf(u); return n.tag === "a" ? ["a", n.textContent, n.href] : ["text", n.textContent]; };
    // github.com links, shown host + path; a long path is what gets cut
    assert.deepEqual(shown("https://github.com/kijai/ComfyUI-KJNodes/"),
                     ["a", "github.com/kijai/ComfyUI-KJNodes ↗", "https://github.com/kijai/ComfyUI-KJNodes/"]);
    const [kind, text] = shown("https://www.github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler/tree/main");
    assert.equal(kind, "a");
    assert.ok(text.startsWith("github.com/LBH-123-AI/") && text.includes("…"), text);
    // anything that only LOOKS like github.com is text
    for (const url of [
        "https://github.com-comfy-org-comfyui-manager-release.evil.example/installer.zip",   // long look-alike host
        "https://github.com.evil.example/x",                  // github.com as a subdomain
        "https://github.com@evil.example/x",                  // goes to evil.example
        "https://user:pw@github.com/x",                       // credentials in a link
        "https://g\u0456thub.com/comfy-org/comfyui",           // Cyrillic і (U+0456)
        "https://raw.githubusercontent.com/o/r/main/x.py",    // another host, even GitHub's
        "https://example.com/pack",
        "javascript:alert(1)", "file:///C:/x", "not a url",
    ]) {
        assert.deepEqual(shown(url), ["text", url], url);
    }
});

test("View Details says links and notes are the author's, when there are any", async () => {
    const { openDetails, overlays, authored } = await load();
    const LINKS = { core: "https://github.com/comfy-org/comfyui" };
    const core = { ...ANSWER.results[0], url: "https://x.y/whatever" };
    assert.equal(authored({ links: LINKS, results: [core] }), false, "a fixed-link row's URL is not the author's word");
    assert.equal(authored({ links: LINKS, results: [ANSWER.results[1]] }), true);
    assert.equal(authored({ links: LINKS, results: [{ ...ANSWER.results[2], url: "", note: "run this" }] }), true);
    openDetails({}, { rules: { value: TEXT }, answer: () => ({ ...ANSWER, links: LINKS }), refresh: async () => {} });
    assert.match(overlays[0].panel.textContent, /Links and notes come from whoever made this workflow/);
    openDetails({}, { rules: { value: TEXT }, answer: () => ({ links: LINKS, lines: [], results: [core] }), refresh: async () => {} });
    assert.ok(!overlays[1].panel.textContent.includes("Links and notes come from"));
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

test("the report names ComfyUI's commit when the server found one", async () => {
    const { reportText } = await load();
    REPORT.comfyui_commit = "1568e6cfd";
    try {
        const lines = (await reportText(ANSWER)).split("\n");
        assert.equal(lines[0], "ComfyUI 0.37.2 (1568e6cfd) · frontend 1.53.6 · Nodes 2.0");
    } finally {
        delete REPORT.comfyui_commit;
    }
});

test("an author's link opens only on a trusted site, by its parsed host", async () => {
    const { trustedLink } = await load();
    const site = (url) => trustedLink(url)?.site ?? null;
    assert.equal(site("https://github.com/chanon/comfyui-obvpm"), "github.com");
    assert.equal(site("https://www.youtube.com/watch?v=abc"), "youtube.com");
    assert.equal(site("https://m.youtube.com/watch?v=abc"), "youtube.com");
    assert.equal(site("https://youtu.be/abc"), "youtu.be");
    assert.equal(site("https://discord.gg/xyz"), "discord.gg");
    assert.equal(site("https://docs.comfy.org/"), "docs.comfy.org", "any comfy.org subdomain");
    assert.equal(trustedLink("http://www.patreon.com/cw/obvpm").href, "https://www.patreon.com/cw/obvpm",
                 "http is opened as https");
    for (const bad of [
        "https://github.com.evil.example/x",          // the name as a prefix
        "https://evil.example/github.com",            // the name in the path
        "https://notgithub.com/x", "https://evilcomfy.org/", "https://gist.github.com.evil.example/",
        "https://github.com@evil.example/",           // goes to evil.example
        "https://user:pw@github.com/x",
        "https://github.com:8443/x",
        "https://xn--gthub-cta.com/x",                // a look-alike in punycode
        "javascript:alert(1)", "data:text/html,<b>x</b>", "ftp://github.com/x",
        "https://bit.ly/abc",                         // shorteners hide where a link goes
        "github.com/x", "",
    ]) assert.equal(trustedLink(bad), null, bad);
});

test("what the node shows when compatible is stored in its properties, cleaned", async () => {
    const { shownOf, storeShown } = await load();
    // (objects from the vm: compared as JSON, their prototypes are another realm's)
    assert.equal(JSON.stringify(shownOf({})), JSON.stringify({ message: "", links: [] }));
    const node = { properties: { "Node name for S&R": "x" } };
    storeShown(node, { message: "  Hello\nthere  ",
                       links: [{ text: " Video ", url: " https://youtu.be/a " }, { text: "", url: "" },
                               { text: "x".repeat(500), url: "https://github.com/a" }] });
    assert.equal(node.properties.compatible_message, "Hello\nthere", "line breaks kept");
    assert.equal(JSON.stringify(node.properties.compatible_links[0]), JSON.stringify({ text: "Video", url: "https://youtu.be/a" }));
    assert.equal(node.properties.compatible_links.length, 2, "an empty row is dropped");
    assert.equal(shownOf(node).links[1].text.length, 120, "a label is cut to size");
    assert.equal(node.properties["Node name for S&R"], "x", "other properties untouched");
    // what a shared workflow holds is cleaned on the way out, not trusted
    const odd = { properties: { compatible_message: 42, compatible_links: [{ text: { a: 1 }, url: 7 }, null,
                  ...Array.from({ length: 40 }, (_, i) => ({ text: "l" + i, url: "" }))] } };
    const got = shownOf(odd);
    assert.equal(got.message, "42");
    assert.ok(got.links.length <= 20);
    assert.ok(got.links.every((l) => typeof l.text === "string" && typeof l.url === "string"));
    assert.equal(shownOf({ properties: { compatible_links: "not a list" } }).links.length, 0);
    storeShown(node, { message: " ", links: [] });
    assert.ok(!("compatible_message" in node.properties) && !("compatible_links" in node.properties),
              "emptied parts are removed");
});

test("the face shows the author's text and links under the all-clear, and only then", async () => {
    const { paint, document } = await load();
    const shown = { message: "Set <b>your</b> project name first.\nThen run.",
                    links: [{ text: "Watch the tutorial", url: "https://www.youtube.com/watch?v=abc" },
                            { text: "github.com/comfy-org/ComfyUI", url: "https://github.com/evil/x" },
                            { text: "My site", url: "https://my.example/page" }] };
    const panel = document.createElement("div");
    paint(panel, { results: [ANSWER.results[0]] }, panel, shown);
    const text = panel.textContent;
    assert.match(text, /This install can run the workflow/);
    assert.match(text, /From the workflow's author:/);
    const message = panel.all().find((n) => n.style?.whiteSpace === "pre-wrap");
    assert.equal(message.textContent, shown.message, "the text as written: markup stays text");
    assert.ok(!panel.all().some((n) => n.tag === "b"), "no element made from the text");
    const anchors = panel.all().filter((n) => n.tag === "a");
    assert.deepEqual(anchors.map((a) => a.href), ["https://www.youtube.com/watch?v=abc", "https://github.com/evil/x"]);
    assert.deepEqual(anchors.map((a) => a.attrs.rel), ["noopener noreferrer", "noopener noreferrer"]);
    // the site each really goes to is shown beside the label
    assert.match(anchors[1].parent.textContent, /^github\.com\/comfy-org\/ComfyUIgithub\.com ↗$/);
    assert.match(anchors[0].parent.textContent, /youtube\.com ↗$/);
    assert.match(text, /My sitehttps:\/\/my\.example\/page/, "an untrusted site: label and address as text");
    // anything failing: the issues only
    const failing = document.createElement("div");
    paint(failing, ANSWER, failing, shown);
    assert.ok(!failing.textContent.includes("From the workflow's author"));
    assert.ok(!failing.textContent.includes("Watch the tutorial"));
    // nothing set: nothing extra
    const plain = document.createElement("div");
    paint(plain, { results: [ANSWER.results[0]] }, plain, { message: "", links: [] });
    assert.ok(!plain.textContent.includes("author"));
});

test("Message & Links: a pop over View Details; OK stores, Cancel and Escape do not", async () => {
    const { openDetails, overlays } = await load();
    let stored = { message: "Hi", links: [{ text: "Code", url: "https://github.com/a/b" }] };
    const saves = [];
    openDetails({}, { rules: { value: TEXT }, answer: () => ANSWER, refresh: async () => {},
                      shown: () => stored, setShown: (next) => { saves.push(next); stored = next; } });
    const o = overlays[0];
    await press(o.panel, "Message & Links");
    const pop = o.overlay.children.at(-1);
    assert.ok(pop.dataset.obvpmPop, "a pop: Escape closes it first");
    assert.match(pop.textContent, /Shown when compatible/);
    const area = pop.all().find((n) => n.tag === "textarea");
    assert.equal(area.value, "Hi");
    let inputs = pop.all().filter((n) => n.tag === "input");
    assert.deepEqual(inputs.map((n) => n.value), ["Code", "https://github.com/a/b"]);
    assert.match(pop.textContent, /✓ github\.com/);
    // add a link to a site not on the list: flagged while typing
    await press(pop, "+ Add");
    inputs = pop.all().filter((n) => n.tag === "input");
    inputs[2].value = "Blog"; inputs[2].fire("input");
    inputs[3].value = "https://blog.example/post"; inputs[3].fire("input");
    assert.match(pop.textContent, /shown as text/);
    area.value = "Read me first";
    await press(pop, "OK");
    assert.ok(!o.overlay.children.includes(pop), "closed");
    assert.equal(saves.length, 1);
    assert.equal(saves[0].message, "Read me first");
    assert.deepEqual(saves[0].links.map((l) => [l.text, l.url]),
                     [["Code", "https://github.com/a/b"], ["Blog", "https://blog.example/post"]]);
    // remove one and cancel: nothing stored
    await press(o.panel, "Message & Links");
    const pop2 = o.overlay.children.at(-1);
    await press(pop2, "✕");
    await press(pop2, "Cancel");
    assert.equal(saves.length, 1, "Cancel stores nothing");
    await press(o.panel, "Message & Links");
    o.escape();
    assert.ok(!o.overlay.children.some((c) => c.dataset.obvpmPop), "Escape closed the pop");
    assert.ok(!o.closed, "and only the pop");
    assert.equal(saves.length, 1);
});

test("Message & Links: ▲ ▼ reorder the links (no-ops at the ends), stored in the new order", async () => {
    const { openDetails, overlays } = await load();
    const links = [{ text: "A", url: "https://github.com/a" }, { text: "B", url: "https://youtu.be/b" },
                   { text: "C", url: "https://discord.gg/c" }];
    const saves = [];
    openDetails({}, { rules: { value: TEXT }, answer: () => ANSWER, refresh: async () => {},
                      shown: () => ({ message: "", links }), setShown: (next) => saves.push(next) });
    const o = overlays[0];
    await press(o.panel, "Message & Links");
    const pop = o.overlay.children.at(-1);
    const texts = () => pop.all().filter((n) => n.tag === "input" && n.placeholder === "Watch the tutorial")
        .map((n) => n.value);
    const rowButtons = (label) => buttons(pop).filter((b) => b.textContent === label);
    assert.deepEqual(texts(), ["A", "B", "C"]);
    assert.equal(rowButtons("▲").length, 3, "one pair per row");
    await rowButtons("▲")[0].onClick();                // first row up: nothing
    await rowButtons("▼")[2].onClick();                // last row down: nothing
    assert.deepEqual(texts(), ["A", "B", "C"]);
    await rowButtons("▼")[0].onClick();                // A down
    assert.deepEqual(texts(), ["B", "A", "C"]);
    await rowButtons("▲")[2].onClick();                // C up
    assert.deepEqual(texts(), ["B", "C", "A"]);
    // an edit typed before a move goes with its row
    const input = pop.all().find((n) => n.tag === "input" && n.value === "A");
    input.value = "A2"; input.fire("input");
    await rowButtons("▲")[2].onClick();
    assert.deepEqual(texts(), ["B", "A2", "C"]);
    assert.equal(links[0].text, "A", "the stored list is untouched until OK");
    await press(pop, "OK");
    assert.deepEqual(saves[0].links.map((l) => l.text), ["B", "A2", "C"]);
    assert.deepEqual(saves[0].links.map((l) => l.url),
                     ["https://youtu.be/b", "https://github.com/a", "https://discord.gg/c"], "the urls move with them");
});
