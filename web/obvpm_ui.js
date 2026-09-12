// The pack's UI kit: element helpers, the shared type and palette
// constants, the modal scaffold, the theme palette that node chrome
// wears, and the widget-socket fix. One implementation, imported by
// every dialog and editor (Value Presets, the bundle config, Load
// Images & Compose) -- sizes and colors typed in ten spots drift the
// first time one of them is adjusted.
//
// The companion pack comfyui-obvpm-timeline carries its own copy of the
// palette and socket helpers inside h3_mctx_ui.js: the two packs never
// import across /extensions/ so either can be installed alone.

/**
 * Hiding a widget leaves its input socket behind -- invisible, still
 * hit-tested, and ready to take a wire aimed at nothing. Remove those
 * sockets (only when unlinked) and renumber the links of the rest.
 */
export function dropWidgetSockets(node, names) {
    for (const name of names) {
        const at = (node.inputs ?? []).findIndex(
            (slot) => slot.widget && (slot.widget.name === name
                                      || slot.name === name));
        if (at < 0 || node.inputs[at].link != null) continue;
        node.removeInput(at);
    }
    // graph.links is an object at the root and a Map inside a subgraph,
    // so it cannot simply be bracket-indexed.
    const links = node.graph?.links;
    (node.inputs ?? []).forEach((slot, index) => {
        if (!links || slot.link == null) return;
        const link = typeof links.get === "function"
            ? links.get(slot.link) : links[slot.link];
        if (link) link.target_slot = index;
    });
}

function cssVar(name, fallback) {
    try {
        const v = getComputedStyle(document.documentElement)
            .getPropertyValue(name).trim();
        return v || fallback;
    } catch {
        return fallback;
    }
}

// darken a CSS color by scaling its channels; plain rgb()/rgba() out so
// every engine applies it (fancy color functions get silently rejected
// by older CSSOMs, which leaves the property unset entirely)
function darken(color, f, off) {
    let r, g, b, a = null;
    let m = color.match(/^#([0-9a-f]{3})$/i);
    if (m) {
        [r, g, b] = [...m[1]].map((c) => parseInt(c + c, 16));
    } else if ((m = color.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i))) {
        r = parseInt(m[1].slice(0, 2), 16);
        g = parseInt(m[1].slice(2, 4), 16);
        b = parseInt(m[1].slice(4, 6), 16);
        if (m[2]) a = parseInt(m[2], 16) / 255;
    } else if ((m = color.match(/^rgba?\(([^)]+)\)$/i))) {
        const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
        [r, g, b] = parts;
        if (parts.length > 3) a = parts[3];
        if ([r, g, b].some((x) => !Number.isFinite(x))) return color;
    } else {
        return color; // unknown notation: leave untouched
    }
    const sc = (x) =>
        Math.round(Math.max(0, Math.min(255, x * f + (off || 0))));
    return a === null
        ? `rgb(${sc(r)}, ${sc(g)}, ${sc(b)})`
        : `rgba(${sc(r)}, ${sc(g)}, ${sc(b)}, ${a})`;
}

