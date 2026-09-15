import { MAX_LAYERS, MAX_FILE_BYTES, MAX_TOTAL_FILE_BYTES, parseLayers, checkFiles, boundedBlob, safePlanInputs } from "./obvpm_image_limits.js";
import { app } from "../../scripts/app.js";
// One implementation of the fixed-aspect geometry, shared with Load
// Image & Crop -- two editors disagreeing about the same stored crop is
// the bug this import prevents.
import { ASPECT_CHOICES, parseAspect, impliedAspectRect, ratioDragRect,
         snapRectToAspect } from "./obvpm_crop.js";
// The palette the Value Presets buttons wear -- the aspect pill is a
// button and should read as one.
import { themePalette } from "./obvpm_ui.js";
import { api } from "../../scripts/api.js";
// The Artius browser's payload shape is decoded in ONE place for the
// whole pack.
import {
    ARTIUS_MIME, ARTIUS_ROUTE_BASE, artiusRelativePath, readArtiusAssets,
} from "./obvpm_artius.js";

// Layer editor for Load Images & Compose.
//
// The node body is one canvas widget split in three: a vertical strip of
// layers down the left, a main view on the right, and an info line under
// both. The first entry in the strip is "Result" -- selecting it draws
// the composition the node will actually produce, at its real aspect,
// with every layer in its real slot. Selecting any other entry puts that
// layer's crop editor in the main view.
//
// Everything the node executes on lives in the hidden `layers` widget as
// JSON; this file is the only thing that writes it.
//
// The planner below is a LINE-FOR-LINE MIRROR of compose_layout.py --
// same candidates, same score, same tie-break, same rounding (which is
// why both sides use floor(x + 0.5) rather than their language's round).
// It exists so the preview shows the real layout rather than an
// impression of one. scratchpad/test_compose_plan.mjs runs both against
// the same random inputs and fails on any divergence; if you change one,
// change the other in the same commit.

const ALIGN = 16;
const TARGET_ASPECTS = {
    auto: null,
    "1:1": 1.0,
    "4:3": 4.0 / 3.0,
    "3:4": 3.0 / 4.0,
    "3:2": 3.0 / 2.0,
    "2:3": 2.0 / 3.0,
    "16:9": 16.0 / 9.0,
    "9:16": 9.0 / 16.0,
};
const EXHAUSTIVE_LIMIT = 12;
const MAX_ROWS = 24;
const BACKGROUNDS = { black: 0.0, grey: 0.5, white: 1.0 };
const SIZINGS = ["natural", "fill"];
const WASTE_WEIGHT = 2.0;
const EPS = 1e-9;
const PACK_ASPECT_MIN = 0.45;
const PACK_ASPECT_MAX = 2.2;
const PACK_WIDTH_STEPS = 48;
const PACK_ORDER_MARGIN = 0.03;

function compositions(n) {
    const out = [];
    for (let bits = 0; bits < (1 << (n - 1)); bits++) {
        const rows = [];
        let run = 1;
        for (let i = 0; i < n - 1; i++) {
            if (bits & (1 << i)) {
                rows.push(run);
                run = 1;
            } else {
                run += 1;
            }
        }
        rows.push(run);
        out.push(rows);
    }
    return out;
}

function balanced(aspects, rows) {
    const n = aspects.length;
    if (rows >= n) return new Array(n).fill(1);
    const prefix = [0];
    for (const a of aspects) prefix.push(prefix[prefix.length - 1] + a);
    const ideal = prefix[n] / rows;

    const inf = Infinity;
    const best = [];
    const cut = [];
    for (let i = 0; i <= n; i++) {
        best.push(new Array(rows + 1).fill(inf));
        cut.push(new Array(rows + 1).fill(0));
    }
    best[0][0] = 0;
    for (let r = 1; r <= rows; r++) {
        for (let i = r; i <= n - (rows - r); i++) {
            for (let j = r - 1; j < i; j++) {
                if (best[j][r - 1] === inf) continue;
                const dev = prefix[i] - prefix[j] - ideal;
                const cost = best[j][r - 1] + dev * dev;
                if (cost < best[i][r]) {
                    best[i][r] = cost;
                    cut[i][r] = j;
                }
            }
        }
    }
    const out = [];
    let i = n;
    let r = rows;
    while (r > 0) {
        const j = cut[i][r];
        out.push(i - j);
        i = j;
        r -= 1;
    }
    out.reverse();
    return out;
}

function candidates(aspects) {
    const n = aspects.length;
    if (n <= EXHAUSTIVE_LIMIT) return compositions(n);
    const out = [];
    for (let r = 1; r <= Math.min(n, MAX_ROWS); r++) out.push(balanced(aspects, r));
    return out;
}

function geometry(aspects, rows, budget, gap) {
    const sums = [];
    let idx = 0;
    for (const k of rows) {
        let s = 0;
        for (let i = idx; i < idx + k; i++) s += aspects[i];
        if (s <= 0) return null;
        sums.push([k, s]);
        idx += k;
    }
    let c1 = 0;
    let inner = 0;
    for (const [k, s] of sums) {
        c1 += 1 / s;
        inner += (k - 1) / s;
    }
    const c0 = gap * (rows.length - 1) - gap * inner;
    const w = (-c0 + Math.sqrt(c0 * c0 + 4 * c1 * budget)) / (2 * c1);
    const h = c1 * w + c0;
    if (w <= 0 || h <= 0) return null;

    const heights = [];
    for (const [k, s] of sums) {
        const rowH = (w - gap * (k - 1)) / s;
        if (rowH <= 0) return null;
        heights.push(rowH);
    }
    return { w, h, heights };
}

function scoreOf(aspects, rows, heights, width, height, target) {
    const logs = [];
    let idx = 0;
    for (let r = 0; r < rows.length; r++) {
        const rowH = heights[r];
        for (let i = idx; i < idx + rows[r]; i++) {
            logs.push(Math.log(aspects[i] * rowH * rowH));
        }
        idx += rows[r];
    }
    let mean = 0;
    for (const v of logs) mean += v;
    mean /= logs.length;
    let variance = 0;
    for (const v of logs) variance += (v - mean) * (v - mean);
    variance /= logs.length;
    return Math.abs(Math.log((width / height) / target)) + Math.sqrt(variance);
}

function alignDown(v, align) {
    return Math.max(align, Math.floor(v / align) * align);
}

function alignUp(v, align) {
    return Math.max(align, Math.ceil(v / align) * align);
}

function alignNear(v, align) {
    return Math.max(align, Math.floor(v / align + 0.5) * align);
}

// One score then, where there is one, the row SHAPE -- compared the way
// Python compares the tuple, including "a shorter tuple that is a prefix
// sorts first".
function keyOf(score, rows) {
    const out = [Math.floor(score * 1e9 + 0.5)];
    for (const k of rows) out.push(-k);
    return out;
}

function keyLess(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (a[i] !== b[i]) return a[i] < b[i];
    }
    return a.length < b.length;
}

function boxOf(x, y, w, h, width, height) {
    // SIZE rounded once, never derived from rounded endpoints -- the
    // mirror of compose_layout._box, and the reasoning lives there
    // (identical crops must come out identical, squares stay square).
    const bw = Math.max(1, Math.min(width, Math.floor(w + 0.5)));
    const bh = Math.max(1, Math.min(height, Math.floor(h + 0.5)));
    const x0 = Math.max(0, Math.min(width - bw, Math.floor(x + 0.5)));
    const y0 = Math.max(0, Math.min(height - bh, Math.floor(y + 0.5)));
    return [x0, y0, bw, bh];
}

// floor(x + 0.5), never Math.round -- see compose_layout._q.
function q(v) {
    return Math.floor(v * 1e9 + 0.5);
}

// Bottom-left skyline packing. NOTHING IS EVER ROTATED -- see
// compose_layout._skyline_pack, which this mirrors line for line.
function skylinePack(sizes, width, gap) {
    let sky = [[0, width, 0]];
    const placed = [];
    for (const [w, h] of sizes) {
        const iw = w + gap;
        const ih = h + gap;
        if (iw > width + EPS) return null;
        let bestY = 0;
        let bestX = 0;
        let have = false;
        for (let i = 0; i < sky.length; i++) {
            const start = sky[i][0];
            if (start + iw > width + EPS) continue;
            let y = 0;
            let span = iw;
            let j = i;
            while (span > EPS && j < sky.length) {
                if (sky[j][2] > y) y = sky[j][2];
                span -= sky[j][1];
                j++;
            }
            if (span > EPS) continue;
            if (!have || y < bestY || (y === bestY && start < bestX)) {
                bestY = y;
                bestX = start;
                have = true;
            }
        }
        if (!have) return null;
        placed.push([bestX, bestY, w, h]);

        const cut = [];
        const end = bestX + iw;
        for (const [sx, sw, sy] of sky) {
            if (sx + sw <= bestX + EPS || sx >= end - EPS) {
                cut.push([sx, sw, sy]);
                continue;
            }
            if (sx < bestX) cut.push([sx, bestX - sx, sy]);
            if (sx + sw > end) cut.push([end, sx + sw - end, sy]);
        }
        cut.push([bestX, iw, bestY + ih]);
        cut.sort((a, b) => a[0] - b[0]);
        const merged = [];
        for (const seg of cut) {
            const last = merged[merged.length - 1];
            if (last && Math.abs(last[2] - seg[2]) < EPS) {
                last[1] += seg[1];
                last[2] = seg[2];
            } else {
                merged.push([seg[0], seg[1], seg[2]]);
            }
        }
        sky = merged;
    }
    let w0 = 0;
    let h0 = 0;
    for (const p of placed) {
        if (p[0] + p[2] > w0) w0 = p[0] + p[2];
        if (p[1] + p[3] > h0) h0 = p[1] + p[3];
    }
    return { placed, w0, h0 };
}

