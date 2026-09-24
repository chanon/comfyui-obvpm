import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { el, TEXT, TITLE, INK, DIM, EDGE, FILL, PANEL, pushButton, openOverlay,
         askConfirm, themePalette, dropWidgetSockets, addPanelWidget } from "./obvpm_ui.js";

/**
 * Compatibility Check: the rules, checked.
 *
 * THE RULES ARE PARSED ON THE SERVER (compat.py), which is also what
 * refuses a run. This file only asks /obvpm/compat for the results and
 * shows them. Asked when the node is built, when the rules text
 * changes, and on "Check Again" in View Details.
 *
 * THE FACE IS A SUMMARY. The node says whether the install can run the
 * workflow and names what fails, one line each; everything else --
 * what each rule asks, what is installed, the fix, the link -- is in
 * "View Details", as one table per kind of rule. That is also where
 * the rules are edited: the settings button turns the tables into inputs, and
 * "Edit as Text" is there for pasting a list.
 *
 * THE RULES TEXT STAYS THE ONE STORE. Like Value Presets' schema,
 * `rules` is a real widget (in the workflow, wire-able), hidden on the
 * node. The tables are a VIEW of it: the server says which line each
 * rule came from, an edited row is written back as a line in the same
 * place, an untouched row keeps its line exactly as written, and the
 * comment and blank lines stay where they were. Rows become text here
 * (`lineOf`), text becomes rows only on the server, so there is still
 * one parser.
 *
 * EVERYTHING SHOWN IS TEXT. The rules arrive inside shared workflows
 * and the results quote them, so every string lands as textContent; a
 * URL becomes an anchor only when it is http(s), and that anchor is the
 * one place text becomes an action.
 */

const NODE = "CompatibilityCheck (obvpm)";
const RULES = "rules";
const PANEL_NAME = "obvpm_compat_panel";
const RED = "rgba(220,80,80,0.6)";
const GREEN = "rgba(80,180,110,0.6)";
const AMBER = "rgba(220,170,60,0.8)";
const RED_TEXT = "#ff8a8a";
const GREEN_TEXT = "#7fd49a";
const AMBER_TEXT = "#e8c060";
// the settings icon; U+FE0E asks for the plain glyph, not a colour emoji
const GEAR = "⚙︎";

function widget(node, name) {
    return (node.widgets ?? []).find((w) => w.name === name);
}

function hide(w) {
    if (!w) return;
    // both ways: the canvas renderer reads widget.hidden, the Vue one
    // reads widget.options.hidden
    w.hidden = true;
    (w.options ??= {}).hidden = true;
    const box = w.element ?? w.inputEl;
    if (box) box.style.display = "none";
}

async function fetchResults(rules) {
    const r = await api.fetchApi("/obvpm/compat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: String(rules ?? "") }),
    });
    return await r.json();
}

// ---------------------------------------------------------------------
// The report (Copy Report)
// ---------------------------------------------------------------------

/**
 * The install, as text for a bug report: what the server knows
 * (/obvpm/compat/report: ComfyUI, Python, torch, OS, every loaded pack
 * with version and commit) plus what only the browser knows (frontend
 * version, Nodes 2.0 or classic, language, browser) and the current
 * results of this node's rules.
 */