function alpha(color, a) {
    const c = darken(color, 1, 0); // normalizes to rgb()/rgba()
    const m = c.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${a})` : c;
}

/**
 * The palette node chrome wears (buttons, pills, pickers): dark chrome
 * with light text in BOTH themes, tuned per ground -- lighter on a light
 * page, darker on a dark one. `restRgb` is `rest` resolved to a real
 * color, because a canvas fillStyle cannot read a var() string (it
 * silently keeps the previous fill).
 */
export function themePalette() {
    let light = false;
    try {
        const bg = getComputedStyle(document.body)
            .backgroundColor.match(/\d+/g);
        if (bg) {
            const [r, g, b] = bg.map(Number);
            light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 128;
        }
    } catch { /* default dark */ }
    if (light) {
        // surfaces follow the palette's input color, with dark ink and
        // darker mixes for edges/panel
        const lb = "var(--comfy-input-bg, #dfe2e8)";
        return {
            light: true,
            rest: lb, text: "#23262b", sub: "#5c6270",
            restRgb: cssVar("--comfy-input-bg", "#dfe2e8"),
            active: "#3557b0", activeText: "#f2f4f8",
            edge: darken(cssVar("--comfy-input-bg", "#dfe2e8"), 0.76),
            tick: "#6a707a", tickLine: "#b6bac3",
            // the theme's own panel color, not a black-mix (mixing black
            // into a light color makes mud, not shade)
            stripBg: alpha(cssVar("--comfy-input-bg", "#dfe2e8"), 0.25),
            drop: "#454b55",
        };
    }
    // dark: surfaces follow the theme's input color; the derived shades
    // (edge/panel) are computed in JS at palette time, not with CSS
    // color functions
    const base = "var(--comfy-input-bg, #17191f)";
    return {
        light: false,
        rest: base, text: "#e8eaee", sub: "#9aa1ac",
        restRgb: cssVar("--comfy-input-bg", "#17191f"),
        active: "#1f4390", activeText: "#e8eaee",
        // Darker than the ground, not lighter: the outline reads as a
        // seam between surfaces rather than a drawn line. 0.6x is the
        // middle of that direction's range -- 0.3x read nearly black, 1x
        // vanishes (user-tuned 2026-08-20).
        edge: darken(cssVar("--comfy-input-bg", "#17191f"), 0.6),
        tick: "#9aa1ac", tickLine: "#3a3f48",
        // the surface at quarter opacity; the node body blends through
        stripBg: alpha(cssVar("--comfy-input-bg", "#17191f"), 0.25),
        drop: "#d7dbe2",
    };
}

export function el(tag, style, text) {
    const node = document.createElement(tag);
    if (style) Object.assign(node.style, style);
    // textContent, never innerHTML: everything shown here arrives inside
    // shared workflows and inside every take this pack writes, so its
    // text is data from elsewhere and is never markup.
    if (text != null) node.textContent = String(text);
    return node;
}

export const TEXT = "14px sans-serif";
export const TITLE = "600 16px sans-serif";

export const INK = "var(--fg-color, #ddd)";
export const DIM = "var(--descrip-text, #999)";
export const EDGE = "var(--border-color, #444)";
export const FILL = "var(--comfy-input-bg, #222)";
export const PANEL = "var(--comfy-menu-bg, #353535)";

export function textBox(value, placeholder, onInput, width) {
    const box = el("input", {
        background: FILL, color: INK, border: "1px solid " + EDGE,
        borderRadius: "4px", padding: "4px 8px", font: TEXT,
        width: width || "auto", minWidth: "0", boxSizing: "border-box",
    });
    box.type = "text";
    box.value = value ?? "";
    box.placeholder = placeholder ?? "";
    box.addEventListener("input", () => onInput(box.value));
    return box;
}

export function pushButton(label, onClick, style) {
    const b = el("button", {
        background: FILL, color: INK, border: "1px solid " + EDGE,
        borderRadius: "4px", padding: "4px 12px", cursor: "pointer",
        font: TEXT, whiteSpace: "nowrap",
        ...(style ?? {}),
    }, label);
    b.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onClick();
    });
    return b;
}

/**
 * The modal scaffold: dimmed overlay, centred panel, and the two ways
 * out everyone expects (Escape, click outside). Returns the parts;
 * the caller fills `panel`, then attaches with `overlay` (or just
 * `document.body.appendChild(overlay)`).
 *
 * Escape is captured (`true`) so the canvas underneath never sees it --
 * litegraph binds keys at the document level too.
 */
export function openOverlay(width) {
    const overlay = el("div", {
        position: "fixed", inset: "0", background: "rgba(0,0,0,0.55)",
        zIndex: "10000", display: "flex", alignItems: "center",
        justifyContent: "center",
    });
    const panel = el("div", {
        background: PANEL, color: INK, border: "1px solid " + EDGE,
        borderRadius: "8px", padding: "16px",
        width: width ?? "min(900px, 94vw)",
        maxHeight: "86vh", display: "flex", flexDirection: "column",
        gap: "10px", font: TEXT,
        boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
    });
    overlay.appendChild(panel);

    function close() {
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
    }
    function onKey(ev) {
        if (ev.key === "Escape") {
            ev.stopPropagation();
            close();
        }
    }
    overlay.addEventListener("mousedown", (ev) => {
        if (ev.target === overlay) close();
    });
    document.addEventListener("keydown", onKey, true);

    return { overlay, panel, close };
}