function packOrders(sizes) {
    const n = sizes.map((_x, i) => i);
    return [
        ["given", n.slice()],
        ["tallest first",
         n.slice().sort((a, b) => (sizes[b][1] - sizes[a][1]) || (a - b))],
        ["widest first",
         n.slice().sort((a, b) => (sizes[b][0] - sizes[a][0]) || (a - b))],
        ["largest first",
         n.slice().sort((a, b) => (sizes[b][0] * sizes[b][1]
                                   - sizes[a][0] * sizes[a][1]) || (a - b))],
    ];
}

function packSweep(sizes, gap, target, band) {
    let used = 0;
    let lo = 0;
    let hi = gap * sizes.length;
    for (const [w, h] of sizes) {
        used += w * h;
        if (w > lo) lo = w;
        hi += w;
    }
    lo += gap;
    const out = [];
    for (const [name, order] of packOrders(sizes)) {
        const ordered = order.map((i) => sizes[i]);
        let found = null;
        for (let step = 0; step < PACK_WIDTH_STEPS; step++) {
            const width = lo + (hi - lo) * step / (PACK_WIDTH_STEPS - 1);
            const got = skylinePack(ordered, width, gap);
            if (!got) continue;
            const fill = used / (got.w0 * got.h0);
            const aspect = got.w0 / got.h0;
            if (band && !(aspect >= PACK_ASPECT_MIN
                          && aspect <= PACK_ASPECT_MAX)) continue;
            const key = target === null
                ? [-q(fill), q(Math.abs(Math.log(aspect))), -q(aspect)]
                : [q(Math.abs(Math.log(aspect / target))
                     + WASTE_WEIGHT * (1 - fill))];
            if (!found || keyLess(key, found.key)) {
                found = { key, fill, placed: got.placed, w0: got.w0,
                          h0: got.h0, order, name };
            }
        }
        if (found) out.push(found);
    }
    return out;
}

function planNatural(sizes, budget, target, gap, align) {
    let found = packSweep(sizes, gap, target, target === null);
    if (!found.length && target === null) {
        // Nothing landed inside the aspect band -- one extreme panorama
        // can do it. A sheet of some shape beats no sheet at all.
        found = packSweep(sizes, gap, target, false);
    }
    if (!found.length) return null;

    // The user's own layer order is the default answer; another ordering
    // takes it only by packing PACK_ORDER_MARGIN tighter.
    let best = found.find((r) => r.name === "given") || found[0];
    for (const other of found) {
        if (keyLess(other.key, best.key)
            && other.fill > best.fill + PACK_ORDER_MARGIN) {
            best = other;
        }
    }
    const { placed, w0, h0, order, name } = best;

    // The one scale factor, capped at 1: this is the whole point of the
    // mode. Above 1 it would be enlarging pixels that do not exist.
    const sExact = Math.min(1, Math.sqrt(budget / (w0 * h0)));
    let width, height, scale;
    if (sExact >= 1
            && alignUp(w0, align) * alignUp(h0, align) <= budget) {
        // budget not binding: align UP and pad with background instead
        // of shrinking pixels (mirror of compose_layout._plan_natural,
        // reasoning there)
        width = alignUp(w0, align);
        height = alignUp(h0, align);
        scale = 1;
    } else {
        width = alignDown(sExact * w0, align);
        height = alignNear(h0 * width / w0, align);
        // Alignment has a floor of one step, so on a very small sheet
        // the canvas can come out LARGER than the content asked for --
        // clamp again or that floor would enlarge the images after all.
        scale = Math.min(width / w0, height / h0, 1);
    }

    const ox = (width - w0 * scale) / 2;
    const oy = (height - h0 * scale) / 2;
    const boxes = new Array(sizes.length).fill(null);
    for (let k = 0; k < order.length; k++) {
        const [x, y, w, h] = placed[k];
        boxes[order[k]] = boxOf(ox + x * scale, oy + y * scale,
                                w * scale, h * scale, width, height);
    }
    // The fill REPORTED is the one the viewer can see: integer boxes
    // against the aligned canvas, not the packing fill in source pixels.
    let covered = 0;
    for (const b of boxes) covered += b[2] * b[3];
    return { width, height, rows: null, boxes, scale,
             fill: covered / (width * height), order: name };
}

function planFill(aspects, budget, target, gap, align) {
    // `auto` means "least dead space", and fill mode HAS no dead space --
    // every row is full by construction, so the criterion cannot separate
    // a ribbon from a grid. What is left of it is the part that still
    // applies: the tightest sheet is the squarest one.
    if (target === null) target = 1.0;
    let best = null;
    let bestKey = null;
    for (const rows of candidates(aspects)) {
        const geom = geometry(aspects, rows, budget, gap);
        if (!geom) continue;
        const score = scoreOf(aspects, rows, geom.heights, geom.w, geom.h, target);
        const key = keyOf(score, rows);
        if (!bestKey || keyLess(key, bestKey)) {
            bestKey = key;
            best = { rows, w: geom.w, h: geom.h, heights: geom.heights };
        }
    }
    if (!best) {
        const rows = [aspects.length];
        const geom = geometry(aspects, rows, budget, 0);
        gap = 0;
        best = { rows, w: geom.w, h: geom.h, heights: geom.heights };
    }

    const width = alignDown(best.w, align);
    const height = alignNear(best.h * (width / best.w), align);

    const rowHeights = [];
    let idx = 0;
    for (const k of best.rows) {
        let s = 0;
        for (let i = idx; i < idx + k; i++) s += aspects[i];
        rowHeights.push((width - gap * (k - 1)) / s);
        idx += k;
    }
    let contentH = gap * (best.rows.length - 1);
    for (const v of rowHeights) contentH += v;
    const scale = contentH > 0 ? Math.min(1, height / contentH) : 1;
    const contentW = width * scale;
    contentH *= scale;

    const ox = (width - contentW) / 2;
    const oy = (height - contentH) / 2;

    const boxes = [];
    idx = 0;
    let y = oy;
    for (let r = 0; r < best.rows.length; r++) {
        const k = best.rows[r];
        const rowH = rowHeights[r] * scale;
        const y0 = Math.floor(y + 0.5);
        const y1 = Math.floor(y + rowH + 0.5);
        let x = ox;
        for (let i = idx; i < idx + k; i++) {
            const itemW = aspects[i] * rowH;
            const x0 = Math.floor(x + 0.5);
            const x1 = Math.floor(x + itemW + 0.5);
            boxes.push([x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)]);
            x += itemW + gap * scale;
        }
        y += rowH + gap * scale;
        idx += k;
    }
    let covered = 0;
    for (const b of boxes) covered += b[2] * b[3];
    return { width, height, rows: best.rows, boxes, scale: null,
             fill: covered / (width * height), order: "given" };
}

function planLayout(sizes, maxMegapixels, targetAspect, gap, align, sizing) {
    const pairs = [];
    for (const item of sizes || []) {
        const w = Number(item?.[0]);
        const h = Number(item?.[1]);
        if (w > 0 && h > 0) pairs.push([w, h]);
    }
    if (!pairs.length) return null;
    align = align || ALIGN;
    // 0 is "no cap" (mirrors compose_layout.plan): natural mode never
    // shrinks, fill mode fills a sheet of the sources' own area.
    const mp = Number(maxMegapixels);
    let budget;
    if (mp > 0) {
        budget = Math.max(1, mp * 1024 * 1024);
    } else if (sizing === "fill") {
        budget = Math.max(1, pairs.reduce((a, [w, h]) => a + w * h, 0));
    } else {
        budget = Infinity;
    }
    gap = Math.max(0, Math.floor(Number(gap) || 0));
    // null is a VALUE here ("auto"), not a missing key -- so membership
    // is the test, and an unreadable name falls through to auto rather
    // than to a shape nobody asked for.
    let target;
    if (Object.prototype.hasOwnProperty.call(TARGET_ASPECTS, targetAspect)) {
        target = TARGET_ASPECTS[targetAspect];
    } else {
        const asNumber = Number(targetAspect);
        target = asNumber > 0 ? asNumber : null;
    }
    if (target !== null && !(target > 0)) target = null;

    if (sizing === "fill") {
        return planFill(pairs.map(([w, h]) => w / h), budget, target, gap,
                        align);
    }
    return planNatural(pairs, budget, target, gap, align);
}

/* ------------------------------------------------------------------ */

const MARGIN = 10;
const HANDLE = 8;
const MIN_SEL = 6;
const MIN_EDITOR_H = 140;
const RESIZE_ZONE = 15; // LGraphNode.resizeHandleSize
const LIST_W = 68;
// The strip's width is the user's: the gutter between the strip and the
// main view is a divider they can drag, and the width is kept in the
// node's properties. Entries never shrink to fit more layers (the list
// scrolls instead); they scale with the strip's width, so a wider strip
// means larger thumbnails, LIST_ENTRY_H tall at the default width.
const LIST_W_MIN = 48;
const LIST_W_MAX_FRAC = 0.7;    // of the node body
const LIST_ENTRY_H = 46;
const LIST_SCROLLBAR_W = 3;
const GUTTER = 6;
const DIVIDER_GRAB = 3;         // px either side of the gutter that count
const PICK_PLACEHOLDER = "＋ from input folder…";

// Thumbnails are shared across every node on the page: the same
// reference image in two Compose nodes is one download.
const thumbs = new Map();

function viewURL(path) {
    let name = String(path);
    let subfolder = "";
    const slash = name.lastIndexOf("/");
    if (slash >= 0) {
        subfolder = name.slice(0, slash);
        name = name.slice(slash + 1);
    }
    return api.apiURL(
        `/view?filename=${encodeURIComponent(name)}&type=input` +
        `&subfolder=${encodeURIComponent(subfolder)}`
    );
}

// roundRect is not universally present on OffscreenCanvas contexts and
// older browsers; a square strip is a better failure than a thrown draw.
function roundedPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, w, h, r);
    } else {
        ctx.rect(x, y, w, h);
    }
}

