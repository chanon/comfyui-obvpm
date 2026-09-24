// The dialog kit's Escape: one layer per press. The real web/obvpm_ui.js
// against a stand-in document whose key listeners run the way a browser
// runs them (every capture listener on the document, in the order they
// were added, unless one stops the rest).
//
// Run: node --test tests/test_overlay_escape.mjs
import assert from "node:assert/strict";
import test from "node:test";

class Node {
    constructor(tag) {
        this.tag = tag; this.style = {}; this.children = []; this.parent = null;
        this.dataset = {}; this.listeners = {}; this._text = "";
    }
    appendChild(c) { c.parent?.children.splice(c.parent.children.indexOf(c), 1); c.parent = this; this.children.push(c); return c; }
    append(...cs) { for (const c of cs) this.appendChild(c); }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    get isConnected() { let n = this; while (n.parent) n = n.parent; return n === body; }
    querySelectorAll(sel) {
        assert.equal(sel, ":scope > [data-obvpm-pop]");
        return this.children.filter((c) => c.dataset.obvpmPop);
    }
    set textContent(v) { this._text = String(v); }
    focus() {}
}
const body = new Node("body");
const keyListeners = [];
globalThis.document = {
    body,
    createElement: (tag) => new Node(tag),
    addEventListener(type, fn, capture) { if (type === "keydown") keyListeners.push(fn); },
    removeEventListener(type, fn) { const i = keyListeners.indexOf(fn); if (i >= 0) keyListeners.splice(i, 1); },
};
function escape() {
    let stopped = false;
    const ev = { key: "Escape", stopPropagation() {}, preventDefault() {},
                 stopImmediatePropagation() { stopped = true; } };
    for (const fn of [...keyListeners]) { fn(ev); if (stopped) break; }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

const { openOverlay, askConfirm } = await import("../web/obvpm_ui.js");

test("a confirm over a dialog: the first Escape answers the confirm only", async () => {
    let closedA = 0;
    const a = openOverlay("400px", () => { closedA += 1; });
    body.appendChild(a.overlay);
    const answer = askConfirm("Discard?");
    await tick();
    escape();
    assert.equal(await answer, false, "the confirm was dismissed");
    assert.equal(closedA, 0, "the dialog under it stays");
    assert.ok(a.overlay.isConnected);
    escape();
    assert.equal(closedA, 1);
    assert.ok(!a.overlay.isConnected);
    assert.equal(keyListeners.length, 0, "every listener removed");
});

test("a pop inside a dialog goes first, through its own close", () => {
    const a = openOverlay("400px");
    body.appendChild(a.overlay);
    const pop = new Node("div");
    pop.dataset.obvpmPop = "1";
    let popClosed = 0;
    pop.obvpmClose = () => { popClosed += 1; pop.remove(); };
    a.overlay.appendChild(pop);
    escape();
    assert.equal(popClosed, 1);
    assert.ok(a.overlay.isConnected, "the dialog stays");
    escape();
    assert.ok(!a.overlay.isConnected);
});

test("dismiss: Escape and a click outside ask the dialog, which may stay", () => {
    let editing = true;
    const calls = [];
    const a = openOverlay("400px", null, {
        dismiss: (close) => { calls.push(editing ? "leave edit" : "close"); if (!editing) close(); else editing = false; },
    });
    body.appendChild(a.overlay);
    escape();
    assert.deepEqual(calls, ["leave edit"]);
    assert.ok(a.overlay.isConnected);
    for (const fn of a.overlay.listeners.mousedown) fn({ target: a.overlay });
    assert.deepEqual(calls, ["leave edit", "close"]);
    assert.ok(!a.overlay.isConnected);
});

test("an overlay taken off the page without close() does not deafen the one under it", () => {
    const a = openOverlay("400px");
    body.appendChild(a.overlay);
    const b = openOverlay("300px");
    body.appendChild(b.overlay);
    b.overlay.remove();                 // not through close()
    escape();
    assert.ok(!a.overlay.isConnected, "the dialog under it answered");
    b.close();                          // tidy: its listener goes too
    assert.equal(keyListeners.length, 0);
});