async function reportText(answer) {
    const r = await api.fetchApi("/obvpm/compat/report");
    const s = await r.json();
    if (s?.error) throw new Error(String(s.error));
    const setting = (key) => {
        try { return app.extensionManager?.setting?.get?.(key); } catch (err) { return undefined; }
    };
    const frontend = String(window.__COMFYUI_FRONTEND_VERSION__ ?? "unknown");
    const vue = typeof LiteGraph !== "undefined" && LiteGraph.vueNodesMode != null
        ? !!LiteGraph.vueNodesMode : !!setting("Comfy.VueNodes.Enabled");
    const lines = [
        "ComfyUI " + String(s.comfyui || "unknown") + " · frontend " + frontend
            + " · " + (vue ? "Nodes 2.0" : "classic nodes"),
        "Python " + String(s.python || "?") + " · torch " + String(s.torch || "?")
            + " · " + String(s.os || "?"),
        "language " + String(setting("Comfy.Locale") ?? "?")
            + " · " + String(navigator.userAgent ?? ""),
        "",
        "Custom node packs (" + (s.packs?.length ?? 0) + "):",
    ];
    for (const p of s.packs ?? []) {
        lines.push("  " + String(p.name) + (p.version ? " " + String(p.version) : "")
                   + (p.commit ? " (" + String(p.commit) + ")" : ""));
    }
    const results = Array.isArray(answer?.results) ? answer.results : [];
    if (results.length) {
        lines.push("", "Compatibility Check:");
        for (const p of results) {
            lines.push("  " + (p.ok ? "ok   " : "FAIL ") + String(p.title ?? "")
                       + (p.detail ? " — " + String(p.detail) : ""));
        }
    }
    return lines.join("\n");
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (err) {
        // no clipboard permission (http, or an old browser): the old way
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

function toast(severity, summary, detail) {
    app.extensionManager?.toast?.add?.({ severity, summary, detail, life: 4000 });
}

async function copyReport(answer) {
    try {
        const ok = await copyText(await reportText(answer));
        if (ok) toast("success", "Install report copied", "Paste it into the bug report.");
        else toast("warn", "Could not copy", "The browser refused clipboard access.");
    } catch (err) {
        toast("error", "Could not build the report", String(err?.message ?? err));
    }
}

// ---------------------------------------------------------------------
// Rules as rows, rows as text
// ---------------------------------------------------------------------

/** A server result -> the editable parts of its line. */
function rowOf(r) {
    return {
        kind: String(r?.kind ?? "error"),
        name: String(r?.name ?? ""),
        version: String(r?.version ?? ""),
        node: String(r?.node ?? ""),
        input: String(r?.input_name ?? ""),
        url: String(r?.url ?? ""),
        note: String(r?.note ?? ""),
        raw: String(r?.rule ?? ""),
    };
}

/**
 * One row -> its line of rules text, in the form compat.py reads.
 *
 * The URL goes before the note: the note starts at the first " #" and
 * runs to the end of the line, so anything after it would be note.
 * A line the server could not read is kept as the text it was.
 */
function lineOf(row) {
    const t = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
    let body;
    switch (row.kind) {
        case "core": body = "comfyui >= " + t(row.version); break;
        case "pack": body = t(row.name) + " >= " + t(row.version) + "   node: " + t(row.node); break;
        case "node": body = "node " + t(row.name) + (t(row.input) ? " has " + t(row.input) : ""); break;
        case "no_node": body = "not node " + t(row.name); break;
        case "no_pack": body = "not pack " + t(row.name); break;
        default: return t(row.raw);
    }
    if (t(row.url)) body += "   " + t(row.url);
    if (t(row.note)) body += "   # " + t(row.note);
    return body;
}

/** A row with nothing typed into it: left out of the text. */
function isBlank(row) {
    if (row.kind === "error") return !String(row.raw ?? "").trim();
    return ["name", "version", "node", "input", "url", "note"]
        .every((k) => !String(row[k] ?? "").trim());
}

/**
 * The rules text as entries, in its own order: a rule (with the result
 * it got) or a line that is not one (blank, comment). `lines` is the
 * server's split of the text; a result's `line` indexes it.
 */
function entriesOf(lines, results) {
    const byLine = new Map();
    for (const r of results ?? []) {
        if (Number.isInteger(r?.line)) byLine.set(r.line, r);
    }
    return (lines ?? []).map((source, i) => {
        const text = String(source ?? "");
        const result = byLine.get(i);
        if (!result) return { raw: text };
        const row = rowOf(result);
        return { row, result, source: text, orig: JSON.stringify(row) };
    });
}

function isChanged(entry) {
    return !!entry.fresh || entry.orig !== JSON.stringify(entry.row);
}

/**
 * Entries -> the rules text, plus which entry each line came from (so
 * a line the server then cannot read points back at its row). An
 * untouched rule keeps the line exactly as it was written.
 */
function serialize(entries) {
    const lines = [];
    const owners = [];
    for (const e of entries ?? []) {
        if (e.removed) continue;
        let line;
        if (!e.row) line = e.raw;
        else if (!isChanged(e)) line = e.source;
        else if (isBlank(e.row)) continue;
        else line = lineOf(e.row);
        lines.push(line);
        owners.push(e);
    }
    return { text: lines.join("\n"), owners };
}

// ---------------------------------------------------------------------
// Summary (the face and the dialog's heading)
// ---------------------------------------------------------------------

function counts(answer) {
    const results = Array.isArray(answer?.results) ? answer.results : [];
    const failed = results.filter((r) => !r.ok);
    const unknown = results.filter((r) => r.ok && r.state === "unknown");
    return { results, failed, unknown };
}

function headline(answer) {
    if (answer?.error) return "✗ " + String(answer.error);
    const { results, failed } = counts(answer);
    if (!results.length) return "No requirements listed";
    if (failed.length) {
        return (failed.length === 1 ? "One thing" : failed.length + " things")
            + " to fix before this workflow can run, then restart ComfyUI:";
    }
    return "This install can run the workflow";
}

/**
 * The node's face, the part that scrolls: the verdict, what fails (one
 * line each), how many passed. `frame` is what wears the red or green
 * edge (the whole panel). The buttons are not painted here: they sit
 * under this list, outside the scroll, and never change. Returns the
 * failure count.
 */
function paint(list, answer, frame = list) {
    const P = themePalette();
    list.replaceChildren();
    frame.style.color = P.text;
    if (answer?.error) {
        frame.style.borderColor = RED;
        list.appendChild(el("div", { fontWeight: "600" }, headline(answer)));
        return 1;
    }
    const { results, failed, unknown } = counts(answer);
    frame.style.borderColor = failed.length ? RED : GREEN;
    list.appendChild(el("div", { font: "600 13px sans-serif" }, headline(answer)));
    for (const r of failed) {
        list.appendChild(el("div", {
            paddingLeft: "8px", borderLeft: "3px solid " + RED,
        }, "✗ " + String(r.title ?? "")));
    }
    const passed = results.length - failed.length - unknown.length;
    const tally = [];
    if (passed) tally.push("✓ " + passed + (passed === 1 ? " check passed" : " checks passed"));
    if (unknown.length) tally.push("? " + unknown.length + " could not be checked");
    if (tally.length) list.appendChild(el("div", { color: DIM }, tally.join(" · ")));
    return failed.length;
}

/** The face's buttons, under the list: View Details and Copy Report. */
function faceButtons(actions = {}) {
    return buttonRow(themePalette(), [["View Details", actions.details],
                                      ["Copy Report", actions.report]]);
}

/** The face's buttons: small, in the node's own chrome colours. */
function buttonRow(P, specs) {
    const row = el("div", { display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "2px" });
    for (const [label, run] of specs) {
        const b = document.createElement("button");
        b.textContent = label;
        Object.assign(b.style, {
            cursor: "pointer", padding: "2px 8px", borderRadius: "4px",
            border: "1px solid " + P.edge, background: P.rest, color: P.text,
            font: "11px sans-serif",
        });
        b.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            run?.();
        });
        row.appendChild(b);
    }
    return row;
}