function thumbFor(path, onReady) {
    let entry = thumbs.get(path);
    if (entry) {
        if (entry.pending && onReady) entry.waiters.push(onReady);
        return entry;
    }
    entry = { img: null, failed: false, pending: true, waiters: onReady ? [onReady] : [] };
    thumbs.set(path, entry);
    const img = new Image();
    img.onload = () => {
        entry.img = img;
        entry.pending = false;
        for (const fn of entry.waiters) fn();
        entry.waiters = [];
    };
    img.onerror = () => {
        entry.failed = true;
        entry.pending = false;
        for (const fn of entry.waiters) fn();
        entry.waiters = [];
    };
    img.src = viewURL(path);
    return entry;
}

// A live listing of the input folder. A combo's values are a page-load
// snapshot, so anything uploaded since would be missing from it.
let activeImports = 0;
let inputFiles = [];
let inputFilesAt = 0;
async function refreshInputFiles() {
    if (Date.now() - inputFilesAt < 2000) return inputFiles;
    inputFilesAt = Date.now();
    try {
        const resp = await api.fetchApi("/obvpm/input_images");
        const data = await resp.json();
        if (Array.isArray(data.files)) inputFiles = data.files;
    } catch (e) {
        // Leave the previous listing in place; the picker still works.
    }
    return inputFiles;
}

async function uploadImage(file) {
    checkFiles([file]);
    const body = new FormData();
    body.append("image", file);
    body.append("type", "input");
    body.append("subfolder", "");
    const resp = await api.fetchApi("/upload/image", { method: "POST", body });
    if (resp.status !== 200) {
        throw new Error(`upload failed (${resp.status}) ${resp.statusText}`);
    }
    const data = await resp.json();
    // On a name collision the server RENAMES rather than overwriting --
    // always take the name it hands back, never the one that was sent.
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif)$/i;

function isArtiusImage(asset) {
    return asset?.type === "image"
        || IMAGE_RE.test(String(asset?.filename || ""));
}

function isComposeNode(node) {
    return !!node && (node.comfyClass === "LoadImagesCompose (obvpm)"
                      || node.type === "LoadImagesCompose (obvpm)");
}

async function artiusAddToNode(node, assets) {
    if ((assets || []).length > MAX_LAYERS) { alert("At most 64 compose layers are allowed"); return true; }
    const wanted = (assets || []).filter(isArtiusImage);
    if (!wanted.length) return true;
    // Consumed: Artius's own dragend fallback must not re-insert it.
    window.__tsArtiusDraggedAsset = "";
    return node.obvpmRunImport?.(wanted.length, async () => {
    const known = await refreshInputFiles();
    let importedBytes = 0;
    for (const asset of wanted) {
        const rel = artiusRelativePath(asset);
        // Already under the input folder: reference it in place. No
        // second copy of a file the picker can already list.
        if (rel && known.includes(rel)) {
            node.obvpmAddLayer?.(rel);
            continue;
        }
        const src = asset.file_url || (asset.id != null
            ? `${ARTIUS_ROUTE_BASE}/file?id=${encodeURIComponent(String(asset.id))}`
            : "");
        if (!src) {
            console.error("[obvpm-compose] Artius asset has no source", asset);
            continue;
        }
        try {
            const resp = await api.fetchApi(src);
            if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
            const blob = await boundedBlob(resp, Math.min(MAX_FILE_BYTES, MAX_TOTAL_FILE_BYTES - importedBytes));
            importedBytes += blob.size;
            const file = new File([blob], String(asset.filename || "image.png"),
                                  { type: blob.type || "image/png" });
            node.obvpmAddLayer?.(await uploadImage(file));
        } catch (err) {
            console.error("[obvpm-compose] Artius copy failed:", err);
            alert(`Could not add ${asset.filename}: ${err.message}`);
        }
    }
    inputFilesAt = 0; // the input listing just changed
    return true;
    });
}

function artiusPayloadOn(e) {
    return Array.from(e?.dataTransfer?.types ?? []).includes(ARTIUS_MIME);
}

// Which node is under the pointer, without waiting for the canvas to
// tell us -- see hookArtiusBridge for why the wait is the problem.
function composeNodeUnder(e) {
    const canvas = app.canvas;
    const el = canvas?.canvas;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right
        || e.clientY < rect.top || e.clientY > rect.bottom) return null;
    let pos = null;
    try {
        pos = canvas.convertEventToCanvasOffset?.(e) ?? null;
    } catch (err) {
        pos = null;
    }
    if (!pos) return null;
    const graph = canvas.graph || app.graph;
    const node = graph?.getNodeOnPos?.(pos[0], pos[1], graph._nodes);
    return isComposeNode(node) ? node : null;
}

// Artius installs a CAPTURE-phase drop bridge on the canvas element and
// stopImmediatePropagation()s its own MIME, so an Artius drop on a bare
// canvas node never reaches litegraph's handler and onDragDrop is never
// called. (The H3 loaders only escape this because a DOM widget covers
// their body, and a drop on that bypasses the canvas element entirely --
// this node is pure canvas, so it has no such cover.)
//
// Listening on the DOCUMENT in the capture phase is what gets in first:
// capture runs root-down, so document fires before any listener on the
// canvas element, whatever order the extensions loaded in.
// The wheel has to be taken the same way an Artius drop is: on the
// DOCUMENT in the capture phase, which runs before any listener on the
// canvas element whatever order the extensions loaded in. passive:false
// because the whole point is to preventDefault.
let listWheelHooked = false;
function hookListWheel() {
    if (listWheelHooked) return;
    listWheelHooked = true;
    document.addEventListener("wheel", (e) => {
        const node = composeNodeUnder(e);
        if (!node || typeof node.obvpmWheel !== "function") return;
        let pos = null;
        try {
            pos = app.canvas?.convertEventToCanvasOffset?.(e) ?? null;
        } catch (err) {
            pos = null;
        }
        if (!pos || !node.pos) return;
        if (!node.obvpmWheel(pos[0] - node.pos[0], pos[1] - node.pos[1],
                             e.deltaY)) return;
        e.preventDefault();
        e.stopPropagation();
    }, { capture: true, passive: false });
}

let artiusBridgeHooked = false;
function hookArtiusBridge() {
    if (artiusBridgeHooked) return;
    artiusBridgeHooked = true;
    document.addEventListener("dragover", (e) => {
        if (!artiusPayloadOn(e) || !composeNodeUnder(e)) return;
        e.preventDefault();          // without this the drop is refused
    }, true);
    document.addEventListener("drop", (e) => {
        if (!artiusPayloadOn(e)) return;
        const node = composeNodeUnder(e);
        if (!node) return;           // not ours: leave it entirely alone
        e.preventDefault();
        e.stopImmediatePropagation();
        void artiusAddToNode(node, readArtiusAssets(e) || []);
    }, true);
}

