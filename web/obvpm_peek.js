import { app } from "../../scripts/app.js";

// Peek Bundle draws its report on the node.
//
// A CANVAS widget, not a DOM one. The report is drawn content, not media
// playback, which is the decision rule in the widget gotchas (§1) -- and
// it means the two sizing shields below are available, which the DOM path
// forbids (§2b: never mix their fixes). Both are copied from the crop
// editor, where they were debugged the hard way:
//
//  * computedHeight reports a box 15px SHORTER than the one drawn, so the
//    node's resize corner is not swallowed by a widget that fills the
//    body. Litegraph checks widgets BEFORE the resize corner in both the
//    hover and pointerdown paths, so without this the node cannot be
//    dragged bigger at all -- which reads as a frozen size.
//  * width defers to the node, because litegraph draws and hit-tests with
//    `widget.width || node.size[0]` and a width left on the widget by
//    anything else silently shrinks both.

const PLACEHOLDER = "(run the workflow to see what is on the wire)";
const RESIZE_ZONE = 15;      // LGraphNode.resizeHandleSize
const MIN_REPORT_H = 48;
const PAD = 8;
const LINE = 15;

const isVueMode = () =>
    typeof LiteGraph !== "undefined" && !!LiteGraph.vueNodesMode;

function addReport(node) {
    if (node.__obvpmPeek) return node.__obvpmPeek;

    // The real allocation, kept in a closure: computedHeight below reports
    // a shorter box to the hit test, and drawing must use the true one.
    let allocHeight;
    const state = { lines: [PLACEHOLDER], scroll: 0 };

    // This widget is the node's last, so the node's own height is the
    // truth -- deriving from it means a stale allocation can never leave
    // the report drawn at the wrong size.
    function boxHeight(widget, widgetY, fallback) {
        if (isVueMode()) return fallback;
        const nodeH = node.size?.[1];
        const visible = node.widgets?.filter((w) => !w.hidden);
        const isLast = !!visible && visible[visible.length - 1] === widget;
        if (nodeH == null || widgetY == null || !isLast) return fallback;
        return Math.max(MIN_REPORT_H, nodeH - widgetY);
    }

    const widget = {
        name: "report",
        type: "obvpm_peek_report",
        value: "",
        serialize: false,
        options: { serialize: false },

        // No computeSize: computeLayoutSize makes it growable, and
        // maxHeight is what gives distributeSpace a range to hand it.
        // Without that it sits at its minimum however tall the node gets.
        computeLayoutSize() {
            const wanted = state.lines.length * LINE + PAD * 2;
            if (isVueMode()) {
                const h = Math.max(MIN_REPORT_H, wanted);
                return { minHeight: h, maxHeight: h, minWidth: 0 };
            }
            return { minHeight: MIN_REPORT_H, maxHeight: 100000, minWidth: 0 };
        },

        draw(ctx, _node, width, y, H) {
            const box = boxHeight(this, y, allocHeight ?? H);
            const w = (width || node.size[0]) - PAD * 2;
            ctx.save();
            ctx.beginPath();
            ctx.roundRect?.(PAD, y, w, box - 4, 6);
            ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
            if (ctx.roundRect) ctx.fill();
            ctx.clip?.();
            ctx.font = "12px ui-monospace, Consolas, monospace";
            ctx.textBaseline = "top";
            ctx.fillStyle = LiteGraph?.NODE_TEXT_COLOR ?? "#ddd";
            const room = Math.max(0, Math.floor((box - PAD * 2) / LINE));
            for (let i = 0; i < Math.min(room, state.lines.length); i++) {
                ctx.fillText(state.lines[i], PAD * 2, y + PAD + i * LINE);
            }
            const hidden = state.lines.length - room;
            if (hidden > 0 && room > 0) {
                ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
                ctx.fillText(`… ${hidden} more (drag the node taller)`,
                             PAD * 2, y + PAD + (room - 1) * LINE);
            }
            ctx.restore();
        },
    };

    node.addCustomWidget(widget);

    Object.defineProperty(widget, "computedHeight", {
        configurable: true,
        get() {
            if (isVueMode() || allocHeight == null) return undefined;
            // No lower clamp: a floor could report MORE than the box at
            // minimum node size, pushing the hit rect past the bottom edge.
            return Math.max(0, boxHeight(this, this.y, allocHeight) - RESIZE_ZONE);
        },
        set(v) { allocHeight = v; },
    });
    Object.defineProperty(widget, "width", {
        configurable: true,
        get: () => undefined,
        set: () => {},
    });

    node.__obvpmPeek = { widget, state };
    return node.__obvpmPeek;
}

function showReport(node, text) {
    const peek = addReport(node);
    peek.state.lines = String(text || PLACEHOLDER).split("\n");
    // Kept on the node so a workflow reopened tomorrow still shows what
    // the last run put on the wire.
    node.properties ??= {};
    node.properties.obvpm_peek_report = text ?? "";
    node.graph?.setDirtyCanvas(true, true);
    // Nodes 2.0 paints a custom widget through WidgetLegacy, into a
    // canvas of its own that a dirty flag on the graph never reaches. It
    // repaints on the triggerDraw it installs on the widget (and on the
    // widget's callback, which a report has no reason to fire), so a
    // report that only ever changes closure state has to ask. Also what
    // re-reads computeLayoutSize, so the box grows to the new lines.
    peek.widget.triggerDraw?.();
}

app.registerExtension({
    name: "obvpm.peek",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PeekBundle (obvpm)") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            try {
                addReport(this);
            } catch (err) {
                console.error("[obvpm-peek] could not add the report:", err);
            }
            return result;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const result = onExecuted?.apply(this, arguments);
            try {
                const text = Array.isArray(message?.text)
                    ? message.text.join("\n")
                    : String(message?.text ?? "");
                showReport(this, text);
            } catch (err) {
                console.error("[obvpm-peek] could not show the report:", err);
            }
            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = onConfigure?.apply(this, arguments);
            setTimeout(() => {
                try {
                    const saved = this.properties?.obvpm_peek_report;
                    if (saved) showReport(this, saved);
                } catch (err) {
                    console.error("[obvpm-peek] restore failed:", err);
                }
            }, 0);
            return result;
        };
    },
});