// ---------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------

function linkOf(url) {
    const text = String(url ?? "");
    if (!text) return "";
    if (!/^https?:\/\//i.test(text)) return el("span", { color: DIM }, text);
    const a = document.createElement("a");
    a.href = text;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = text;
    const short = text.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
    a.textContent = (short.length > 44 ? short.slice(0, 43) + "…" : short) + " ↗";
    Object.assign(a.style, { color: "#7ab8ff", textDecoration: "underline",
                             whiteSpace: "nowrap" });
    return a;
}

function badge(result) {
    if (!result) return el("span", { color: DIM }, "new");
    const [text, color] = !result.ok ? ["✗ Fix", RED_TEXT]
        : result.state === "unknown" ? ["? Unknown", AMBER_TEXT]
        : ["✓ OK", GREEN_TEXT];
    return el("span", { color, fontWeight: "600", whiteSpace: "nowrap" }, text);
}

const RESULT = { label: "Result", view: (row, r) => badge(r),
                 tip: "How this rule came out when it was last checked." };
const INSTALLED = { label: "Installed", view: (row, r) => String(r?.installed ?? ""),
                    tip: "What this install has." };
const LINK = { label: "Link", field: "url", placeholder: "https://…", min: "190px",
               view: (row) => linkOf(row.url),
               tip: "Where to get it: shown with the result, opens in a new tab." };
// A note can run to a sentence or two, too much for a column: the cell
// is a button that opens it (and, while editing, edits it).
const NOTE = { label: "Note", note: true,
               tip: "A word of explanation about the rule. Click to read it." };

const GROUPS = [
    {
        title: "ComfyUI", kinds: ["core"], add: "core", single: true,
        about: "The oldest ComfyUI the workflow runs on.",
        columns: [RESULT,
            { label: "Required version", field: "version", placeholder: "0.35.0", min: "90px",
              view: (row, r) => String(r?.required ?? (row.version ? ">= " + row.version : "")) },
            INSTALLED, LINK, NOTE],
    },
    {
        title: "Node packs", kinds: ["pack"], add: "pack",
        about: "The oldest version of a pack that works. The pack is found by a node it "
             + "registers, and its version is read from the pack's pyproject.toml.",
        columns: [RESULT,
            { label: "Pack", field: "name", placeholder: "comfyui-some-pack", min: "160px",
              view: (row) => row.name },
            { label: "Required version", field: "version", placeholder: "1.2.0", min: "80px",
              view: (row, r) => String(r?.required ?? (row.version ? ">= " + row.version : "")) },
            INSTALLED,
            { label: "Found by node", field: "node", placeholder: "a node id the pack registers",
              min: "190px", view: (row) => el("span", { color: DIM }, row.node),
              tip: "A node id the pack registers: how the installed pack is found, "
                 + "whatever its folder is called." },
            LINK, NOTE],
    },
    {
        title: "Nodes", kinds: ["node"], add: "node",
        about: "A node that must be installed. 'Must have input' tells a fork that "
             + "registers the same node name with different settings apart.",
        columns: [RESULT,
            { label: "Node", field: "name", placeholder: "NodeId", min: "170px",
              view: (row) => row.name },
            { label: "Must have input", field: "input", placeholder: "optional", min: "130px",
              view: (row) => row.input ? row.input : el("span", { color: DIM }, "—") },
            INSTALLED, LINK, NOTE],
    },
    {
        title: "Must not be installed", kinds: ["no_node", "no_pack"], add: "no_pack",
        about: "A pack (by its folder name under custom_nodes) or a node whose pack "
             + "breaks the workflow when it is installed.",
        columns: [RESULT,
            { label: "Kind", field: "kind", choices: [["no_pack", "pack"], ["no_node", "node"]],
              view: (row) => (row.kind === "no_node" ? "node" : "pack") },
            { label: "Name", field: "name", placeholder: "FolderName or NodeId", min: "170px",
              view: (row) => row.name },
            INSTALLED, LINK, NOTE],
    },
    {
        title: "Rules that cannot be read", kinds: ["error"],
        about: "Fix the line or remove it.",
        columns: [RESULT,
            { label: "Line", field: "raw", placeholder: "", min: "320px",
              view: (row) => el("span", { font: "12px monospace" }, row.raw) },
            { label: "Problem", view: (row, r) => String(r?.detail ?? "") }],
    },
];

function groupOf(kind) {
    return GROUPS.find((g) => g.kinds.includes(kind)) ?? GROUPS[GROUPS.length - 1];
}

const CELL = { padding: "5px 8px", textAlign: "left", verticalAlign: "top",
               borderBottom: "1px solid rgba(127,127,127,0.22)" };

function cellInput(col, entry, touched) {
    const row = entry.row;
    if (col.choices) {
        const select = el("select", {
            background: FILL, color: INK, border: "1px solid " + EDGE,
            borderRadius: "4px", padding: "3px 4px", font: "13px sans-serif",
        });
        for (const [value, label] of col.choices) {
            const option = el("option", {}, label);
            option.value = value;
            select.appendChild(option);
        }
        select.value = row[col.field];
        select.addEventListener("change", () => {
            row[col.field] = select.value;
            touched();
        });
        return select;
    }
    const input = el("input", {
        background: FILL, color: INK, border: "1px solid " + EDGE,
        borderRadius: "4px", padding: "3px 6px", font: "13px sans-serif",
        width: "100%", minWidth: col.min ?? "80px", boxSizing: "border-box",
    });
    input.type = "text";
    input.value = row[col.field] ?? "";
    input.placeholder = col.placeholder ?? "";
    input.spellcheck = false;
    input.addEventListener("input", () => {
        row[col.field] = input.value;
        touched();
    });
    return input;
}

/**
 * One kind of rule as a table. In "view" the rows are results, failures
 * first, each failure followed by what was found and the fix. In "edit"
 * the rows are entries in the text's order, their fields are inputs,
 * and a row can be removed or added.
 */
function section(group, list, mode, hooks = {}) {
    const editing = mode === "edit";
    const wrap = el("div", { display: "flex", flexDirection: "column", gap: "4px" });
    const title = el("div", { display: "flex", alignItems: "baseline", gap: "8px",
                              flexWrap: "wrap", paddingBottom: "6px" });
    title.appendChild(el("span", { font: "600 14px sans-serif" }, group.title));
    if (editing) title.appendChild(el("span", { color: DIM, font: "12px sans-serif" }, group.about));
    wrap.appendChild(title);

    const scroller = el("div", { overflowX: "auto" });
    const table = el("table", { borderCollapse: "collapse", width: "100%",
                                font: "13px sans-serif" });
    const head = el("tr", {});
    for (const col of group.columns) {
        const th = el("th", { ...CELL, color: DIM, fontWeight: "600", whiteSpace: "nowrap" },
                      col.label);
        if (col.tip) th.title = col.tip;
        head.appendChild(th);
    }
    if (editing) head.appendChild(el("th", { ...CELL, width: "1%" }));
    const thead = el("thead", {});
    thead.appendChild(head);
    const tbody = el("tbody", {});
    table.append(thead, tbody);
    scroller.appendChild(table);
    wrap.appendChild(scroller);
    const span = group.columns.length + (editing ? 1 : 0);

    // the Note cell: a button, "View" when there is a note to read; while
    // editing, "Edit" / "Add" and the note is changed in a pop
    const noteCell = (entry, touched) => {
        const td = el("td", { ...CELL });
        const has = () => !!String(entry.row.note ?? "").trim();
        if (!editing && !has()) return td;
        const label = () => (!editing ? "View" : has() ? "Edit" : "Add");
        const b = pushButton(label(), () => hooks.note?.(entry, editing, () => {
            b.textContent = label();
            b.title = has() ? String(entry.row.note) : "Add a note";
            touched?.();
        }), { padding: "1px 8px", font: "12px sans-serif" });
        b.title = has() ? String(entry.row.note) : "Add a note";
        td.appendChild(b);
        return td;
    };

    if (!list.length) {
        const tr = el("tr", {});
        const td = el("td", { ...CELL, color: DIM }, editing ? "none yet" : "none");
        td.colSpan = span;
        tr.appendChild(td);
        tbody.appendChild(tr);
    }
    for (const entry of list) {
        const { row, result } = entry;
        const tr = el("tr", {});
        entry.tr = tr;
        const extra = [];
        if (editing) {
            if (entry.problem) tr.style.background = "rgba(220,80,80,0.14)";
            // the last check's result stands until the row is changed;
            // after that it is about a line that no longer exists
            const status = () => (entry.fresh ? el("span", { color: DIM }, "new")
                : isChanged(entry) ? el("span", { color: AMBER_TEXT }, "edited")
                : badge(result));
            let statusCell = null;
            const touched = () => {
                // the server's complaint was about the old text
                if (entry.problem) {
                    entry.problem = null;
                    tr.style.background = "";
                    for (const x of extra) x.remove();
                }
                statusCell?.replaceChildren(status());
                hooks.changed?.();
            };
            for (const col of group.columns) {
                if (col.note) {
                    tr.appendChild(noteCell(entry, touched));
                    continue;
                }
                const td = el("td", { ...CELL });
                if (col === RESULT) {
                    statusCell = td;
                    td.appendChild(status());
                } else if (col.field) td.appendChild(cellInput(col, entry, touched));
                else {
                    const shown = col.view(row, result);
                    if (shown && typeof shown === "object") td.appendChild(shown);
                    else td.textContent = String(shown ?? "");
                    td.style.color = DIM;
                }
                tr.appendChild(td);
            }
            const td = el("td", { ...CELL });
            const remove = pushButton("✕", () => hooks.remove?.(entry),
                                      { padding: "2px 8px", font: "12px sans-serif" });
            remove.title = "Remove this rule";
            td.appendChild(remove);
            tr.appendChild(td);
            tbody.appendChild(tr);
            if (entry.problem) {
                const more = el("tr", {});
                const cell = el("td", { ...CELL, color: RED_TEXT, paddingTop: "0" },
                                "✗ " + String(entry.problem));
                cell.colSpan = span;
                more.appendChild(cell);
                tbody.appendChild(more);
                extra.push(more);
            }
            continue;
        }
        for (const col of group.columns) {
            if (col.note) {
                tr.appendChild(noteCell(entry));
                continue;
            }
            const td = el("td", { ...CELL });
            const shown = col.view(row, result);
            if (shown && typeof shown === "object") td.appendChild(shown);
            else td.textContent = String(shown ?? "");
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
        if (result && !result.ok && (result.detail || result.fix)) {
            // what was found and what to do, under the row it is about
            const more = el("tr", {});
            const cell = el("td", { ...CELL, paddingTop: "0", paddingLeft: "22px" });
            cell.colSpan = span;
            if (result.detail) cell.appendChild(el("div", {}, String(result.detail)));
            if (result.fix) {
                const fix = el("div", {});
                fix.append(el("b", {}, "Fix: "), document.createTextNode(String(result.fix)));
                cell.appendChild(fix);
            }
            more.appendChild(cell);
            tbody.appendChild(more);
            tr.style.borderLeft = "3px solid " + RED;
        }
    }
    // one ComfyUI rule is all there can usefully be
    if (editing && group.add && !(group.single && list.length)) {
        const add = pushButton("+ Add", () => hooks.add?.(group),
                               { alignSelf: "flex-start", padding: "2px 10px",
                                 font: "12px sans-serif" });
        add.title = "Add a rule of this kind";
        wrap.appendChild(add);
    }
    return wrap;
}

// ---------------------------------------------------------------------
// The details dialog
// ---------------------------------------------------------------------

/**
 * A rule's note in a pop over the dialog: read it, or (`onSave`) edit
 * it. Escape and a click outside close the pop and only the pop. A note
 * is one line of the rules text, so line breaks typed here become
 * spaces.
 */
function openNotePop(overlay, { title, text, onSave }) {
    const pop = el("div", {
        position: "fixed", inset: "0", zIndex: "10001",
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.35)",
    });
    const card = el("div", {
        background: PANEL, color: INK, font: TEXT,
        border: "1px solid " + EDGE, borderRadius: "8px", padding: "14px",
        width: "min(520px, 90vw)", boxSizing: "border-box",
        display: "flex", flexDirection: "column", gap: "10px",
        boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
    });
    const close = () => pop.remove();
    const footer = el("div", { display: "flex", gap: "6px", justifyContent: "flex-end" });
    let area = null;
    if (onSave) {
        area = el("textarea", {
            background: FILL, color: INK, border: "1px solid " + EDGE,
            borderRadius: "4px", padding: "6px 8px", font: TEXT,
            minHeight: "90px", resize: "vertical", boxSizing: "border-box",
        });
        area.value = text;
        area.placeholder = "Shown with the rule's result, e.g. why it matters or which fork to avoid";
        footer.append(pushButton("Cancel", close), pushButton("OK", () => {
            onSave(area.value.replace(/\s*\n\s*/g, " ").trim());
            close();
        }, { fontWeight: "600" }));
        card.append(el("div", { font: TITLE }, title), area, footer);
    } else {
        footer.append(pushButton("Close", close));
        card.append(el("div", { font: TITLE }, title),
                    el("div", { whiteSpace: "pre-wrap", overflowWrap: "anywhere" }, text),
                    footer);
    }
    pop.appendChild(card);
    pop.addEventListener("mousedown", (ev) => {
        if (ev.target === pop) close();
    });
    pop.obvpmClose = close;
    pop.dataset.obvpmPop = "1";      // Escape closes this first
    overlay.appendChild(pop);
    area?.focus();
    return pop;
}

/** What a row is about, for a pop's title: "Note: comfyui-obvpm". */
function thingOf(row) {
    if (row.kind === "core") return "ComfyUI";
    return String(row.name ?? "").trim() || "this rule";
}

/**
 * A text box over the dialog (a pop: Escape and a click outside close
 * it and only it). `onApply(text)` answers null when it took the text,
 * or a message to show while the box stays open.
 */
function openTextPop(overlay, text, { title, applyLabel, onApply }) {
    const pop = el("div", {
        position: "fixed", inset: "0", zIndex: "10001",
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.35)",
    });
    const card = el("div", {
        background: PANEL, color: INK, font: TEXT,
        border: "1px solid " + EDGE, borderRadius: "8px", padding: "14px",
        width: "min(860px, 92vw)", maxHeight: "82vh", boxSizing: "border-box",
        display: "flex", flexDirection: "column", gap: "8px",
        boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
    });
    const area = el("textarea", {
        background: FILL, color: INK, border: "1px solid " + EDGE,
        borderRadius: "4px", padding: "6px 8px", font: "13px monospace",
        minHeight: "280px", flex: "1 1 auto", resize: "vertical", boxSizing: "border-box",
        whiteSpace: "pre", overflowWrap: "normal", overflowX: "auto",
    });
    area.value = text;
    area.spellcheck = false;
    area.placeholder = "comfyui >= 0.35.0\nsome-pack >= 1.2.0   node: SomeNode   https://…\nnode SomeNode has some_input   https://…   # the original, not a fork\nnot pack Some-Pack   # breaks this workflow when installed";
    const legend = el("div", { color: DIM, font: "12px sans-serif" },
        "One requirement per line: comfyui >= 0.35.0 · some-pack >= 1.2.0 "
        + "node: NodeId (a node the pack registers; its version is read from "
        + "the pack's pyproject) · node NodeId · node NodeId has input_name "
        + "(tells a same-name fork apart) · not node NodeId / not pack "
        + "FolderName (a pack that breaks the workflow when installed). A "
        + "URL on the line becomes the link; text after ' #' is shown with "
        + "the result. Lines starting with # are comments.");
    const message = el("div", { color: RED_TEXT, font: "12px sans-serif" });
    const close = () => pop.remove();
    const apply = pushButton(applyLabel, async () => {
        apply.disabled = true;
        message.textContent = "";
        let problem;
        try {
            problem = await onApply(area.value);
        } catch (err) {
            problem = String(err?.message ?? err);
        }
        apply.disabled = false;
        if (problem) message.textContent = problem;
        else close();
    }, { fontWeight: "600" });
    const footer = el("div", { display: "flex", gap: "6px", justifyContent: "flex-end" });
    footer.append(pushButton("Cancel", close), apply);
    card.append(el("div", { font: TITLE }, title), legend, area, message, footer);
    pop.appendChild(card);
    pop.addEventListener("mousedown", (ev) => {
        if (ev.target === pop) close();
    });
    pop.obvpmClose = close;
    pop.dataset.obvpmPop = "1";      // Escape closes this first
    overlay.appendChild(pop);
    area.focus();
    return pop;
}

