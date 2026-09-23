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
export function openOverlay(width, onClose) {
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
        onClose?.();
    }
    function onKey(ev) {
        if (ev.key !== "Escape") return;
        ev.stopPropagation();
        // A popup opened INSIDE this dialog (a type picker, a text
        // editor) goes first, one per press: it is marked with
        // data-obvpm-pop and sits in the overlay above the panel. Only
        // with none open does Escape close the dialog itself.
        const pops = overlay.querySelectorAll(":scope > [data-obvpm-pop]");
        if (pops.length) {
            pops[pops.length - 1].remove();
            return;
        }
        close();
    }
    overlay.addEventListener("mousedown", (ev) => {
        if (ev.target === overlay) close();
    });
    document.addEventListener("keydown", onKey, true);

    return { overlay, panel, close };
}

// ---------------------------------------------------------------------------
// Custom canvas widgets under Nodes 2.0
// ---------------------------------------------------------------------------

/**
 * The box a custom widget's draw() should use under Nodes 2.0, with
 * the canvas fixed to match: [width, height].
 *
 * Nodes 2.0 paints a custom widget through its WidgetLegacy component,
 * into a canvas of the widget's own. That canvas is sized from
 * getBoundingClientRect().width -- the width AFTER the graph's zoom
 * transform -- while the element is laid out at the node's own width
 * (frontend 1.53). Zoomed out to 50%, the backing store is half as
 * wide as the element it is stretched over, so everything drawn comes
 * out twice as big, and the element's height stretches with it and
 * overflows the slot the node gave it. Zoomed in, the reverse: tiny.
 * Not a pixel-ratio matter (the component uses a fixed 2x), which is
 * why one machine at one zoom looks fine and another does not.
 *
 * So: give the backing store the layout width at the same pixel ratio
 * the component chose, restore the plain ratio transform, and draw at
 * the layout width. The element's CSS height then follows from the
 * backing store's proportions, exactly the box's height. (Scaling the
 * context instead, with the store left as it was, stretches everything
 * vertically: the store's height was never zoomed, only its width.)
 * The pointer events the component hands back are in layout pixels
 * (offsetX), so this also puts hit-testing back where the drawing is.
 *
 * `fill`: take the slot's full height. The card stretches the last
 * widget's row to the node's stored height, but the component only
 * ever asks the widget for its minimum, so an editor that fills the
 * node in classic mode sat at 240px over a band of nothing. The
 * canvas is absolute inside the component's wrapper, so the wrapper's
 * height is the row's, not ours -- no feedback. It does mean the row
 * can change under us without the canvas changing size -- the card's
 * footer lays out AFTER the first draw and takes its band back -- and
 * the component's own resize observer watches the canvas, so nothing
 * would redraw and the editor sat over the pack badge until a resize.
 * `redraw` is called when the wrapper's height moves.
 *
 * Outside Nodes 2.0, or when nothing differs, [width, height] as given.
 */
export function legacyCanvasBox(ctx, width, height, fill, redraw) {
    const canvas = ctx?.canvas;
    if (!(typeof LiteGraph !== "undefined" && LiteGraph.vueNodesMode)) {
        return [width, height];
    }
    const wrapper = canvas?.parentElement;
    if (!wrapper || !wrapper.style?.minHeight) {
        return [width, height];         // not WidgetLegacy's canvas
    }
    const layoutW = canvas.offsetWidth || wrapper.clientWidth;
    if (!(layoutW > 0) || !(width > 0)) return [width, height];
    let boxH = height;
    if (fill && height > 0) {
        boxH = Math.max(height, Math.floor(wrapper.clientHeight) - 2);
        if (redraw && !wrapper.__obvpmRowWatch
                && typeof ResizeObserver !== "undefined") {
            let last = wrapper.clientHeight;
            const watch = new ResizeObserver(() => {
                if (wrapper.clientHeight === last) return;
                last = wrapper.clientHeight;
                redraw();
            });
            watch.observe(wrapper);
            wrapper.__obvpmRowWatch = watch;
        }
    }
    if (Math.abs(layoutW - width) < 1 && boxH === height) return [width, height];
    // the component's pixel ratio, read off what it just allocated
    const ratio = canvas.width / width || 2;
    canvas.width = Math.round(layoutW * ratio);
    if (boxH > 0) canvas.height = Math.round((boxH + 2) * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return [layoutW, boxH];
}

// ---------------------------------------------------------------------------
// In-page stand-ins for window.prompt / window.confirm / window.alert
//
// NEVER the native ones. ComfyUI Desktop is an Electron app, and
// Electron does not implement window.prompt at all -- the call returns
// at once with nothing and no dialog, which read as "save as preset
// does nothing" (issue #11); confirm and alert are at the host's mercy
// too (and a native dialog also steals keyboard focus from the page,
// which is where the "inputs stop responding afterwards" came from).
// These are ordinary elements on the same overlay every other dialog in
// the pack uses, so they work wherever the page does. They resolve
// rather than block: Escape and a click outside answer null / false.
// ---------------------------------------------------------------------------

function dialog(title, body, buttons, onDismiss) {
    const { overlay, panel, close } = openOverlay("min(440px, 92vw)", onDismiss);
    if (title) panel.appendChild(el("div", { font: TITLE }, title));
    if (body) panel.appendChild(body);
    const row = el("div", { display: "flex", gap: "6px",
                            justifyContent: "flex-end", paddingTop: "4px" });
    row.append(...buttons);
    panel.appendChild(row);
    document.body.appendChild(overlay);
    return close;
}

/** window.prompt: resolves the text entered, or null when dismissed. */
export function askText(title, { value, placeholder, ok } = {}) {
    return new Promise((resolve) => {
        let answered = false;
        const settle = (v) => { if (!answered) { answered = true; resolve(v); } };
        let text = value ?? "";
        const box = textBox(text, placeholder ?? "", (v) => { text = v; }, "100%");
        const accept = () => { settle(text); close(); };
        box.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") { ev.preventDefault(); accept(); }
        });
        const close = dialog(title, box, [
            pushButton("Cancel", () => { settle(null); close(); }),
            pushButton(ok ?? "OK", accept, { fontWeight: "600" }),
        ], () => settle(null));
        box.focus();
        box.select();
    });
}

