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

/**
 * A DOM panel on a node: fills the node's height, scrolls inside it,
 * and never dictates it -- THE recipe for any DOM widget whose content
 * can be long (a report, a list, a log). Both renderers, one call.
 *
 * Why each part is there (each one was a live bug first):
 *
 * - `computeLayoutSize` with a `maxHeight`: in classic mode the node's
 *   spare height is handed to widgets by distributeSpace, and only to
 *   those that name a range -- without maxHeight the panel sits at its
 *   minimum however tall the node is dragged (Peek Bundle, 2026-09).
 *   In Nodes 2.0 the same method is what makes the widget's grid row
 *   `auto` (WidgetGrid.vue) so it can stretch; a widget without it gets
 *   a `min-content` row and a `flex: 1` grid it can't use.
 * - `contain: size` on the element: Nodes 2.0 clamps a node's height to
 *   the card's MEASURED content height (useNodeResize probes it with
 *   --node-height: 0), so an element sized by its content is a floor
 *   the node can't go under -- the width then can't be changed without
 *   the height snapping back, and nothing ever scrolls because nothing
 *   is bounded (Compatibility Check, 2026-09-24). With size containment
 *   the content contributes NOTHING to that measure; the row stretches
 *   to whatever height the node has, and the panel scrolls inside it.
 *   `min-height` is the only floor left, so it is the node's floor too.
 * - `overflow: auto` (both axes) + `box-sizing: border-box`: the
 *   scrolling itself, and padding counted inside the bounded box. Size
 *   containment zeroes the intrinsic WIDTH too, so the panel never
 *   widens the node: a node narrower than a line scrolls sideways.
 *   Keep `minWidth` at 0 unless the content is unreadable below some
 *   width -- a minWidth becomes the node's floor in classic mode
 *   (computeSize adds it), and Nodes 2.0 has its own 225 px floor.
 * - `width` neutralised: a DOM widget that reports a width pins the
 *   node's minimum width to the panel's last layout, so the node can't
 *   be made narrower afterwards.
 * - `serialize: false` twice: both places the two renderers read it.
 *
 * GROWING TO FIT: call the returned widget's `fitToContent()` after the
 * content changes. Never hand-roll it -- every hand-rolled version so far
 * broke the same way (see fitPanel below). Do NOT size the panel from
 * its scrollHeight on every repaint either: the user's resize is theirs.
 */
export function addPanelWidget(node, name, element,
                               { minHeight = 120, minWidth = 0, scroller = null } = {}) {
    Object.assign(element.style, {
        contain: "size",
        minHeight: minHeight + "px",
        overflow: "auto",
        boxSizing: "border-box",
    });
    // `scroller`: a child that scrolls instead of the whole panel, so
    // what sits beside it (a button row) stays put. The panel becomes a
    // column that clips; the scroller takes the height that is left.
    // min-height 0, or a flex child refuses to shrink below its content
    // and nothing scrolls again.
    if (scroller && scroller !== element) {
        Object.assign(element.style, {
            overflow: "hidden", display: "flex", flexDirection: "column",
        });
        Object.assign(scroller.style, {
            flex: "1 1 auto", minHeight: "0", overflow: "auto",
        });
    }
    hookPanelWheel(element, scroller ?? element);
    const w = node.addDOMWidget(name, "div", element, { hideOnZoom: false });
    w.serialize = false;
    w.options.serialize = false;
    w.computeLayoutSize = () => ({ minHeight, maxHeight: 100000, minWidth });
    Object.defineProperty(w, "width", {
        configurable: true, get: () => undefined, set: () => {},
    });
    dropWidgetSockets(node, [name]);
    // A node configured from saved data (a workflow load, a paste, a
    // clone) carries its size with it: mark it before anything can
    // measure, so fitToContent leaves that size alone. On the instance,
    // ahead of the class's own onConfigure, which still runs.
    const configure = node.onConfigure;
    node.onConfigure = function (...args) {
        this.__obvpmSizeLoaded = true;
        return configure?.apply(this, args);
    };
    w.fitToContent = () => fitPanel(node, w, scroller ?? element);
    return w;
}

/** Grown to fit on its own no taller than this; past it, it scrolls. */
const FIT_LIMIT = 600;

/**
 * Grow a NEW node so its panel shows everything -- once, and never a
 * node whose size is the user's or the workflow's.
 *
 * Every hand-rolled "grow to fit" before this broke one of these rules
 * (the user, 2026-09-24: "we go through these bugs EVERY SINGLE NODE"):
 *
 * - A loaded node is never resized. Its size came with the workflow --
 *   the size the user dragged it to. A "height I set last" marker lives
 *   only in memory, so after a reload the node looks untouched; the
 *   Compatibility Check grew back every time it was dragged small and
 *   reloaded. Loaded = onConfigure ran (addPanelWidget marks it).
 * - By the MEASURED overflow (scrollHeight - clientHeight of the part
 *   that scrolls), never by an estimate plus a margin: the overflow is
 *   exactly what is missing and 0 when it fits, so running again adds
 *   nothing. The estimate added its margin on top of the current height
 *   on every run: +40 px per load in classic, +20 in Nodes 2.0.
 * - Only while the node has the height this code last gave it: once the
 *   user drags it, it is theirs, and the panel scrolls.
 * - Two frames at most (the first resize can re-wrap text the second
 *   then measures), and never past FIT_LIMIT.
 */