/**
 * View Details: the results as tables, and the place the rules are
 * edited. `ctx`: rules (the widget), answer() (the latest answer the
 * face painted), refresh() (check again; resolves once painted).
 *
 * Escape goes one layer at a time: the text box, then the edit (with a
 * question first if something was changed), then the dialog.
 */
function openDetails(node, ctx) {
    const state = { mode: "view", entries: [], baseline: "", banner: "" };
    const { overlay, panel, close } = openOverlay("min(1120px, 96vw)", null, {
        dismiss: (closeDialog) => {
            if (state.mode === "edit") void cancelEdit();
            else closeDialog();
        },
    });
    const head = el("div", { display: "flex", flexDirection: "column", gap: "4px" });
    const body = el("div", {
        flex: "1 1 auto", minHeight: "0", overflow: "auto",
        display: "flex", flexDirection: "column", gap: "28px", paddingRight: "4px",
    });
    const foot = el("div", { display: "flex", flexWrap: "wrap", gap: "6px",
                             alignItems: "center" });
    panel.append(head, body, foot);

    const dirty = () => serialize(state.entries).text !== state.baseline;

    function startEdit() {
        const answer = ctx.answer();
        if (!Array.isArray(answer?.lines) || answer?.error) {
            // No line map (the server is older than this page, or the
            // rules could not be read at all): the text is the only
            // safe way to edit them, and it saves directly.
            openTextPop(overlay, String(ctx.rules?.value ?? ""), {
                title: "Rules", applyLabel: "Apply",
                onApply: async (text) => {
                    commit(text);
                    await ctx.refresh();
                    render();
                    return null;
                },
            });
            return;
        }
        state.entries = entriesOf(answer.lines, answer.results);
        state.baseline = serialize(state.entries).text;
        state.banner = "";
        state.mode = "edit";
        render();
    }

    async function cancelEdit() {
        if (dirty()) {
            const discard = await askConfirm("Your changes to the rules have not been "
                                             + "applied.", { title: "Discard changes?",
                                                             ok: "Discard" });
            if (!discard) return;
        }
        state.mode = "view";
        state.banner = "";
        render();
    }

    function commit(text) {
        const rules = ctx.rules;
        if (!rules) return;
        rules.value = text;
        rules.callback?.(text);
    }

    async function apply(button) {
        const { text, owners } = serialize(state.entries);
        if (text === state.baseline) {
            state.mode = "view";
            render();
            return;
        }
        button.disabled = true;
        button.textContent = "Checking…";
        let answer;
        try {
            answer = await fetchResults(text);
        } catch (err) {
            answer = { error: "Could not reach the server to check: "
                              + String(err?.message ?? err) };
        }
        if (answer?.error) {
            state.banner = String(answer.error);
            render();
            return;
        }
        // A line the server cannot read that an edit here produced is
        // sent back to its row. One that was already unreadable and
        // left alone does not block: it was there before.
        for (const e of state.entries) e.problem = null;
        let bad = 0;
        for (const r of answer.results ?? []) {
            if (r.kind !== "error" || !Number.isInteger(r.line)) continue;
            const owner = owners[r.line];
            if (!owner?.row) continue;
            if (owner.row.kind === "error" && !isChanged(owner)) continue;
            owner.problem = String(r.detail ?? "cannot be read");
            bad += 1;
        }
        if (bad) {
            state.banner = (bad === 1 ? "One rule cannot be read" : bad + " rules cannot be read")
                + ". Fix or remove the marked rows, then Apply again.";
            render();
            return;
        }
        commit(text);
        await ctx.refresh();
        state.mode = "view";
        state.banner = "";
        render();
    }

    function addRow(group) {
        const entry = { row: rowOf({ kind: group.add, rule: "" }), fresh: true };
        // after the last rule of the same kind, so the text stays grouped
        // the way it was written; at the end when there is none
        let at = -1;
        state.entries.forEach((e, i) => {
            if (e.row && !e.removed && group.kinds.includes(e.row.kind)) at = i;
        });
        if (at < 0) state.entries.push(entry);
        else state.entries.splice(at + 1, 0, entry);
        entry.focus = true;             // render puts the caret in it
        render();
    }

    function removeRow(entry) {
        entry.removed = true;
        render();
    }

    /** A row's note: read it (viewing) or change it (editing). */
    function showNote(entry, editable, changed) {
        const title = "Note: " + thingOf(entry.row);
        if (!editable) {
            openNotePop(overlay, { title, text: String(entry.row.note ?? "") });
            return;
        }
        openNotePop(overlay, {
            title, text: String(entry.row.note ?? ""),
            onSave: (text) => {
                entry.row.note = text;
                changed?.();
            },
        });
    }

    function editAsText() {
        openTextPop(overlay, serialize(state.entries).text, {
            title: "Edit rules as text", applyLabel: "Apply to Tables",
            onApply: async (text) => {
                const answer = await fetchResults(text);
                if (answer?.error) return String(answer.error);
                if (!Array.isArray(answer?.lines)) return "The server did not answer with the lines.";
                state.entries = entriesOf(answer.lines, answer.results);
                state.banner = "";
                render();
                return null;
            },
        });
    }

    function render() {
        const answer = ctx.answer();
        const editing = state.mode === "edit";
        const { failed } = counts(answer);

        head.replaceChildren();
        // the name and the verdict on one line, in one size; the verdict
        // keeps its colour
        const heading = el("div", { display: "flex", flexWrap: "wrap", alignItems: "baseline",
                                    columnGap: "14px", rowGap: "2px" });
        heading.appendChild(el("span", { font: TITLE },
                               editing ? "Compatibility Check: edit rules" : "Compatibility Check"));
        if (!editing) {
            heading.appendChild(el("span", {
                font: TITLE,
                color: answer?.error || failed.length ? RED_TEXT : GREEN_TEXT,
            }, headline(answer).replace(/:$/, ".")));
        }
        head.appendChild(heading);
        if (editing && state.banner) {
            head.appendChild(el("div", {
                color: RED_TEXT, font: "600 13px sans-serif", padding: "6px 8px",
                border: "1px solid " + RED, borderRadius: "4px",
            }, state.banner));
        }

        body.replaceChildren();
        if (editing) {
            for (const group of GROUPS) {
                const list = state.entries.filter((e) => e.row && !e.removed
                                                  && group.kinds.includes(e.row.kind));
                if (!group.add && !list.length) continue;
                body.appendChild(section(group, list, "edit", {
                    add: addRow, remove: removeRow, note: showNote,
                }));
            }
        } else {
            const results = Array.isArray(answer?.results) ? answer.results : [];
            const order = (r) => (!r.ok ? 0 : r.state === "unknown" ? 1 : 2);
            for (const group of GROUPS) {
                const list = results.filter((r) => group.kinds.includes(r.kind))
                    .sort((a, b) => order(a) - order(b))
                    .map((r) => ({ row: rowOf(r), result: r }));
                if (list.length) body.appendChild(section(group, list, "view", { note: showNote }));
            }
            if (!results.length && !answer?.error) {
                body.appendChild(el("div", { color: DIM },
                    "This node lists no requirements yet. The " + GEAR + " button adds them."));
            }
        }
        // a row just added takes the caret, in its first input
        const fresh = state.entries.find((e) => e.focus);
        if (fresh) {
            fresh.focus = false;
            if (editing) (fresh.tr?.querySelector?.("input") ?? fresh.tr?.querySelector?.("select"))?.focus?.();
        }

        foot.replaceChildren();
        const spacer = el("div", { flex: "1 1 auto" });
        if (editing) {
            const applyButton = pushButton("Apply", () => void apply(applyButton),
                                           { fontWeight: "600" });
            foot.append(pushButton("Edit as Text", editAsText), spacer,
                        pushButton("Cancel", () => void cancelEdit()), applyButton);
        } else {
            const again = pushButton("Check Again", async () => {
                again.disabled = true;
                again.textContent = "Checking…";
                await ctx.refresh();
                render();
            });
            // Editing is for whoever wrote the workflow, not whoever runs
            // it: a settings icon after the buttons, not a labelled
            // button among them.
            const gear = pushButton(GEAR, startEdit, { padding: "1px 9px", font: "19px sans-serif",
                                                       lineHeight: "1.2" });
            gear.title = "Edit the rules (for the workflow's author)";
            gear.setAttribute?.("aria-label", "Edit the rules");
            foot.append(again,
                        pushButton("Copy Report", () => void copyReport(ctx.answer())),
                        gear, spacer, pushButton("Close", close));
        }
    }

    document.body.appendChild(overlay);
    render();
    return { overlay, close, state, render };
}

