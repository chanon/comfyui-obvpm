// The bundle config dialogs: reorder/hide for Unbundle's outputs,
// rename/reorder for Bundle's inputs.
//
// THE DIALOG IS THE ONLY PLACE LINKS MOVE. Sync never re-means a
// connected pin: it hands `syncSockets` a label list whose linked names
// are pinned to their positions (see `arrange`), and only an explicit
// OK here performs surgery -- and then BY NAME, so a wire that carried
// "mask" still carries "mask" wherever its pin lands.
//
// Imported by obvpm_dynamic.js and importing it back (utilities). The
// circle is safe: both files only call across it at runtime, nothing at
// module top level.

import {
    widget, bundleNamesFor, resyncGraph, labelSlot, notifyVue,
    repointLinks, linkById, originOf, derivedFor,
} from "./obvpm_dynamic.js";
import { el, TEXT, TITLE, DIM, pushButton, textBox,
         openOverlay } from "./obvpm_ui.js";

// Mirrors MAX_FIELDS in bundle.py: the server's declared out_N pool.
const MAX_FIELDS = 16;

// ---------------------------------------------------------------------
// The layout store
//
// `properties`, not a widget: this is UI intent (what the user arranged),
// serialized with the workflow but never sent in a prompt. The hidden
// `names` widget stays the single server channel, holding the EFFECTIVE
// list the layout produces. `known` is a cache of the last successful
// trace, so the dialog and sync still work when the trace comes back
// null (a switch whose branches disagree, an upstream not yet loaded).
// ---------------------------------------------------------------------

export function layoutOf(node) {
    const raw = node.properties?.obvpm_layout;
    return raw && typeof raw === "object" ? raw : null;
}

export function hasUnbundleLayout(node) {
    const l = layoutOf(node);
    return !!(l && ((l.order && l.order.length)
                    || (l.hidden && l.hidden.length)));
}

function saveLayout(node, layout) {
    (node.properties ??= {}).obvpm_layout = layout;
}

/** Names currently on this node's LINKED output slots. */
function linkedOutputNames(node) {
    const names = new Set();
    for (const slot of node.outputs ?? []) {
        if (slot.links?.length) {
            names.add(slot.label || slot.localized_name || slot.name);
        }
    }
    return names;
}

/**
 * The effective output list: the user's order over the live upstream
 * names.
 *
 * - `order` pins every name it knows to its position; upstream reorders
 *   stop mattering (which is the point -- see syncSockets' documented
 *   relabel-in-place weakness).
 * - Upstream names the order has not met are appended, VISIBLE: a new
 *   field showing up is information, not clutter.
 * - `hidden` removes a name only while nothing is wired to it; a linked
 *   name always stays, even one the trace no longer reports (the server
 *   yields None for it and says so) -- dropping it would shift every
 *   later pin's meaning, the exact bug this file exists to prevent.
 * - Deduped and capped at the server's pool: hiding fields is also how a
 *   >16-field bundle chooses which 16 to expose.
 */
export function arrange(traced, layout, linked) {
    const live = traced ?? layout?.known ?? [];
    const hidden = new Set(layout?.hidden ?? []);
    const seen = new Set();
    const eff = [];
    const take = (name) => {
        if (seen.has(name)) return;
        seen.add(name);
        if (hidden.has(name) && !linked.has(name)) return;
        eff.push(name);
    };
    for (const name of layout?.order ?? []) {
        if (live.includes(name) || linked.has(name)) take(name);
    }
    for (const name of live) take(name);
    for (const name of linked) take(name);   // never orphan a wire
    // Over the server's pool, unlinked names give way first: capping a
    // LINKED name off the end would rebuild every slot's links without
    // it -- wires silently gone.
    for (let i = eff.length - 1; i >= 0 && eff.length > MAX_FIELDS; i--) {
        if (!linked.has(eff[i])) eff.splice(i, 1);
    }
    return eff.slice(0, MAX_FIELDS);
}

/**
 * Make the node's outputs BE the effective list, moving links by name.
 *
 * Safe to run at any time, not just from the dialog: links are
 * snapshotted per field name first, so a pin that changes position takes
 * its wires with it and a run before/after delivers identical values.
 */
