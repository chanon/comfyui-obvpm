/**
 * Value Presets diagnostics (issue #12).
 *
 * A Value Presets node that stays blank in one user's workflow but builds
 * fine when pasted into an empty one cannot be reproduced anywhere else:
 * whatever breaks it lives in that install. So the node keeps a short
 * record of what happened to it, and the page keeps the errors thrown
 * while a workflow loads, and one right-click copies both as text for
 * the bug report.
 *
 * KEPT SMALL ON PURPOSE, since this runs for everyone:
 *   - a node's trace is its last TRACE_MAX events, short strings only;
 *   - the page keeps its last ERRORS_MAX errors, strings only, never the
 *     error objects themselves (those hold other packs' state alive);
 *   - console.error is only listened to WHILE A WORKFLOW LOADS. The
 *     frontend catches what other extensions throw from their hooks and
 *     reports it with console.error ("Error calling extension ..."), so
 *     a window error listener alone would miss exactly the failures that
 *     matter here. Outside a load the original console.error is back.
 *   - nothing here runs per frame, and the report is only built when
 *     someone asks for it.
 *
 * No imports: plain logic that runs under node for the tests.
 */

export const TRACE_MAX = 60;
export const ERRORS_MAX = 20;
const TEXT_MAX = 300;
const STACK_MAX = 600;
// how long after a load finishes errors still count as the load's, and
// the longest a capture stays on if the load never reports finishing
const LOAD_TAIL_MS = 3000;
const LOAD_CAP_MS = 30000;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const clip = (s, n) => {
    const t = String(s ?? "");
    return t.length > n ? t.slice(0, n) + "…" : t;
};

// ------------------------------------------------------------ node trace

/** Record one lifecycle event on a node: `event` a short word, `detail` text. */
export function trace(node, event, detail = "") {
    if (!node) return;
    const list = node.__obvpmTrace ?? (node.__obvpmTrace = []);
    list.push({ t: Math.round(now()), e: String(event), d: clip(detail, TEXT_MAX) });
    if (list.length > TRACE_MAX) list.splice(0, list.length - TRACE_MAX);
}

// ------------------------------------------------------------ page errors

const errors = [];

export function pageErrors() {
    return errors.slice();
}

/** Strings from whatever was thrown or logged: never the objects. */
function describeValue(v) {
    if (v == null) return String(v);
    if (typeof v === "string") return v;
    if (v instanceof Error || (typeof v === "object" && "message" in v && "stack" in v)) {
        return String(v.message ?? v) + (v.stack ? "\n" + clip(v.stack, STACK_MAX) : "");
    }
    // the frontend logs { error } alongside its message
    if (typeof v === "object" && v.error) return describeValue(v.error);
    try { return clip(JSON.stringify(v), TEXT_MAX); } catch (e) { return Object.prototype.toString.call(v); }
}

export function notePageError(source, parts) {
    const text = (Array.isArray(parts) ? parts : [parts])
        .filter((p) => !(p && typeof p === "object" && ("extension" in p || "args" in p)))
        .map(describeValue).join(" ");
    errors.push({ t: Math.round(now()), source, text: clip(text, TEXT_MAX + STACK_MAX) });
    if (errors.length > ERRORS_MAX) errors.splice(0, errors.length - ERRORS_MAX);
}

let windowListening = false;
export function listenForPageErrors(target = typeof window !== "undefined" ? window : null) {
    if (windowListening || !target?.addEventListener) return;
    windowListening = true;
    target.addEventListener("error", (ev) => {
        notePageError("error", [ev?.error ?? ev?.message,
            ev?.filename ? "at " + ev.filename + ":" + ev.lineno : ""]);
    });
    target.addEventListener("unhandledrejection", (ev) => {
        notePageError("unhandledrejection", [ev?.reason]);
    });
}

// ------------------------------------------------------------ load window

const load = { active: false, startedAt: null, finishedAt: null, count: 0,
               original: null, wrapper: null, timer: null };

export function loadState() {
    return { active: load.active, count: load.count,
             startedAt: load.startedAt, finishedAt: load.finishedAt };
}

/** A workflow load is starting: listen to console.error until it ends. */
export function loadStarted(con = typeof console !== "undefined" ? console : null) {
    load.count += 1;
    load.startedAt = Math.round(now());
    load.finishedAt = null;
    if (!con) return;
    if (!load.active) {
        load.active = true;
        load.original = con.error;
        const original = load.original;
        load.wrapper = function (...args) {
            // recorded only while a load is on; left in a chain after
            // one (see stopListening), it just passes through
            if (load.active) {
                try { notePageError("console.error", args); } catch (e) { /* never break logging */ }
            }
            return original.apply(this, args);
        };
        con.error = load.wrapper;
    }
    clearTimeout(load.timer);
    load.timer = setTimeout(() => stopListening(con), LOAD_CAP_MS);
    load.timer?.unref?.();
}

/** The load reported finishing: keep listening a little, then stop. */
export function loadFinished(con = typeof console !== "undefined" ? console : null) {
    load.finishedAt = Math.round(now());
    clearTimeout(load.timer);
    load.timer = setTimeout(() => stopListening(con), LOAD_TAIL_MS);
    load.timer?.unref?.();
}

function stopListening(con) {
    if (!load.active) return;
    load.active = false;
    // Put the original back only if ours is still the one in place.
    // Another extension may have wrapped console.error on top of ours
    // since; unwinding it would silently drop theirs. Then ours stays
    // in the chain, and with `load.active` off it only passes through.
    if (con && load.original && con.error === load.wrapper) con.error = load.original;
    load.original = null;
    load.wrapper = null;
}

// ------------------------------------------------------------ the report

/**
 * The report as text. `facts` is what the caller knows about the node
 * and the page (plain values); the trace and the page errors come from
 * here.
 */
export function reportText(node, facts = {}) {
    const lines = ["Value Presets diagnostics"];
    for (const [key, value] of Object.entries(facts)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
            lines.push(key + ":");
            for (const item of value) lines.push("  " + clip(item, 400));
        } else {
            lines.push(key + ": " + clip(value, 400));
        }
    }
    const t0 = node?.__obvpmTrace?.[0]?.t ?? 0;
    lines.push("", "trace (ms since first event):");
    for (const ev of node?.__obvpmTrace ?? []) {
        lines.push("  +" + (ev.t - t0) + " " + ev.e + (ev.d ? " " + ev.d : ""));
    }
    if (!(node?.__obvpmTrace?.length)) lines.push("  (nothing recorded)");
    const ld = loadState();
    lines.push("", "workflow loads seen: " + ld.count + (ld.count
        ? (ld.finishedAt == null ? " (the last one never reported finishing)" : "") : ""));
    lines.push("page errors (last " + ERRORS_MAX + ", load-time console.error included):");
    const errs = pageErrors();
    if (!errs.length) lines.push("  (none)");
    for (const e of errs) lines.push("  [" + e.source + " @" + e.t + "ms] " + e.text.replace(/\n/g, "\n    "));
    return lines.join("\n");
}

export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (err) {
        // no clipboard permission (http, an old browser): the old way
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        let ok = false;
        try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
        area.remove();
        return ok;
    }
}