function fitPanel(node, w, scroller, tries = 2) {
    requestAnimationFrame(() => {
        if (!node.size || node.__obvpmSizeLoaded) return;
        if (w.__obvpmFitHeight != null && Math.abs(node.size[1] - w.__obvpmFitHeight) >= 1) return;
        const short = scroller.scrollHeight - scroller.clientHeight;
        if (short > 0 && node.size[1] < FIT_LIMIT) {
            node.setSize?.([node.size[0], Math.min(node.size[1] + short, FIT_LIMIT)]);
            node.setDirtyCanvas?.(true, true);
        }
        w.__obvpmFitHeight = node.size[1];
        if (short > 0 && tries > 1) fitPanel(node, w, scroller, tries - 1);
    });
}

/**
 * The wheel over a panel scrolls the panel, not the graph.
 *
 * The canvas takes the wheel for zoom/pan on the DOCUMENT in the capture
 * phase and consults no node and no widget, so a scrollable element on a
 * node never scrolls -- the graph zooms under it instead (Nodes 2.0,
 * Compatibility Check, 2026-09-24; the same fact bit the Compose node's
 * list on canvas, see compose_images.js). The only listener that runs
 * before it is another document capture listener registered earlier,
 * which this is (extensions load before the canvas is built). One
 * listener for every panel; it scrolls the panel itself and claims the
 * event -- also at the ends of the range, or scrolling past the last
 * line would suddenly zoom the graph. Ctrl+wheel is left alone: that is
 * zoom on purpose, panel or not.
 */
// panel -> the element in it that scrolls (the panel itself, or its
// `scroller`): a wheel anywhere over the panel, buttons included,
// scrolls that one and never the graph
const panels = new Map();
let panelWheelHooked = false;
function hookPanelWheel(element, scroller = element) {
    panels.set(element, scroller);
    if (panelWheelHooked || typeof document === "undefined") return;
    panelWheelHooked = true;
    document.addEventListener("wheel", (e) => {
        if (e.ctrlKey || e.metaKey) return;
        const target = e.target;
        if (!(target instanceof Node)) return;
        let panel = null;
        for (const [p, s] of panels) {
            if (p.isConnected && p.contains(target)) { panel = s; break; }
        }
        if (!panel) return;
        const canScroll = panel.scrollHeight > panel.clientHeight
            || panel.scrollWidth > panel.clientWidth;
        if (canScroll) {
            // deltaMode 1 = lines, 2 = pages; pixels otherwise
            const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? panel.clientHeight : 1;
            panel.scrollTop += e.deltaY * unit;
            panel.scrollLeft += e.deltaX * unit;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
    }, { capture: true, passive: false });
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
 *
 * ONE LAYER PER ESCAPE. Open overlays form a stack and only the top one
 * answers a key: a confirm opened over a dialog is its own overlay with
 * its own listener on the same document, and a listener registered
 * earlier runs first, so without the stack one press closed BOTH (the
 * dialog underneath went with the confirm). Inside an overlay, a pop
 * (`data-obvpm-pop`, closed through its `obvpmClose` if it has one) goes
 * before the dialog itself. `dismiss(close)`, when given, is what
 * Escape and a click outside do instead of closing outright -- a dialog
 * with an edit in progress backs out of the edit first.
 */
const overlayStack = [];

export function openOverlay(width, onClose, { dismiss } = {}) {
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

    let closed = false;
    function close() {
        if (closed) return;
        closed = true;
        document.removeEventListener("keydown", onKey, true);
        const at = overlayStack.indexOf(overlay);
        if (at >= 0) overlayStack.splice(at, 1);
        overlay.remove();
        onClose?.();
    }
    const leave = () => (dismiss ? dismiss(close) : close());
    function onKey(ev) {
        if (ev.key !== "Escape") return;
        // an overlay opened over this one answers its own Escape; this
        // one must not also act on the same press (see above)
        // (the last one still on the page: one taken off some other way
        // than close() must not keep the ones under it deaf)
        const live = overlayStack.filter((o) => o.isConnected);
        if (live[live.length - 1] !== overlay) return;
        ev.stopPropagation();
        ev.preventDefault();
        // A popup opened INSIDE this dialog (a type picker, a text
        // editor) goes first, one per press: it is marked with
        // data-obvpm-pop and sits in the overlay above the panel. Only
        // with none open does Escape reach the dialog itself.
        const pops = overlay.querySelectorAll(":scope > [data-obvpm-pop]");
        if (pops.length) {
            const pop = pops[pops.length - 1];
            if (typeof pop.obvpmClose === "function") pop.obvpmClose();
            else pop.remove();
            return;
        }
        leave();
    }
    overlay.addEventListener("mousedown", (ev) => {
        if (ev.target === overlay) leave();
    });
    overlayStack.push(overlay);
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