export function applyUnbundleLayout(node) {
    const layout = layoutOf(node) ?? {};
    const traced = bundleNamesFor(node, "in");
    if (traced) {
        layout.known = traced.slice();
        saveLayout(node, layout);
    }
    const eff = arrange(traced, layout, linkedOutputNames(node));

    // Snapshot: which link ids ride which FIELD, by the label each slot
    // wears now (its previous effective name).
    const byName = new Map();
    (node.outputs ?? []).forEach((slot) => {
        if (!slot.links?.length) return;
        const name = slot.label || slot.localized_name || slot.name;
        byName.set(name, slot.links.slice());
    });

    while ((node.outputs?.length ?? 0) < eff.length
           && (node.outputs?.length ?? 0) < MAX_FIELDS) {
        node.addOutput(`out_${(node.outputs?.length ?? 0) + 1}`, "*");
    }

    (node.outputs ?? []).forEach((slot, i) => {
        const name = eff[i];
        slot.name = `out_${i + 1}`;
        labelSlot(slot, name ?? `out_${i + 1} (unused)`);
        const ids = (name && byName.get(name)) || [];
        slot.links = ids.slice();
        for (const id of ids) {
            const link = linkById(node.graph, id);
            if (link) link.origin_slot = i;
        }
    });
    // Trailing surplus goes AFTER the links have moved onto their new
    // slots -- trimming first left the slot a link was about to leave
    // alive as "(unused)". Unlinked only: a linked slot's name is in
    // eff by construction, so a linked surplus cannot happen.
    for (let i = (node.outputs?.length ?? 0) - 1; i >= eff.length; i--) {
        if (node.outputs[i].links?.length) break;
        node.removeOutput(i);
    }

    // The widget is the server channel: line i names out_i. Cleared when
    // the layout is trivial, so an unconfigured node's prompt is
    // byte-identical to before this feature existed.
    const list = widget(node, "names");
    if (list) {
        const text = hasUnbundleLayout(node) ? eff.join("\n") : "";
        if (list.value !== text) {
            list.value = text;
            const listEl = list.element ?? list.inputEl;
            if (listEl) listEl.value = text;
        }
    }
    node.graph?.setDirtyCanvas(true, true);
    notifyVue(node);
}

// ---------------------------------------------------------------------
// The dialogs
// ---------------------------------------------------------------------

function rowShell() {
    return el("div", {
        display: "flex", gap: "6px", alignItems: "center",
        padding: "2px 0",
    });
}

function moveButtons(rows, index, redraw) {
    const move = (delta) => {
        const to = index + delta;
        if (to < 0 || to >= rows.length) return;
        rows.splice(to, 0, rows.splice(index, 1)[0]);
        redraw();
    };
    return [
        pushButton("▲", () => move(-1), { padding: "1px 5px" }),
        pushButton("▼", () => move(1), { padding: "1px 5px" }),
    ];
}

function footerOf(panel, close, onOk) {
    const error = el("div", {
        color: "#e88", whiteSpace: "pre-wrap", display: "none",
    });
    const footer = el("div", {
        display: "flex", gap: "8px", justifyContent: "flex-end",
        paddingTop: "4px",
    });
    footer.append(
        pushButton("Cancel", close),
        pushButton("OK", () => {
            const problem = onOk();
            if (problem) {
                error.textContent = problem;
                error.style.display = "block";
            } else {
                close();
            }
        }, { fontWeight: "600" }),
    );
    panel.append(error, footer);
}

