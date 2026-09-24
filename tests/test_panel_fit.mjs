// addPanelWidget's fitToContent: a new node grows once by exactly what
// its panel hides; a loaded node (onConfigure ran) and a node the user
// resized are never touched. Each rule was a live bug first (the
// Compatibility Check grew back on every reload after being dragged
// small, and grew by a margin on every load).
//
// Run: node --test tests/test_panel_fit.mjs
import assert from "node:assert/strict";
import test from "node:test";

const frames = [];
globalThis.requestAnimationFrame = (fn) => frames.push(fn);
const flush = () => { while (frames.length) frames.shift()(); };
globalThis.document = { addEventListener() {}, createElement: () => ({ style: {} }) };

const { addPanelWidget } = await import("../web/obvpm_ui.js");

/** A node whose panel content is `content` px tall and whose chrome is 100 px. */
function makeNode(content, height = 200) {
    const scroller = { style: {} };
    const element = { style: {} };
    const node = {
        size: [400, height], inputs: [], sets: 0,
        setSize(s) { this.size = [...s]; this.sets += 1; },
        setDirtyCanvas() {},
        addDOMWidget: (name, type, el, options) => ({ name, element: el, options }),
    };
    // the scroller shows what the node leaves it, and hides the rest
    Object.defineProperty(scroller, "clientHeight", { get: () => Math.max(0, node.size[1] - 100) });
    Object.defineProperty(scroller, "scrollHeight", { get: () => Math.max(content, node.size[1] - 100) });
    const w = addPanelWidget(node, "panel", element, { minHeight: 80, scroller });
    return { node, w };
}

test("a new node grows by exactly the overflow, and again adds nothing", () => {
    const { node, w } = makeNode(260);
    w.fitToContent();
    flush();
    assert.deepEqual(node.size, [400, 360], "100 chrome + 260 content");
    const sets = node.sets;
    w.fitToContent();
    flush();
    assert.deepEqual(node.size, [400, 360], "fits: nothing added");
    assert.equal(node.sets, sets, "not even a no-op resize");
});

test("a loaded node keeps the size it was saved with, however short", () => {
    const { node, w } = makeNode(260, 130);
    node.onConfigure({ size: [400, 130] });       // the frontend configuring it from a workflow
    for (let i = 0; i < 5; i++) {
        w.fitToContent();
        flush();
    }
    assert.deepEqual(node.size, [400, 130]);
    assert.equal(node.sets, 0);
});

test("the class's own onConfigure still runs, after the mark", () => {
    const scroller = { style: {}, scrollHeight: 0, clientHeight: 0 };
    let seen = null;
    const node = {
        size: [400, 200], inputs: [],
        onConfigure(info) { seen = [info, this.__obvpmSizeLoaded]; return "r"; },
        addDOMWidget: (name, type, el, options) => ({ element: el, options }),
    };
    addPanelWidget(node, "p", { style: {} }, { scroller });
    assert.equal(node.onConfigure("info"), "r");
    assert.deepEqual(seen, ["info", true]);
});

test("once the user resizes, the height is theirs", () => {
    const { node, w } = makeNode(260);
    w.fitToContent();
    flush();
    node.size = [400, 150];                          // dragged smaller
    w.fitToContent();                                // content changed later
    flush();
    assert.deepEqual(node.size, [400, 150]);
});

test("never past 600 px on its own", () => {
    const { node, w } = makeNode(5000);
    w.fitToContent();
    flush();
    assert.deepEqual(node.size, [400, 600]);
});
