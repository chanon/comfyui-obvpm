// Value Presets diagnostics (web/value_presets_diag.js): what it keeps is
// bounded and plain text, and console.error is only listened to while a
// workflow loads -- then handed back, unless something else wrapped it
// on top meanwhile.
//
// Run: node --test tests/test_presets_diag.mjs
import assert from "node:assert/strict";
import test, { mock } from "node:test";

const diag = await import("../web/value_presets_diag.js");

test("a node's trace keeps its last events, as short strings", () => {
    const node = {};
    for (let i = 0; i < diag.TRACE_MAX + 25; i++) diag.trace(node, "event", "n" + i);
    assert.equal(node.__obvpmTrace.length, diag.TRACE_MAX);
    assert.equal(node.__obvpmTrace.at(-1).d, "n" + (diag.TRACE_MAX + 24));
    assert.equal(node.__obvpmTrace[0].d, "n25", "the oldest go first");
    diag.trace(node, "long", "x".repeat(5000));
    assert.ok(node.__obvpmTrace.at(-1).d.length < 400, "details are clipped");
});

test("page errors are capped, kept as text, and hold no objects", () => {
    const big = { secret: new Array(1000).fill("state") };
    const error = new Error("boom");
    for (let i = 0; i < diag.ERRORS_MAX + 10; i++) {
        diag.notePageError("console.error", ["Error calling extension 'x' method 'y'",
                                             { error }, { extension: big }, { args: [big] }]);
    }
    const errs = diag.pageErrors();
    assert.equal(errs.length, diag.ERRORS_MAX);
    for (const e of errs) {
        assert.equal(typeof e.text, "string");
        assert.match(e.text, /Error calling extension 'x' method 'y' boom/);
        assert.ok(!e.text.includes("state,state"), "the extension and args objects are not copied in");
        assert.ok(e.text.length < 1000);
    }
});

test("console.error is listened to only while a workflow loads", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const seen = [];
        const con = { error: (...a) => seen.push(a) };
        const original = con.error;
        const before = diag.pageErrors().length;

        diag.loadStarted(con);
        assert.notEqual(con.error, original, "wrapped during the load");
        con.error("Error calling extension 'bad' method 'afterConfigureGraph'", { error: new Error("nope") });
        assert.equal(seen.length, 1, "still logged as before");
        assert.match(diag.pageErrors().at(-1).text, /afterConfigureGraph.*nope/s);

        diag.loadFinished(con);
        mock.timers.tick(2999);
        assert.notEqual(con.error, original, "a short tail after the load");
        mock.timers.tick(1);
        assert.equal(con.error, original, "then the original is back");
        const count = diag.pageErrors().length;
        con.error("after the load");
        assert.equal(diag.pageErrors().length, count, "not recorded outside a load");
        assert.ok(count >= Math.min(before + 1, diag.ERRORS_MAX));
    } finally {
        mock.timers.reset();
    }
});

test("a load that never reports finishing stops listening by itself", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const con = { error() {} };
        const original = con.error;
        diag.loadStarted(con);
        mock.timers.tick(29999);
        assert.notEqual(con.error, original);
        mock.timers.tick(1);
        assert.equal(con.error, original);
        assert.equal(diag.loadState().active, false);
    } finally {
        mock.timers.reset();
    }
});

test("a console.error another extension wrapped over ours is not unwound", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const calls = [];
        const con = { error: (...a) => calls.push(["original", ...a]) };
        diag.loadStarted(con);
        const ours = con.error;
        const theirs = function (...a) { calls.push(["theirs"]); return ours.apply(this, a); };
        con.error = theirs;
        diag.loadFinished(con);
        mock.timers.tick(3000);
        assert.equal(con.error, theirs, "theirs stays in place");
        const count = diag.pageErrors().length;
        con.error("later");
        assert.deepEqual(calls.at(-1), ["original", "later"], "ours only passes through");
        assert.equal(diag.pageErrors().length, count, "and records nothing any more");
    } finally {
        mock.timers.reset();
    }
});

test("the report carries the facts, the trace and the page errors", () => {
    const node = {};
    diag.trace(node, "created", "id 7");
    diag.trace(node, "build-threw", "TypeError: x is not a function");
    const text = diag.reportText(node, { frontend: "1.53.6", widgets: ["schema [customtext, hidden]"] });
    assert.match(text, /^Value Presets diagnostics/);
    assert.match(text, /frontend: 1\.53\.6/);
    assert.match(text, /widgets:\n  schema \[customtext, hidden\]/);
    assert.match(text, /\+0 created id 7/);
    assert.match(text, /build-threw TypeError: x is not a function/);
    assert.match(text, /page errors \(last 20/);
});