/** Reorder and hide the Unbundle's outputs. */
export function openUnbundleConfig(node) {
    const layout = layoutOf(node) ?? {};
    const linked = linkedOutputNames(node);
    const traced = bundleNamesFor(node, "in");
    // The full field list, hidden ones included -- what there is to
    // arrange. Effective order first so the dialog opens showing what
    // the node shows, with the hidden names after it.
    const all = arrange(traced, { ...layout, hidden: [] }, linked);
    if (!all.length) {
        const { overlay, panel, close } = openOverlay("min(420px, 90vw)");
        panel.append(
            el("div", { font: TITLE }, "Unbundle outputs"),
            el("div", { color: DIM },
               "Connect a bundle first -- there are no fields to "
               + "arrange yet."),
        );
        footerOf(panel, close, () => null);
        document.body.appendChild(overlay);
        return;
    }
    const hiddenSet = new Set(layout.hidden ?? []);
    const rows = all.map((name) => ({ name, hidden: hiddenSet.has(name) }));

    const { overlay, panel, close } = openOverlay("min(480px, 90vw)");
    panel.append(el("div", { font: TITLE }, "Unbundle outputs"));
    panel.append(el("div", { color: DIM, font: "12px sans-serif" },
        "Reordering moves the wires with their fields. Hidden fields "
        + "have no pin; a field with connections cannot be hidden."));
    const list = el("div", {
        display: "flex", flexDirection: "column", gap: "2px",
        overflowY: "auto", padding: "4px 2px",
    });
    panel.append(list);

    function draw() {
        list.replaceChildren();
        rows.forEach((row, index) => {
            const shell = rowShell();
            shell.append(...moveButtons(rows, index, draw));
            const check = el("input");
            check.type = "checkbox";
            check.checked = !row.hidden;
            const wired = linked.has(row.name);
            if (wired && !row.hidden) {
                // Refuse rather than clamp: unhiding stays possible,
                // silently dropping wires does not.
                check.disabled = true;
                check.title = "Has connections -- unplug them first.";
            } else {
                check.title = "Shown as an output pin.";
            }
            check.addEventListener("change", () => {
                row.hidden = !check.checked;
                draw();
            });
            const label = el("span", {
                font: TEXT, flex: "1",
                color: row.hidden ? DIM : undefined,
                textDecoration: row.hidden ? "line-through" : "none",
            }, row.name);
            shell.append(check, label);
            if (wired) shell.append(el("span", { color: DIM }, "wired"));
            list.appendChild(shell);
        });
    }
    draw();

    footerOf(panel, close, () => {
        const linkedNow = linkedOutputNames(node);
        const bad = rows.filter((r) => r.hidden && linkedNow.has(r.name));
        if (bad.length) {
            return "Still connected: "
                + bad.map((r) => r.name).join(", ");
        }
        saveLayout(node, {
            ...layoutOf(node),
            order: rows.map((r) => r.name),
            hidden: rows.filter((r) => r.hidden).map((r) => r.name),
        });
        applyUnbundleLayout(node);
        resyncGraph(node);
        return null;
    });
    document.body.appendChild(overlay);
}

/** Rename and reorder the Bundle's inputs. */
export function openBundleConfig(node) {
    const re = /^in_(\d+)$/;
    const occupied = (node.inputs ?? [])
        .map((slot, index) => ({ slot, index }))
        .filter((x) => re.test(x.slot.name) && x.slot.link != null);
    if (!occupied.length) {
        const { overlay, panel, close } = openOverlay("min(420px, 90vw)");
        panel.append(
            el("div", { font: TITLE }, "Bundle fields"),
            el("div", { color: DIM },
               "Connect something first -- there are no fields to "
               + "rename yet."),
        );
        footerOf(panel, close, () => null);
        document.body.appendChild(overlay);
        return;
    }
    // The rows carry the SLOT (its link is the field's identity here);
    // the current label is what the user knows the field as, and the
    // origin node is the hint that says which wire this is.
    const rows = occupied.map(({ slot, index }) => {
        const source = originOf(node, slot);
        return {
            slot, index,
            name: slot.label || slot.localized_name || slot.name,
            origin: String(source?.node?.title
                           ?? source?.node?.type ?? "?"),
        };
    });

    const { overlay, panel, close } = openOverlay("min(560px, 92vw)");
    panel.append(el("div", { font: TITLE }, "Bundle fields"));
    panel.append(el("div", { color: DIM, font: "12px sans-serif" },
        "Names key the bundle's fields (letters, digits, underscores). "
        + "Reordering moves the wires with their fields."));
    const list = el("div", {
        display: "flex", flexDirection: "column", gap: "2px",
        overflowY: "auto", padding: "4px 2px",
    });
    panel.append(list);

    function draw() {
        list.replaceChildren();
        rows.forEach((row, index) => {
            const shell = rowShell();
            shell.append(...moveButtons(rows, index, draw));
            const box = textBox(row.name, "field name",
                                (v) => { row.name = v; }, "180px");
            shell.append(box);
            shell.append(el("span", { color: DIM, font: "12px sans-serif",
                                      overflow: "hidden",
                                      textOverflow: "ellipsis" },
                            "from " + row.origin));
            list.appendChild(shell);
        });
    }
    draw();

    footerOf(panel, close, () => {
        const names = rows.map(
            (r) => String(r.name ?? "").trim().toLowerCase()
                .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""));
        if (names.some((n) => !n)) return "Every field needs a name.";
        if (new Set(names).size !== names.length) {
            return "Names must be unique.";
        }
        // Physical reorder IS the store: node.inputs (with its links) is
        // serialized in the workflow, and the server packs in_i as line
        // i -- so splicing the occupied slots into the chosen order and
        // renumbering persists by itself. Only renames need properties.
        const chosen = rows.map((r) => r.slot);
        const positions = occupied.map((x) => x.index);
        positions.forEach((inputIndex, i) => {
            node.inputs[inputIndex] = chosen[i];
        });
        (node.inputs ?? []).filter((s) => re.test(s.name))
            .forEach((slot, i) => { slot.name = `in_${i + 1}`; });
        repointLinks(node);
        // Renames keyed by what the wire DERIVES, so they survive the
        // sync re-deriving names -- and degrade to the derived name if
        // the wire changes. Written before resync so the very next sync
        // paints the new names.
        //
        // Derived AFTER the move, not read off the slots: derivation
        // de-duplicates by position ("value", "value_2", "value_3"), so
        // the name a slot carried before the move is not the name the
        // sync will give its new position. Keying by the stale one left
        // the wires swapped and the labels where they were -- the
        // dialog then reopened showing the old order over moved wires.
        const fresh = derivedFor(node);
        const renames = {};
        rows.forEach((row, i) => {
            const derived = fresh[i];
            if (derived && names[i] !== derived) {
                renames[derived] = names[i];
            }
        });
        saveLayout(node, { ...layoutOf(node), renames });
        node.graph?.setDirtyCanvas(true, true);
        notifyVue(node);
        resyncGraph(node);
        return null;
    });
    document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------