// ---------------------------------------------------------------------
// The node
// ---------------------------------------------------------------------

function setup(node) {
    const rules = widget(node, RULES);
    hide(rules);
    // ... and its socket (unless something is wired into it, which
    // still works: the store is the widget either way)
    dropWidgetSockets(node, [RULES]);
    const panel = el("div", {
        gap: "6px", padding: "8px 10px",
        border: "1px solid " + RED, borderRadius: "6px",
        background: "rgba(127,127,127,0.06)", font: "12px sans-serif",
    });
    // the results scroll; the buttons under them stay where they are
    const list = el("div", { display: "flex", flexDirection: "column", gap: "6px" });
    list.appendChild(el("div", { color: DIM }, "checking…"));
    panel.appendChild(list);
    // The pack's DOM-panel recipe (obvpm_ui.js): fills the node, scrolls
    // inside it (the list only), never dictates its height in either
    // renderer. The node is grown to fit the content only while nobody
    // has resized it (see refresh).
    // A new node grows once to show the list (fitToContent); a loaded
    // one keeps the size it was saved with.
    const panelWidget = addPanelWidget(node, PANEL_NAME, panel, { minHeight: 80, scroller: list });

    let answer = null;
    const ctx = {
        rules,
        answer: () => answer,
        refresh: () => refresh(),
    };
    const actions = {
        details: () => openDetails(node, ctx),
        report: () => { void copyReport(answer); },
    };
    const buttons = faceButtons(actions);
    buttons.style.flex = "0 0 auto";
    panel.appendChild(buttons);

    let inFlight = null;
    async function refresh() {
        if (inFlight) return inFlight;
        const text = String(rules?.value ?? "");
        inFlight = (async () => {
            let got;
            try {
                got = await fetchResults(text);
            } catch (err) {
                got = { error: "Could not reach the server to check: "
                               + String(err?.message ?? err) };
            } finally {
                inFlight = null;
            }
            if (String(rules?.value ?? "") !== text) return refresh();   // stale
            answer = got;
            paint(list, answer, panel);
            panelWidget.fitToContent?.();
        })();
        return inFlight;
    }
    node.__obvpmCompatRefresh = refresh;
    node.__obvpmCompatDetails = actions.details;

    if (rules) {
        const previous = rules.callback;
        rules.callback = function (...args) {
            const out = previous?.apply(this, args);
            void refresh();
            return out;
        };
    }
    void refresh();
}

app.registerExtension({
    name: "obvpm.compat_check",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE) return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = created?.apply(this, arguments);
            setup(this);
            return r;
        };
        // a loaded workflow sets the rules after creation: check those
        const configure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = configure?.apply(this, arguments);
            // (the saved size is kept: addPanelWidget marks a configured
            // node so fitToContent leaves it alone)
            void this.__obvpmCompatRefresh?.();
            return r;
        };
    },
});
