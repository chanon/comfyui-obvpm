// Collapsing for the compact (title-less) nodes: Bundle and Unbundle.
//
// A collapsed litegraph node is its title bar and nothing else -- one row,
// every link gathered to a dot at each end. The compact nodes have no
// title bar (`title_mode = NO_TITLE`), and collapsing one as it stands is
// broken in both renderers: the classic canvas measures the collapsed box
// BELOW the node's origin while the links and the collapse dot sit ABOVE
// it (the title row is where they live), and Nodes 2.0 omits the header
// for NO_TITLE, so a collapsed node shows nothing at all.
//
// So a folded node gets its title back, for as long as it is folded. The
// per-instance `title_mode` override shadows the prototype getter, which
// every consumer reads dynamically; both renderers then draw the ordinary
// collapsed node, with the ordinary expand control -- the dot at the left
// in the canvas, the chevron in Nodes 2.0 -- and the links land where
// they are drawn. Expanding is that control, or a double-click on the
// bar. Unfolded, the override goes and the node is title-less again.
//
// The way in is a button on the node's ⚙ row (foldButton). Every other
// path -- the canvas dot, the Vue chevron, the context menu, Alt+C --
// calls `node.collapse()`, so that is wrapped on the instance and the
// title follows the flag whichever way it was flipped. A workflow that
// loads with the flag already set is caught by `syncFold`, which the
// node's sync calls every time.
//
// No import of the app: this file is plain logic and runs under node for
// its tests.

const NORMAL_TITLE = 0;    // TitleMode.NORMAL_TITLE
const TITLE_HEIGHT = 30;   // LiteGraph.NODE_TITLE_HEIGHT

export function isFolded(node) {
    return !!node?.flags?.collapsed;
}

/**
 * Make the title follow the collapsed flag. Idempotent, cheap, safe to
 * call on every sync.
 */
export function syncFold(node) {
    const has = Object.prototype.hasOwnProperty.call(node, "title_mode");
    if (isFolded(node) && !has) {
        Object.defineProperty(node, "title_mode", {
            configurable: true, enumerable: false,
            get: () => NORMAL_TITLE,
        });
        // No text on the bar: the collapsed width is measured from
        // `getTitle()` (min(size, text + 60)), and on a node as narrow
        // as these the display name would run past the end. Empty, the
        // bar is a plain 60-wide pill; `title` itself is untouched, so
        // nothing changes in the saved workflow.
        Object.defineProperty(node, "getTitle", {
            configurable: true, enumerable: false, writable: true,
            value: () => "",
        });
        return true;
    }
    if (!isFolded(node) && has) {
        delete node.title_mode;      // back to the constructor's NO_TITLE
        delete node.getTitle;
        return true;
    }
    return false;
}

/**
 * Wire folding onto one node. `onChange(node)` runs after every fold or
 * unfold so the caller can refit and tell Nodes 2.0. `shiftOrigin()`
 * says whether folding should move the origin by a title row (true on
 * the classic canvas, where a title-less node's body starts AT the
 * origin; false in Nodes 2.0, whose element top is a title row above
 * the origin whether or not there is a header, so nothing moves there).
 */
export function installFold(node, onChange, shiftOrigin = () => true) {
    if (node.__obvpmFold) return;
    node.__obvpmFold = true;

    // `collapsible` is a prototype getter reading the constructor's
    // `collapsable`, which the compact nodes set false (a title-less
    // node's native toggle box used to land on the first pin). The
    // instance says otherwise, so the context menu offers Collapse and
    // the dot / chevron work; the box itself is unreachable on a
    // title-less node in this frontend (it lies outside the hitbox).
    Object.defineProperty(node, "collapsible", {
        configurable: true, get: () => !node.pinned,
    });

    const collapse = node.collapse;
    node.collapse = function () {
        // Force: the prototype consults `collapsible` and the override
        // above already answered that; and a pinned node stays put.
        if (this.pinned) return;
        collapse.call(this, true);
        syncFold(this);
        // A node's origin is the top of its BODY; the title row hangs
        // above it. Unfolded, this node has no title row, so its top edge
        // is the origin; folded, it is a title row and nothing else, so
        // its top edge is one title height above. Moving the origin the
        // other way keeps the bar where the node's top was, instead of
        // the node jumping up a row on every fold. The saved position
        // carries whichever state was saved, consistently.
        if (this.pos && shiftOrigin()) {
            this.pos[1] += isFolded(this) ? TITLE_HEIGHT : -TITLE_HEIGHT;
        }
        onChange?.(this);
    };

    // Double-click on the folded bar expands it; unfolded, the node's
    // own double-click (the config dialog) is untouched.
    const onDblClick = node.onDblClick;
    node.onDblClick = function () {
        if (isFolded(this)) {
            this.collapse();
            return true;
        }
        return onDblClick?.apply(this, arguments);
    };

    syncFold(node);
}

/**
 * The fold button for the ⚙ row. `el(tag, style, text)` is the UI kit's
 * element helper, passed in so this file needs no DOM of its own.
 */
export function foldButton(node, el) {
    const b = el("button", {
        background: "transparent", border: "none", cursor: "pointer",
        color: "inherit", font: "12px/16px sans-serif", padding: "0 4px",
        opacity: "0.7",
    }, "−");
    b.title = "Collapse";
    b.addEventListener("mouseenter", () => { b.style.opacity = "1"; });
    b.addEventListener("mouseleave", () => { b.style.opacity = "0.7"; });
    b.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!isFolded(node)) node.collapse();
    });
    return b;
}