// The way in: a small ⚙ row on the node, plus right-click and
// double-click (wired in obvpm_dynamic.js, which knows the node types).
// ---------------------------------------------------------------------

export function addConfigButton(node, open, before = []) {
    if (node.__obvpmCfgBtn) return;      // reload re-runs onNodeCreated
    const container = el("div", {
        display: "flex", alignItems: "center", justifyContent: "center",
        overflow: "visible", gap: "2px",
    });
    // Other controls that share the row (the fold button) go to the left
    // of the gear, which stays the rightmost.
    for (const extra of before) container.appendChild(extra);
    const b = el("button", {
        background: "transparent", border: "none", cursor: "pointer",
        color: "inherit", font: "12px/16px sans-serif", padding: "0 4px",
        opacity: "0.7",
    }, "⚙");
    b.title = "Configure…";
    b.addEventListener("mouseenter", () => { b.style.opacity = "1"; });
    b.addEventListener("mouseleave", () => { b.style.opacity = "0.7"; });
    b.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        open(node);
    });
    container.appendChild(b);

    // A tighter margin than the DOM-widget default (10): this row sits
    // on a compact, socket-sized node, and the default would more than
    // double its height. `margin` is honored by both renderers
    // (domWidget.ts onDraw and DomWidgets.vue read widget.margin).
    const MARGIN = 3;
    const CONTENT = 16;
    const w = node.addDOMWidget("obvpm_cfg", "div", container,
                                { hideOnZoom: false, margin: MARGIN });
    w.serialize = false;
    w.options.serialize = false;
    const h = CONTENT + 2 * MARGIN;
    w.computeLayoutSize = () => ({ minHeight: h, maxHeight: h,
                                   minWidth: 0 });
    // The frozen-width guard every DOM widget in this pack carries.
    Object.defineProperty(w, "width", {
        configurable: true, get: () => undefined, set: () => {},
    });
    // A widget grows an input socket; this one means nothing on a wire.
    const at = (node.inputs ?? []).findIndex(
        (slot) => slot.widget && (slot.widget.name === "obvpm_cfg"
                                  || slot.name === "obvpm_cfg"));
    if (at >= 0 && node.inputs[at].link == null) {
        node.inputs.splice(at, 1);
        repointLinks(node);
    }
    node.__obvpmCfgBtn = w;
}