/** window.confirm: resolves true on the confirming button, else false. */
export function askConfirm(message, { title, ok } = {}) {
    return new Promise((resolve) => {
        let answered = false;
        const settle = (v) => { if (!answered) { answered = true; resolve(v); } };
        const body = el("div", { whiteSpace: "pre-wrap" }, message);
        const close = dialog(title ?? "", body, [
            pushButton("Cancel", () => { settle(false); close(); }),
            pushButton(ok ?? "OK", () => { settle(true); close(); },
                       { fontWeight: "600" }),
        ], () => settle(false));
    });
}

/** window.alert: resolves when dismissed. */
export function notice(message, title) {
    return new Promise((resolve) => {
        let answered = false;
        const settle = () => { if (!answered) { answered = true; resolve(); } };
        const body = el("div", { whiteSpace: "pre-wrap" }, message);
        const close = dialog(title ?? "", body, [
            pushButton("OK", () => { settle(); close(); }, { fontWeight: "600" }),
        ], settle);
    });
}

// ---------------------------------------------------------------------------
// Hover text for a widget whose value is drawn cut off
// ---------------------------------------------------------------------------

// litegraph's BaseWidget layout constants (margin, label/value gap), and the
// padding its truncating text routine uses: stepped widgets (combo, number)
// keep 5 px left and 20 px right for the arrows; text widgets use none.
const WIDGET_MARGIN = 15;
const LABEL_VALUE_GAP = 5;
let measureContext = null;

/** Width of widget text in the canvas's widget font (node inner font). */
export function widgetTextWidth(text) {
    try {
        measureContext ??= document.createElement("canvas").getContext("2d");
        const lg = typeof LiteGraph !== "undefined" ? LiteGraph : {};
        measureContext.font =
            `normal ${lg.NODE_SUBTEXT_SIZE ?? 14}px ${lg.NODE_FONT ?? "Arial"}`;
        return measureContext.measureText(String(text)).width;
    } catch {
        return String(text).length * 7;
    }
}

/**
 * Whether the widget's value is drawn truncated at this node width, by the
 * same arithmetic as litegraph's drawTruncatingText: the value is cut when
 * label + gap + value overflow the text area and the active truncation mode
 * shortens the value (the default mode shortens the label first, so there
 * the value is only cut when it alone is wider than the area).
 */
export function isWidgetValueCutOff(widget, nodeWidth, measure = widgetTextWidth,
                                    flags = typeof LiteGraph !== "undefined" ? LiteGraph : {}) {
    if (!widget || widget.type === "toggle" || widget.type === "boolean") return false;
    const value = String(widget._displayValue ?? widget.value ?? "");
    if (!value || !(nodeWidth > 0)) return false;
    const stepped = widget.type === "combo" || widget.type === "number";
    const left = stepped ? 5 : 0;
    const right = stepped ? 20 : 0;
    const area = nodeWidth - (WIDGET_MARGIN * 2 + left) - 2 * WIDGET_MARGIN - right;
    const label = String(widget.displayName ?? widget.label ?? widget.name ?? "");
    const labelWidth = measure(label);
    const valueWidth = measure(value);
    if (labelWidth + LABEL_VALUE_GAP + valueWidth <= area) return false;
    if (flags.truncateWidgetTextEvenly || flags.truncateWidgetValuesFirst) return true;
    return valueWidth > area;
}

/**
 * A widget's tooltip: its full value when that value is drawn cut off,
 * followed by `baseTip` (the widget's usual tooltip) when there is one.
 */
export function valueTooltip(widget, nodeWidth, baseTip, measure, flags) {
    if (!isWidgetValueCutOff(widget, nodeWidth, measure, flags)) return baseTip;
    const full = String(widget.value ?? "");
    return baseTip ? full + "\n\n" + baseTip : full;
}