app.registerExtension({
    name: "obvpm.compose_images",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "LoadImagesCompose (obvpm)") return;
        hookArtiusBridge();
        hookListWheel();

        const onDragOver = nodeType.prototype.onDragOver;
        nodeType.prototype.onDragOver = function (e) {
            if (onDragOver?.apply(this, arguments)) return true;
            // The Artius branch here is the path for a build with no
            // capture bridge installed; with one, hookArtiusBridge has
            // already claimed the drop before this can run.
            if (artiusPayloadOn(e)) return true;
            const items = e?.dataTransfer?.items;
            if (!items) return false;
            return Array.from(items).some((i) => i.kind === "file");
        };

        const onDragDrop = nodeType.prototype.onDragDrop;
        nodeType.prototype.onDragDrop = async function (e) {
            if (await onDragDrop?.apply(this, arguments)) return true;
            const artius = readArtiusAssets(e);
            if (artius) return artiusAddToNode(this, artius);
            const files = Array.from(e?.dataTransfer?.files ?? [])
                .filter((f) => f.type.startsWith("image/"));
            if (!files.length) return false;
            // Claimed: report our own errors rather than returning false,
            // which would let core fall through and upload the files a
            // second time under a Load Image node.
            await this.obvpmAddFiles?.(files);
            return true;
        };

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;
            const layersWidget = node.widgets.find((w) => w.name === "layers");

            layersWidget.hidden = true;
            layersWidget.options = layersWidget.options || {};
            layersWidget.options.hidden = true;
            // A hidden widget keeps its input socket, invisible but still
            // hit-tested over the node's first real pin. The value rides
            // in widgets_values, so the socket is dead weight: drop it and
            // re-point the links, which address slots by INDEX.
            const slot = (node.inputs ?? []).findIndex(
                (s) => s.widget && (s.widget.name === "layers" || s.name === "layers"));
            if (slot >= 0 && node.inputs[slot].link == null) {
                node.removeInput(slot);
                const links = node.graph?.links;
                (node.inputs ?? []).forEach((s, index) => {
                    if (!links || s.link == null) return;
                    const link = typeof links.get === "function"
                        ? links.get(s.link) : links[s.link];
                    if (link) link.target_slot = index;
                });
            }

            const isVueMode = () =>
                typeof LiteGraph !== "undefined" && !!LiteGraph.vueNodesMode;
            const ui = () =>
                isVueMode()
                    ? { font: 13, row: 20, handle: 12, list: 86 }
                    : { font: 10, row: 15, handle: HANDLE, list: LIST_W };

            // The stock preview channels: this node draws its own.
            Object.defineProperty(node, "imgs", {
                get: () => undefined,
                set: () => {},
            });

            const state = {
                layers: [],
                sel: -1, // -1 = the Result view
                hover: -1,
                hoverSlot: -1,
                drag: null,
                listDrag: null,
                divDrag: null,  // dragging the strip/main divider
                pointerOver: false, // the pointer is on this node's body
                listW: null,    // the strip width the user set, or null
                scroll: 0,
                scrollMax: 0,
                reveal: null,   // an index to bring into view, once
                geo: null,
                box: null, // drawn image box in the crop editor
                plan: null,
                planKey: "",
            };

            function readLayers() {
                state.error = "";
                try {
                    state.layers = parseLayers(layersWidget.value || "[]");
                } catch (err) {
                    state.layers = [];
                    state.error = err.message;
                }
                // Never rewrite refused persisted JSON with an empty/truncated list.
                state.invalid = !!state.error;
                if (state.sel >= state.layers.length) state.sel = state.layers.length - 1;
                for (const layer of state.layers) thumbFor(layer.image, repaint);
            }

            function syncLayers() {
                if (state.invalid) return;
                const value = JSON.stringify(state.layers.map((layer) => {
                    const out = { image: layer.image };
                    if (layer.crop) {
                        out.crop = {
                            x: +layer.crop.x.toFixed(4),
                            y: +layer.crop.y.toFixed(4),
                            w: +layer.crop.w.toFixed(4),
                            h: +layer.crop.h.toFixed(4),
                        };
                    }
                    if (layer.aspect) out.aspect = layer.aspect;
                    return out;
                }));
                try { parseLayers(value); }
                catch (err) { state.error = err.message; state.invalid = true; repaint(); return; }
                if (layersWidget.value !== value) layersWidget.value = value;
                state.planKey = ""; // force a re-plan
                repaint();
            }

            function repaint() {
                node.setDirtyCanvas(true, true);
                editorWidget?.triggerDraw?.();
            }

            function canAdd(count) {
                if (state.removed || state.invalid || state.layers.length + count > MAX_LAYERS) {
                    alert(state.error || "At most 64 compose layers are allowed");
                    return false;
                }
                return true;
            }

            function addLayer(path) {
                if (!canAdd(1)) return false;
                try { parseLayers(JSON.stringify([...state.layers, { image: path }])); }
                catch (err) { alert(err.message); return false; }
                state.layers.push({ image: path, crop: null, aspect: null });
                state.sel = state.layers.length - 1;
                state.reveal = state.sel;
                thumbFor(path, repaint);
                syncLayers();
                return true;
            }

            // Reachable from the module-level Artius handlers, which
            // only have the node.
            node.obvpmAddLayer = addLayer;

            // litegraph's processMouseWheel goes straight to zoom/pan
            // and never consults a node or a widget (verified in
            // LGraphCanvas.ts), so the strip cannot receive the wheel by
            // the normal route -- see hookListWheel for how it does.
            // Coordinates arrive node-local, the same space state.geo is
            // measured in.
            node.obvpmWheel = function (x, y, deltaY) {
                const geo = state.geo && state.geo.list;
                if (!geo || state.scrollMax <= 0) return false;
                if (x < geo.x || x > geo.x + geo.w
                    || y < geo.y || y > geo.y + geo.h) return false;
                const before = state.scroll;
                state.scroll = Math.max(0, Math.min(
                    state.scrollMax, state.scroll + deltaY));
                if (state.scroll !== before) repaint();
                // Claimed even at the ends: scrolling past the last
                // layer should not suddenly zoom the whole graph.
                return true;
            };

            node.obvpmRunImport = async function (count, fn) {
                if (state.importing || activeImports >= 2) { alert("Image imports are busy; retry shortly"); return true; }
                if (!canAdd(count)) return true;
                state.importing = true;
                activeImports++;
                try { await fn(); }
                catch (err) { alert(`Could not add images: ${err.message}`); }
                finally { state.importing = false; activeImports--; }
                return true;
            };
            node.obvpmAddFiles = async function (files) {
                return node.obvpmRunImport(files.length, async () => {
                    checkFiles(files); // refuse the whole batch before any upload
                    for (const file of files) {
                        if (state.removed || !canAdd(1)) break;
                        addLayer(await uploadImage(file));
                    }
                    inputFilesAt = 0;
                });
            };

            // Clipboard pastes. Core hands a pasted image to the SELECTED
            // node only when isImageNode(node) -- previewMediaType
            // "image", or node.imgs, which this node never has -- and then
            // calls BOTH pasteFile(first) and pasteFiles(all). Define only
            // pasteFiles, or one paste would add the layer twice. The
            // right-click "Paste Image" entry keys off pasteFiles as well.
            node.previewMediaType = "image";
            node.pasteFiles = function (files) {
                const images = Array.from(files ?? [])
                    .filter((f) => f && f.type.startsWith("image/"));
                if (!images.length) return false;
                void node.obvpmAddFiles(images);
                return true;
            };

            let fileInput = null;
            function pickFiles() {
                if (!fileInput) {
                    fileInput = document.createElement("input");
                    fileInput.type = "file";
                    fileInput.accept = "image/*";
                    fileInput.multiple = true;
                    fileInput.style.display = "none";
                    fileInput.addEventListener("change", async () => {
                        const files = Array.from(fileInput.files ?? []);
                        fileInput.value = "";
                        await node.obvpmAddFiles(files);
                    });
                    document.body.append(fileInput);
                }
                fileInput.click();
            }

            const addButton = node.addWidget(
                "button", "＋ add image", null, pickFiles);
            const pickWidget = node.addWidget(
                "combo", "add", PICK_PLACEHOLDER,
                (value) => {
                    if (value && value !== PICK_PLACEHOLDER) addLayer(value);
                    pickWidget.value = PICK_PLACEHOLDER;
                },
                {
                    // A values FUNCTION is what keeps this listing live;
                    // litegraph calls it every time the dropdown opens.
                    // Stale-while-revalidate, because it has to answer
                    // synchronously: kick off the refresh, serve what the
                    // last one returned. (If this ever comes up empty in
                    // Nodes 2.0, a renderer reading options.values as a
                    // plain array is the first thing to check -- the
                    // button and drag & drop still work either way.)
                    values: () => {
                        refreshInputFiles();
                        return [PICK_PLACEHOLDER].concat(inputFiles);
                    },
                });
            // Neither control is an input of the node: keep both out of
            // the prompt, or picking a file would look like a changed
            // input and re-run a node whose output is identical.
            for (const w of [addButton, pickWidget]) {
                w.serialize = false;
                w.options = w.options || {};
                w.options.serialize = false;
            }

            /* --- geometry the layout depends on ------------------- */

            // The layer's size in SOURCE pixels after its crop -- not
            // just its aspect: natural sizing lays out by real size, and
            // this is what tells it a 200px crop is a 200px crop.
            function layerSize(layer) {
                const rect = sourceRect(layer);
                return rect ? [rect[2], rect[3]] : null;
            }

            function widgetValue(name, fallback) {
                const w = node.widgets.find((x) => x.name === name);
                return w ? w.value : fallback;
            }

            function currentPlan() {
                state.planError = "";
                const sizes = state.layers.map(layerSize);
                if (!sizes.length || sizes.some((s) => s == null)) return null;
                // 0 is a value here (no cap), so no `|| 1` fallback.
                const mpRaw = Number(widgetValue("max_megapixels", 1));
                const mp = mpRaw;
                // Neither of these is a widget any more, so these
                // fallbacks are what the node actually composes with.
                // They must match compose_images.compose's defaults --
                // test_compose_plan.mjs asserts it, because there is no
                // longer a widget to keep them honest.
                const target = widgetValue("target_aspect", "auto");
                const gap = Number(widgetValue("gap", 0));
                const sizing = widgetValue("sizing", SIZINGS[0]);
                if (!safePlanInputs(sizes, mp, gap, target)
                    || !(Object.hasOwn(TARGET_ASPECTS, target) || (Number.isFinite(Number(target)) && Number(target) > 0 && Number(target) <= 16384))) {
                    state.planError = "Invalid or oversized compose layout (see README safety limits)";
                    return null;
                }
                const key = JSON.stringify([sizes, mp, target, gap, sizing]);
                if (key !== state.planKey) {
                    state.planFailure = "";
                    state.plan = planLayout(sizes, mp, target, gap, ALIGN,
                                            sizing);
                    if (state.plan && (Math.max(state.plan.width, state.plan.height) > 16384
                        || state.plan.width * state.plan.height > 32 * 1024 * 1024)) {
                        state.planFailure = "Compose canvas exceeds the 32 Mi-pixel / 16384 side limit";
                        state.plan = null;
                    }
                    state.planKey = key;
                }
                state.planError = state.planFailure;
                return state.plan;
            }

            // Source rectangle of a layer's crop in its own pixels, for
            // drawImage. Null when the thumbnail has not arrived.
            function sourceRect(layer) {
                const entry = thumbs.get(layer.image);
                if (!entry || !entry.img) return null;
                const iw = entry.img.width;
                const ih = entry.img.height;
                const ratio = parseAspect(layer.aspect);
                const c = layer.crop
                    ?? (ratio ? impliedAspectRect(iw, ih, ratio) : null);
                if (!c) return [0, 0, iw, ih];
                const x0 = Math.max(0, Math.min(iw - 1, Math.round(c.x * iw)));
                const y0 = Math.max(0, Math.min(ih - 1, Math.round(c.y * ih)));
                const x1 = Math.max(x0 + 1, Math.min(iw, Math.round((c.x + c.w) * iw)));
                const y1 = Math.max(y0 + 1, Math.min(ih, Math.round((c.y + c.h) * ih)));
                return [x0, y0, x1 - x0, y1 - y0];
            }

            /* --- drawing ------------------------------------------ */

            let allocHeight;

            function boxHeight(widget, widgetY, fallback) {
                if (isVueMode()) return fallback;
                const nodeH = node.size?.[1];
                const visible = node.widgets?.filter((w) => !w.hidden);
                const isLast = !!visible && visible[visible.length - 1] === widget;
                if (nodeH == null || widgetY == null || !isLast) return fallback;
                return Math.max(MIN_EDITOR_H, nodeH - widgetY);
            }

            function textColor() {
                const lg = typeof LiteGraph !== "undefined" ? LiteGraph : {};
                return lg.WIDGET_TEXT_COLOR || "#ddd";
            }

            function entryHeight(listW, u) {
                // Never shrunk to fit: more layers scroll. Scaled with
                // the strip's width so a wider strip shows more of each
                // thumbnail, not just more air beside it.
                return Math.round(LIST_ENTRY_H * listW / u.list);
            }

            function drawList(ctx, x, y, w, h, u) {
                const count = state.layers.length + 1; // + the Result row
                const eh = entryHeight(w, u);
                const total = eh * count;
                // Scrolling is the USER'S now, so the auto-scroll may
                // only fire when something moved the selection under
                // them -- adding, deleting, reordering. Recomputing it
                // every frame would drag the list back from wherever
                // they had scrolled it to.
                state.scrollMax = Math.max(0, total - h);
                if (state.reveal != null) {
                    const top = (state.reveal + 1) * eh;
                    let s = Math.min(state.scroll, top);
                    s = Math.max(s, top + eh - h);
                    state.scroll = s;
                    state.reveal = null;
                }
                state.scroll = Math.max(0, Math.min(state.scrollMax,
                                                    state.scroll));

                ctx.save();
                // Rounded top and bottom, and the CLIP carries the shape
                // to everything drawn after it -- the selection fill and
                // the first and last thumbnails included, which is what
                // makes the corners read as the strip's rather than as a
                // frame drawn over square content.
                roundedPath(ctx, x, y, w, h, 5);
                ctx.clip();
                ctx.fillStyle = "#00000033";
                ctx.fill();

                const rows = [];
                for (let i = -1; i < state.layers.length; i++) {
                    const top = y + (i + 1) * eh - state.scroll;
                    rows.push({ index: i, top, height: eh });
                    if (top + eh < y || top > y + h) continue;

                    const selected = state.sel === i;
                    const hovered = state.hover === i;
                    if (selected) {
                        ctx.fillStyle = "#4af3";
                        ctx.fillRect(x, top, w, eh);
                        ctx.strokeStyle = "#4af";
                        ctx.lineWidth = 1;
                        ctx.strokeRect(x + 0.5, top + 0.5, w - 1, eh - 1);
                    } else if (hovered) {
                        ctx.fillStyle = "#ffffff12";
                        ctx.fillRect(x, top, w, eh);
                    }

                    const pad = 3;
                    const cellX = x + pad + 10;
                    const cellW = w - pad * 2 - 10;
                    const cellY = top + pad;
                    const cellH = eh - pad * 2;

                    ctx.fillStyle = textColor();
                    ctx.font = `${u.font}px sans-serif`;
                    ctx.textAlign = "left";
                    ctx.textBaseline = "middle";
                    ctx.globalAlpha = selected ? 1 : 0.55;
                    ctx.fillText(i < 0 ? "▣" : String(i + 1), x + 2, top + eh / 2);
                    ctx.globalAlpha = 1;

                    if (i < 0) {
                        // The Result row is a thumbnail of the real
                        // composition, drawn from the same plan the main
                        // view uses -- so the strip shows what the node
                        // will output, not the word for it.
                        const plan = currentPlan();
                        if (plan) {
                            const ps = Math.min(cellW / plan.width,
                                                cellH / plan.height);
                            const pw = plan.width * ps;
                            const ph = plan.height * ps;
                            const px0 = cellX + (cellW - pw) / 2;
                            const py0 = cellY + (cellH - ph) / 2;
                            const lvl = Math.round(255 * (
                                BACKGROUNDS[widgetValue("background",
                                                        "black")] ?? 0));
                            ctx.fillStyle = `rgb(${lvl},${lvl},${lvl})`;
                            ctx.fillRect(px0, py0, pw, ph);
                            for (let j = 0; j < state.layers.length; j++) {
                                const slot = plan.boxes[j];
                                const src = sourceRect(state.layers[j]);
                                const th = thumbs.get(state.layers[j].image);
                                if (!slot || !src || !th || !th.img) continue;
                                ctx.drawImage(
                                    th.img, src[0], src[1], src[2], src[3],
                                    px0 + slot[0] * ps, py0 + slot[1] * ps,
                                    Math.max(1, slot[2] * ps),
                                    Math.max(1, slot[3] * ps));
                            }
                        } else {
                            ctx.font = `${u.font}px sans-serif`;
                            ctx.textBaseline = "middle";
                            ctx.fillStyle = textColor();
                            ctx.globalAlpha = selected ? 1 : 0.75;
                            ctx.fillText("Result", cellX, top + eh / 2);
                            ctx.globalAlpha = 1;
                        }
                    } else {
                        const layer = state.layers[i];
                        const entry = thumbs.get(layer.image);
                        if (entry && entry.img) {
                            const rect = sourceRect(layer);
                            const scale = Math.min(cellW / rect[2], cellH / rect[3]);
                            const dw = rect[2] * scale;
                            const dh = rect[3] * scale;
                            ctx.drawImage(
                                entry.img, rect[0], rect[1], rect[2], rect[3],
                                cellX + (cellW - dw) / 2, cellY + (cellH - dh) / 2, dw, dh);
                        } else {
                            ctx.fillStyle = "#ffffff10";
                            ctx.fillRect(cellX, cellY, cellW, cellH);
                            if (entry && entry.failed) {
                                ctx.fillStyle = "#c66";
                                ctx.font = `${u.font}px sans-serif`;
                                ctx.textAlign = "center";
                                ctx.fillText("?", cellX + cellW / 2, cellY + cellH / 2);
                                ctx.textAlign = "left";
                            }
                        }
                        if (hovered || selected) {
                            // Delete badge, top-right of the cell.
                            const bx = x + w - 9;
                            const by = top + 8;
                            ctx.fillStyle = "rgba(0,0,0,0.65)";
                            ctx.beginPath();
                            ctx.arc(bx, by, 6, 0, Math.PI * 2);
                            ctx.fill();
                            ctx.strokeStyle = "#e88";
                            ctx.lineWidth = 1.4;
                            ctx.beginPath();
                            ctx.moveTo(bx - 2.5, by - 2.5);
                            ctx.lineTo(bx + 2.5, by + 2.5);
                            ctx.moveTo(bx + 2.5, by - 2.5);
                            ctx.lineTo(bx - 2.5, by + 2.5);
                            ctx.stroke();
                        }
                    }
                }

                if (state.scrollMax > 0) {
                    // A thumb, so an overflowing list looks like one.
                    const frac = h / total;
                    const barH = Math.max(18, h * frac);
                    const barY = y + (h - barH)
                        * (state.scroll / state.scrollMax);
                    ctx.fillStyle = "#ffffff40";
                    ctx.fillRect(x + w - LIST_SCROLLBAR_W - 1, barY,
                                 LIST_SCROLLBAR_W, barH);
                }

                if (state.listDrag && state.listDrag.moved) {
                    const at = state.listDrag.to;
                    const lineY = y + (at + 1) * eh - state.scroll;
                    ctx.strokeStyle = "#4af";
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(x, lineY);
                    ctx.lineTo(x + w, lineY);
                    ctx.stroke();
                }

                ctx.restore();
                return { x, y, w, h, entryHeight: eh, rows };
            }

            function drawResult(ctx, x, y, w, h, u, lowQuality) {
                const plan = currentPlan();
                if (!plan) {
                    ctx.fillStyle = "#00000033";
                    ctx.fillRect(x, y, w, h);
                    ctx.fillStyle = "#888";
                    ctx.font = `${u.font + 2}px sans-serif`;
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText(
                        state.layers.length ? "loading…" : "drop images here",
                        x + w / 2, y + h / 2);
                    return null;
                }

                const scale = Math.min(w / plan.width, h / plan.height);
                const bw = plan.width * scale;
                const bh = plan.height * scale;
                const bx = x + (w - bw) / 2;
                const by = y + (h - bh) / 2;

                const fill = BACKGROUNDS[widgetValue("background", "black")] ?? 0;
                const level = Math.round(fill * 255);
                ctx.fillStyle = `rgb(${level},${level},${level})`;
                ctx.fillRect(bx, by, bw, bh);

                state.geo.slots = [];
                for (let i = 0; i < state.layers.length; i++) {
                    const [px, py, pw, ph] = plan.boxes[i];
                    const dx = bx + px * scale;
                    const dy = by + py * scale;
                    const dw = pw * scale;
                    const dh = ph * scale;
                    state.geo.slots.push({ index: i, x: dx, y: dy, w: dw, h: dh });
                    const layer = state.layers[i];
                    const entry = thumbs.get(layer.image);
                    const rect = sourceRect(layer);
                    if (entry && entry.img && rect) {
                        ctx.drawImage(entry.img, rect[0], rect[1], rect[2], rect[3],
                                      dx, dy, dw, dh);
                    }
                    if (lowQuality) continue;
                    // NO OUTLINE PER SLOT. With gap 0 the layers butt
                    // straight against each other, so a hairline drawn
                    // round each one reads as a light frame the output
                    // does not have -- a preview that misrepresents its
                    // own result is worse than one that shows less. The
                    // hovered slot is outlined, because there it means
                    // "this one, and clicking opens it".
                    if (state.hoverSlot === i) {
                        ctx.strokeStyle = "#4af";
                        ctx.lineWidth = 2;
                        ctx.strokeRect(dx + 1, dy + 1, dw - 2, dh - 2);
                    }
                    if (dw > 54 && dh > 20) {
                        const label = `${pw}×${ph}`;
                        ctx.font = `${u.font}px sans-serif`;
                        const tw = ctx.measureText(label).width;
                        ctx.fillStyle = "rgba(0,0,0,0.55)";
                        ctx.fillRect(dx + 3, dy + 3, tw + 6, u.font + 4);
                        ctx.fillStyle = "#fff";
                        ctx.textAlign = "left";
                        ctx.textBaseline = "top";
                        ctx.fillText(label, dx + 6, dy + 5);
                    }
                }
                return plan;
            }

            function drawCrop(ctx, x, y, w, h, u, lowQuality) {
                const layer = state.layers[state.sel];
                const entry = layer ? thumbs.get(layer.image) : null;
                if (!entry || !entry.img) {
                    ctx.fillStyle = "#00000033";
                    ctx.fillRect(x, y, w, h);
                    ctx.fillStyle = "#888";
                    ctx.font = `${u.font + 2}px sans-serif`;
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText(entry && entry.failed ? "image not found" : "loading…",
                                 x + w / 2, y + h / 2);
                    state.box = null;
                    state.pills = {};
                    return;
                }
                const img = entry.img;
                // The aspect pill lives in a reserved band under the
                // image rather than on top of it -- overlap read as
                // part of the picture.
                const PILL_H = 20;
                // the same 6px the list/image gutter uses, so the pill's
                // spacing reads as part of one grid
                const PILL_BAND = PILL_H + GUTTER;
                const imgH = Math.max(1, h - PILL_BAND);
                const scale = Math.min(w / img.width, imgH / img.height);
                const bw = img.width * scale;
                const bh = img.height * scale;
                const bx = x + (w - bw) / 2;
                const by = y + (imgH - bh) / 2;
                state.box = { bx, by, bw, bh };
                ctx.drawImage(img, bx, by, bw, bh);

                const ratioDraw = parseAspect(layer.aspect);
                const r = layer.crop
                    || (ratioDraw
                        ? impliedAspectRect(img.width, img.height, ratioDraw)
                        : null);
                if (r && !lowQuality) {
                    const sx = bx + r.x * bw;
                    const sy = by + r.y * bh;
                    const sw = r.w * bw;
                    const sh = r.h * bh;
                    ctx.beginPath();
                    ctx.rect(bx, by, bw, bh);
                    ctx.rect(sx, sy, sw, sh);
                    ctx.fillStyle = "rgba(0,0,0,0.55)";
                    ctx.fill("evenodd");
                    ctx.strokeStyle = "#4af";
                    ctx.lineWidth = 1;
                    if (!layer.crop) ctx.setLineDash([4, 3]);
                    ctx.strokeRect(sx, sy, sw, sh);
                    ctx.setLineDash([]);
                    ctx.fillStyle = "#4af";
                    for (const [hx, hy] of [
                        [sx, sy], [sx + sw, sy], [sx, sy + sh], [sx + sw, sy + sh],
                    ]) {
                        ctx.fillRect(hx - 2.5, hy - 2.5, 5, 5);
                    }
                    const rect = sourceRect(layer);
                    const label = `${rect[2]} × ${rect[3]}`;
                    ctx.font = `${u.font}px sans-serif`;
                    ctx.textAlign = "left";
                    ctx.textBaseline = "alphabetic";
                    const tw = ctx.measureText(label).width;
                    const pillH = u.font + 2;
                    const tx = Math.max(bx, Math.min(sx + (sw - tw - 6) / 2,
                                                     bx + bw - tw - 6));
                    const ty = sy > y + pillH + 2 ? sy - 3 : sy + pillH - 1;
                    ctx.fillStyle = "rgba(0,0,0,0.6)";
                    ctx.fillRect(tx, ty - pillH + 3, tw + 6, pillH);
                    ctx.fillStyle = "#fff";
                    ctx.fillText(label, tx + 3, ty);
                }

                // The layer's button row, in the band under the
                // image: aspect lock and duplicate on the left, delete
                // on the far right. Same chrome as the Value Presets
                // buttons (themePalette rest/edge/text, 4px radius,
                // 10px type); rects are remembered for the pointer
                // handler, which gives them first claim on clicks.
                const PAL = themePalette();
                ctx.font = "10px sans-serif";
                ctx.textAlign = "left";
                ctx.textBaseline = "middle";
                const ppH = PILL_H;
                // Anchored to the IMAGE, not the editor area: the image
                // is centered in the area, so area-relative margins read
                // as random air. Flush with the picture's edges, the
                // same gutter-width gap below it as everywhere else.
                const ppY = Math.min(by + bh + GUTTER, y + h - ppH);
                const pill = (key, text, px) => {
                    const ppW = ctx.measureText(text).width + 16;
                    // restRgb, not rest: rest is a var() string for DOM
                    // styles, and canvas fillStyle silently ignores it
                    ctx.fillStyle = PAL.restRgb ?? PAL.rest;
                    roundedPath(ctx, px, ppY, ppW, ppH, 4);
                    ctx.fill();
                    if (state.pillHover === key) {
                        // snapBtn's off-state hover, the only hover the
                        // shared chrome has (same as the VP buttons)
                        ctx.fillStyle = "rgba(127,127,127,0.3)";
                        roundedPath(ctx, px, ppY, ppW, ppH, 4);
                        ctx.fill();
                    }
                    ctx.strokeStyle = PAL.edge;
                    ctx.lineWidth = 1;
                    roundedPath(ctx, px + 0.5, ppY + 0.5, ppW - 1, ppH - 1, 4);
                    ctx.stroke();
                    ctx.fillStyle = PAL.text;
                    ctx.fillText(text, px + 8, ppY + ppH / 2 + 0.5);
                    state.pills[key] = { x: px, y: ppY, w: ppW, h: ppH };
                    return ppW;
                };
                state.pills = {};
                const aspectW = pill(
                    "aspect", "aspect: " + (layer.aspect ?? "free"), bx);
                pill("dup", "duplicate", bx + aspectW + GUTTER);
                const delW = ctx.measureText("delete").width + 16;
                pill("del", "delete", bx + bw - delW);
                ctx.textBaseline = "alphabetic";
            }

            function drawInfo(ctx, x, y, w, u) {
                const plan = currentPlan();
                const segments = [];
                const n = state.layers.length;
                const error = state.error || state.planError;
                if (error) {
                    segments.push([error, false]);
                } else if (!n) {
                    segments.push(["＋ add image, or drop files on the node", true]);
                } else if (!plan) {
                    segments.push([`${n} layer${n === 1 ? "" : "s"} · reading sizes…`, true]);
                } else {
                    segments.push([`${n} layer${n === 1 ? "" : "s"} → `, true]);
                    segments.push([`${plan.width} × ${plan.height}`, false]);
                    let tail = ` · ${(plan.width * plan.height / 1048576).toFixed(2)} MP`;
                    // A packed sheet has no rows to name; what it has is
                    // how much of it is image.
                    tail += plan.rows
                        ? ` · ${plan.rows.join("+")}`
                        : ` · ${Math.round(plan.fill * 100)}% filled`;
                    // In natural sizing one factor applies to every layer,
                    // so it is a fact worth stating: "full size" means
                    // nothing was resampled at all.
                    if (plan.scale != null) {
                        tail += plan.scale >= 0.999
                            ? " · full size"
                            : ` · ${Math.round(plan.scale * 100)}% of source`;
                    }
                    segments.push([tail, true]);
                    if (state.sel >= 0 && plan.boxes[state.sel]) {
                        const b = plan.boxes[state.sel];
                        segments.push([`   slot `, true]);
                        segments.push([`${b[2]} × ${b[3]}`, false]);
                    }
                }
                ctx.font = `${u.font}px sans-serif`;
                ctx.textAlign = "left";
                ctx.textBaseline = "alphabetic";
                ctx.fillStyle = textColor();
                let total = 0;
                for (const [text] of segments) total += ctx.measureText(text).width;
                let cx = x + Math.max(0, (w - total) / 2);
                const prev = ctx.globalAlpha;
                for (const [text, muted] of segments) {
                    ctx.globalAlpha = muted ? prev * 0.45 : prev;
                    ctx.fillText(text, cx, y + u.font);
                    cx += ctx.measureText(text).width;
                }
                ctx.globalAlpha = prev;
            }

            const editor = {
                name: "compose_editor",
                type: "obvpm_composeeditor",
                value: "",
                serialize: false,
                options: { serialize: false },

                computeLayoutSize: function (n) {
                    if (isVueMode()) {
                        const h = Math.max(MIN_EDITOR_H, 240);
                        return { minHeight: h, maxHeight: h, minWidth: 0 };
                    }
                    return { minHeight: MIN_EDITOR_H, maxHeight: 100000, minWidth: 0 };
                },

                draw: function (ctx, _node, widgetWidth, y, H, lowQuality) {
                    const u = ui();
                    const h = boxHeight(this, y, allocHeight ?? H) - 8;
                    const nodeW = _node?.size?.[0];
                    const effWidth =
                        !isVueMode() && nodeW ? Math.min(widgetWidth, nodeW) : widgetWidth;
                    const x = MARGIN;
                    const w = effWidth - MARGIN * 2;
                    // 4px of air between the editor and the info row:
                    // the row hugged the pill band above it.
                    const INFO_PAD = 4;
                    const bodyH = Math.max(1, h - u.row - INFO_PAD);
                    const listW = clampListW(state.listW ?? u.list, w);
                    const mainX = x + listW + GUTTER;
                    const mainW = Math.max(1, w - listW - GUTTER);

                    ctx.save();
                    state.geo = { list: null, main: { x: mainX, y, w: mainW, h: bodyH },
                                  divider: { x: x + listW, y, w: GUTTER, h: bodyH },
                                  slots: [] };
                    state.geo.list = drawList(ctx, x, y, listW, bodyH, u);
                    // the divider: a hairline in the gutter, brighter
                    // while it is being dragged
                    ctx.strokeStyle = state.divDrag ? "#4af" : "#ffffff22";
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(x + listW + GUTTER / 2 + 0.5, y + 4);
                    ctx.lineTo(x + listW + GUTTER / 2 + 0.5, y + bodyH - 4);
                    ctx.stroke();
                    if (state.sel < 0) {
                        drawResult(ctx, mainX, y, mainW, bodyH, u, lowQuality);
                    } else {
                        drawCrop(ctx, mainX, y, mainW, bodyH, u, lowQuality);
                    }
                    if (!lowQuality) drawInfo(ctx, x, y + bodyH + INFO_PAD, w, u);
                    ctx.restore();
                },

                mouse: function (event, pos, _node) {
                    const t = event.type;
                    const px = pos[0];
                    const py = pos[1];
                    const geo = state.geo;
                    if (!geo) return false;

                    const down = t === "pointerdown" || t === "mousedown";
                    const move = t === "pointermove" || t === "mousemove";
                    const up = t === "pointerup" || t === "mouseup";

                    // A canvas drag is still a drag to the browser: left
                    // alone it starts a TEXT SELECTION across the host's
                    // DOM (node titles, Vue cards), which paints the UI
                    // blue mid-drag. Claimed drags switch selection off
                    // for their duration.
                    const selectionOff = (on) => {
                        try {
                            document.body.style.userSelect =
                                on ? "none" : "";
                        } catch (err) { /* headless tests */ }
                    };

                    // ---- the divider between the strip and the view ----
                    if (down && onDivider(px, py)) {
                        state.divDrag = { dx: px - geo.divider.x };
                        selectionOff(true);
                        repaint();
                        return true;
                    }
                    if (state.divDrag) {
                        if (move) {
                            const bodyW = geo.main.x + geo.main.w - geo.list.x;
                            state.listW = clampListW(
                                px - state.divDrag.dx - geo.list.x, bodyW);
                            repaint();
                            return true;
                        }
                        if (up) {
                            state.divDrag = null;
                            selectionOff(false);
                            node.properties = node.properties || {};
                            node.properties.obvpm_list_w = Math.round(state.listW);
                            repaint();
                            return true;
                        }
                    }

                    // ---- the layer strip ----
                    const inList = geo.list && px >= geo.list.x
                        && px <= geo.list.x + geo.list.w
                        && py >= geo.list.y && py <= geo.list.y + geo.list.h;

                    if (down && inList) {
                        const hit = rowAt(px, py);
                        if (hit == null) return false;
                        if (hit >= 0 && onDeleteBadge(px, py, hit)) {
                            removeLayer(hit);
                            return true;
                        }
                        state.sel = hit;
                        state.listDrag = hit >= 0
                            ? { from: hit, to: hit, startY: py, moved: false } : null;
                        repaint();
                        return true;
                    }
                    if (state.listDrag) {
                        if (move) {
                            if (Math.abs(py - state.listDrag.startY) > 4) {
                                state.listDrag.moved = true;
                            }
                            // `to` is an INSERTION index: the boundary
                            // above layer k sits one row down from the
                            // top of the strip, because row 0 is Result.
                            const eh = geo.list.entryHeight;
                            const raw = (py - geo.list.y + state.scroll) / eh;
                            state.listDrag.to = Math.max(0, Math.min(
                                state.layers.length, Math.round(raw) - 1));
                            repaint();
                            return true;
                        }
                        if (up) {
                            const drag = state.listDrag;
                            state.listDrag = null;
                            if (drag.moved) moveLayer(drag.from, drag.to);
                            repaint();
                            return true;
                        }
                    }

                    // ---- the result view: clicking a slot selects it ----
                    if (state.sel < 0) {
                        if (down) {
                            for (const slot of geo.slots) {
                                if (px >= slot.x && px <= slot.x + slot.w
                                    && py >= slot.y && py <= slot.y + slot.h) {
                                    state.sel = slot.index;
                                    repaint();
                                    return true;
                                }
                            }
                        }
                        return false;
                    }

                    // ---- the crop editor ----
                    const layer = state.layers[state.sel];
                    if (!layer || !state.box) return false;
                    const { bx, by, bw, bh } = state.box;
                    const clampX = (v) => Math.max(bx, Math.min(bx + bw, v));
                    const clampY = (v) => Math.max(by, Math.min(by + bh, v));
                    const ratio = parseAspect(layer.aspect);

                    if (down) {
                        // the button row has first claim on its rects
                        const hitPill = pillAt(px, py);
                        if (hitPill === "aspect") {
                            openAspectMenu(layer, event);
                            return true;
                        }
                        if (hitPill === "dup") {
                            duplicateLayer(state.sel);
                            return true;
                        }
                        if (hitPill === "del") {
                            removeLayer(state.sel);
                            repaint();
                            return true;
                        }
                        if (px < bx || px > bx + bw || py < by || py > by + bh) return false;
                        // Under a fixed aspect the dashed implied rect IS
                        // the crop; grabbing it makes it real so the same
                        // move/resize paths apply.
                        const entry = thumbs.get(layer.image);
                        if (!layer.crop && ratio && entry?.img) {
                            layer.crop = impliedAspectRect(
                                entry.img.width, entry.img.height, ratio);
                        }
                        event.preventDefault?.();
                        selectionOff(true);
                        state.drag = {
                            ...hitTest(px, py), startX: px, startY: py, moved: false };
                        repaint();
                        return true;
                    }
                    const drag = state.drag;
                    if (!drag) return false;

                    if (move) {
                        if (Math.abs(px - drag.startX) + Math.abs(py - drag.startY) > 2) {
                            drag.moved = true;
                        }
                        if (drag.mode === "new") {
                            if (ratio) {
                                const locked = ratioDragRect(
                                    state.box, drag.startX, drag.startY,
                                    clampX(px), clampY(py), ratio, MIN_SEL);
                                if (locked) layer.crop = locked;
                            } else {
                                const x0 = clampX(Math.min(drag.startX, px));
                                const y0 = clampY(Math.min(drag.startY, py));
                                const x1 = clampX(Math.max(drag.startX, px));
                                const y1 = clampY(Math.max(drag.startY, py));
                                if (x1 - x0 >= MIN_SEL && y1 - y0 >= MIN_SEL) {
                                    layer.crop = {
                                        x: (x0 - bx) / bw, y: (y0 - by) / bh,
                                        w: (x1 - x0) / bw, h: (y1 - y0) / bh,
                                    };
                                }
                            }
                        } else if (drag.mode === "move" && layer.crop) {
                            const r = layer.crop;
                            r.x = Math.max(0, Math.min(1 - r.w, (clampX(px - drag.offX) - bx) / bw));
                            r.y = Math.max(0, Math.min(1 - r.h, (clampY(py - drag.offY) - by) / bh));
                        } else if (drag.mode === "resize" && layer.crop) {
                            const r = layer.crop;
                            let x0 = bx + r.x * bw;
                            let y0 = by + r.y * bh;
                            let x1 = x0 + r.w * bw;
                            let y1 = y0 + r.h * bh;
                            if (ratio) {
                                // the corner opposite the handle stays put
                                const ax = drag.corner.includes("w") ? x1 : x0;
                                const ay = drag.corner.includes("n") ? y1 : y0;
                                const locked = ratioDragRect(
                                    state.box, ax, ay,
                                    clampX(px), clampY(py), ratio, MIN_SEL);
                                if (locked) layer.crop = locked;
                            } else {
                                if (drag.corner.includes("w")) x0 = clampX(px);
                                if (drag.corner.includes("e")) x1 = clampX(px);
                                if (drag.corner.includes("n")) y0 = clampY(py);
                                if (drag.corner.includes("s")) y1 = clampY(py);
                                if (Math.abs(x1 - x0) >= MIN_SEL && Math.abs(y1 - y0) >= MIN_SEL) {
                                    layer.crop = {
                                        x: (Math.min(x0, x1) - bx) / bw,
                                        y: (Math.min(y0, y1) - by) / bh,
                                        w: Math.abs(x1 - x0) / bw,
                                        h: Math.abs(y1 - y0) / bh,
                                    };
                                }
                            }
                        }
                        // The crop changes this layer's aspect, which
                        // changes the whole layout: re-plan as it drags.
                        state.planKey = "";
                        repaint();
                        return true;
                    }

                    if (up) {
                        selectionOff(false);
                        if (drag.mode === "new" && !drag.moved) layer.crop = null;
                        state.drag = null;
                        if (event.target?.style) event.target.style.cursor = "";
                        normalizeCrop(layer);
                        syncLayers();
                        return true;
                    }
                    return false;
                },
            };
            const editorWidget = node.addCustomWidget(editor);

            function pillAt(px, py) {
                for (const [key, r] of Object.entries(state.pills ?? {})) {
                    if (px >= r.x && px <= r.x + r.w
                            && py >= r.y && py <= r.y + r.h) {
                        return key;
                    }
                }
                return null;
            }

            // The same image again as a new layer, crop and aspect
            // included, right after the original -- selected, so the
            // usual next step (recropping the copy) is one drag away.
            function duplicateLayer(index) {
                const src = state.layers[index];
                if (!src || !canAdd(1)) return;
                const copy = { image: src.image,
                               crop: src.crop ? { ...src.crop } : null,
                               aspect: src.aspect ?? null };
                state.layers.splice(index + 1, 0, copy);
                state.sel = index + 1;
                state.reveal = state.sel;
                syncLayers();
                repaint();
            }

            function openAspectMenu(layer, event) {
                const items = ASPECT_CHOICES.map((choice) => ({
                    content: choice + (choice === (layer.aspect ?? "free")
                                       ? "  \u2713" : ""),
                    callback: () => {
                        const next = choice === "free" ? null : choice;
                        if (next === layer.aspect) return;
                        layer.aspect = next;
                        const ratioNew = parseAspect(next);
                        const entry = thumbs.get(layer.image);
                        if (ratioNew && layer.crop && entry?.img) {
                            layer.crop = snapRectToAspect(
                                layer.crop, entry.img.width,
                                entry.img.height, ratioNew);
                        }
                        state.planKey = "";
                        normalizeCrop(layer);
                        syncLayers();
                        repaint();
                    },
                }));
                new LiteGraph.ContextMenu(items, {
                    event, title: "layer aspect", className: "dark",
                });
            }

            function normalizeCrop(layer) {
                const r = layer.crop;
                if (!r) return;
                // A selection of (almost) everything means no crop, so the
                // node loads the image untouched.
                if (r.w <= 0.001 || r.h <= 0.001
                    || (r.x < 0.002 && r.y < 0.002 && r.w > 0.996 && r.h > 0.996)) {
                    layer.crop = null;
                }
            }

            function clampListW(v, bodyW) {
                const hi = Math.max(LIST_W_MIN, bodyW * LIST_W_MAX_FRAC);
                return Math.max(LIST_W_MIN, Math.min(hi, Number(v) || 0));
            }

            function onDivider(px, py) {
                const d = state.geo?.divider;
                if (!d) return false;
                return px >= d.x - DIVIDER_GRAB && px <= d.x + d.w + DIVIDER_GRAB
                    && py >= d.y && py <= d.y + d.h;
            }

            function rowAt(px, py) {
                const geo = state.geo?.list;
                if (!geo) return null;
                const idx = Math.floor((py - geo.y + state.scroll) / geo.entryHeight) - 1;
                if (idx < -1 || idx >= state.layers.length) return null;
                return idx;
            }

            function onDeleteBadge(px, py, index) {
                const geo = state.geo?.list;
                if (!geo || index < 0) return false;
                const top = geo.y + (index + 1) * geo.entryHeight - state.scroll;
                const bx = geo.x + geo.w - 9;
                const by = top + 8;
                return (px - bx) * (px - bx) + (py - by) * (py - by) <= 49;
            }

            function removeLayer(index) {
                state.layers.splice(index, 1);
                if (state.sel >= state.layers.length) state.sel = state.layers.length - 1;
                state.reveal = state.sel;
                syncLayers();
            }

            function moveLayer(from, to) {
                const [item] = state.layers.splice(from, 1);
                const at = Math.max(0, Math.min(state.layers.length,
                                                to > from ? to - 1 : to));
                state.layers.splice(at, 0, item);
                state.sel = at;
                state.reveal = at;
                syncLayers();
            }

            function hitTest(px, py) {
                const layer = state.layers[state.sel];
                if (!layer || !layer.crop || !state.box) return { mode: "new" };
                const handle = ui().handle;
                const { bx, by, bw, bh } = state.box;
                const r = layer.crop;
                const sx = bx + r.x * bw;
                const sy = by + r.y * bh;
                const sw = r.w * bw;
                const sh = r.h * bh;
                const corners = {
                    nw: [sx, sy], ne: [sx + sw, sy],
                    sw: [sx, sy + sh], se: [sx + sw, sy + sh],
                };
                for (const [name, [cx, cy]] of Object.entries(corners)) {
                    if (Math.abs(px - cx) <= handle && Math.abs(py - cy) <= handle) {
                        return { mode: "resize", corner: name };
                    }
                }
                if (px >= sx && px <= sx + sw && py >= sy && py <= sy + sh) {
                    return { mode: "move", offX: px - sx, offY: py - sy };
                }
                return { mode: "new" };
            }

            /* --- cursors ------------------------------------------ */

            function cursorOutside(px, py) {
                const w = node.size?.[0];
                const h = node.size?.[1];
                if (w == null || h == null) return "default";
                if (py <= h && py >= h - RESIZE_ZONE) {
                    if (px >= w - RESIZE_ZONE) return "nwse-resize";
                    if (px <= RESIZE_ZONE) return "nesw-resize";
                }
                return "default";
            }

            function cursorFor(px, py) {
                const geo = state.geo;
                if (!geo) return cursorOutside(px, py);
                if (state.divDrag || onDivider(px, py)) return "col-resize";
                if (geo.list && px >= geo.list.x && px <= geo.list.x + geo.list.w
                    && py >= geo.list.y && py <= geo.list.y + geo.list.h) {
                    const idx = rowAt(px, py);
                    if (idx == null) return "default";
                    if (idx >= 0 && onDeleteBadge(px, py, idx)) return "pointer";
                    return idx >= 0 ? "grab" : "pointer";
                }
                if (state.sel < 0) {
                    for (const slot of geo.slots) {
                        if (px >= slot.x && px <= slot.x + slot.w
                            && py >= slot.y && py <= slot.y + slot.h) return "pointer";
                    }
                    return cursorOutside(px, py);
                }
                if (pillAt(px, py)) return "pointer";
                if (!state.box) return cursorOutside(px, py);
                const { bx, by, bw, bh } = state.box;
                if (px < bx || px > bx + bw || py < by || py > by + bh) {
                    return cursorOutside(px, py);
                }
                const hit = hitTest(px, py);
                if (hit.mode === "resize") {
                    return hit.corner === "nw" || hit.corner === "se"
                        ? "nwse-resize" : "nesw-resize";
                }
                if (hit.mode === "move") return "grab";
                return state.layers[state.sel]?.crop ? "not-allowed" : "crosshair";
            }

            // Keys, while the pointer is over this node (so the same keys
            // keep their meaning everywhere else, and never while
            // typing): Delete / Backspace remove the selected layer, Up /
            // Down walk the strip, Result row included. Capture on window:
            // ComfyUI's own keybindings would delete the selected node
            // or pan the canvas first.
            const onKeyDown = (e) => {
                if (state.removed || !state.pointerOver) return;
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                const a = document.activeElement;
                if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA"
                          || a.isContentEditable)) return;
                if (e.key === "Delete" || e.key === "Backspace") {
                    if (state.sel < 0 || !state.layers[state.sel]) return;
                    e.preventDefault();
                    e.stopPropagation();
                    removeLayer(state.sel);
                    repaint();
                    return;
                }
                if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                    const next = Math.max(-1, Math.min(state.layers.length - 1,
                        state.sel + (e.key === "ArrowUp" ? -1 : 1)));
                    e.preventDefault();
                    e.stopPropagation();
                    if (next === state.sel) return;
                    state.sel = next;
                    state.reveal = next;   // scroll the strip to it
                    repaint();
                }
            };
            window.addEventListener("keydown", onKeyDown, true);

            const prevMouseMove = node.onMouseMove;
            node.onMouseMove = function (e, pos, graphCanvas) {
                prevMouseMove?.apply(this, arguments);
                state.pointerOver = true;
                const geo = state.geo;
                let hover = -2;
                if (geo && geo.list && pos[0] >= geo.list.x
                    && pos[0] <= geo.list.x + geo.list.w
                    && pos[1] >= geo.list.y && pos[1] <= geo.list.y + geo.list.h) {
                    const idx = rowAt(pos[0], pos[1]);
                    hover = idx == null ? -2 : idx;
                }
                let slot = -1;
                if (state.sel < 0 && geo) {
                    for (const s of geo.slots) {
                        if (pos[0] >= s.x && pos[0] <= s.x + s.w
                            && pos[1] >= s.y && pos[1] <= s.y + s.h) {
                            slot = s.index;
                            break;
                        }
                    }
                }
                const pillHover = state.sel >= 0
                    ? pillAt(pos[0], pos[1]) : null;
                if (hover !== state.hover || slot !== state.hoverSlot
                        || pillHover !== (state.pillHover ?? null)) {
                    state.hover = hover;
                    state.hoverSlot = slot;
                    state.pillHover = pillHover;
                    repaint();
                }
                const el = graphCanvas?.canvas || app.canvas?.canvas;
                if (el && !state.drag && !state.listDrag) {
                    el.style.cursor = cursorFor(pos[0], pos[1]);
                }
            };
            const prevMouseLeave = node.onMouseLeave;
            node.onMouseLeave = function () {
                prevMouseLeave?.apply(this, arguments);
                state.pointerOver = false;
                if (!state.drag) {
                    // a drag that never got its pointerup must not leave
                    // the page unselectable
                    try { document.body.style.userSelect = ""; }
                    catch (err) { /* headless tests */ }
                }
                if (state.hover !== -2 || state.hoverSlot !== -1
                        || state.pillHover) {
                    state.hover = -2;
                    state.hoverSlot = -1;
                    state.pillHover = null;
                    repaint();
                }
                const el = app.canvas?.canvas;
                if (el) el.style.cursor = "";
            };

            // Report a shorter box to litegraph's widget hit test than is
            // drawn: a growable widget that fills the body would otherwise
            // cover the node's resize corners. The freed band is the info
            // row, which is text only.
            Object.defineProperty(editorWidget, "computedHeight", {
                configurable: true,
                get() {
                    if (isVueMode() || allocHeight == null) return undefined;
                    return Math.max(0, boxHeight(this, this.y, allocHeight) - RESIZE_ZONE);
                },
                set(v) {
                    allocHeight = v;
                },
            });

            // Draw and hit test both use `widget.width || node.size[0]`,
            // so a width left here by anything else silently shrinks both.
            Object.defineProperty(editorWidget, "width", {
                configurable: true,
                get: () => undefined,
                set: () => {},
            });

            // Any of these changes the layout without touching a layer.
            for (const name of ["max_megapixels", "target_aspect", "gap",
                                "background", "sizing"]) {
                const w = node.widgets.find((x) => x.name === name);
                if (!w) continue;
                const prev = w.callback;
                w.callback = function () {
                    const r = prev?.apply(this, arguments);
                    state.planKey = "";
                    repaint();
                    return r;
                };
            }

            const prevOnRemoved = node.onRemoved;
            node.onRemoved = function () {
                state.removed = true;
                window.removeEventListener("keydown", onKeyDown, true);
                fileInput?.remove();
                return prevOnRemoved?.apply(this, arguments);
            };

            const prevOnConfigure = node.onConfigure;
            node.onConfigure = function () {
                const r = prevOnConfigure?.apply(this, arguments);
                // Workflow load assigns widgets_values directly, with no
                // callbacks, so the layer list has to be re-read here.
                readLayers();
                const lw = Number(this.properties?.obvpm_list_w);
                state.listW = Number.isFinite(lw) && lw > 0 ? lw : null;
                state.planKey = "";
                repaint();
                return r;
            };

            readLayers();
            refreshInputFiles();
            return result;
        };
    },
});
