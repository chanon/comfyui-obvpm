// Fixed-aspect crop geometry, shared by Load Image & Crop and the
// per-layer editor in Load Images & Compose. One implementation: the
// rectangle a drag produces and the cut an empty selection means must
// be the same everywhere, or two editors would disagree about the same
// stored crop.
//
// Everything here is pure: rects are {x, y, w, h} normalized to the
// image, and screen-space work takes the drawn image box explicitly.
// The preview boxes are aspect-correct in both editors, so a PIXEL
// ratio constrains screen drags directly.

// The choices the compose editor offers per layer. Load Image & Crop's
// combo is served by ASPECTS in load_image_crop.py -- keep the two
// lists identical.
export const ASPECT_CHOICES = ["free", "21:9", "2:1", "16:9", "3:2",
                               "4:3", "5:4", "1:1", "4:5", "3:4", "2:3",
                               "9:16", "1:2"];

/** "a:b" -> a/b as a number; null for free/absent/unparseable. */
export function parseAspect(value) {
    const parts = String(value ?? "").split(":");
    const r = parts.length === 2
        ? Number(parts[0]) / Number(parts[1]) : NaN;
    return Number.isFinite(r) && r > 0 ? r : null;
}

/**
 * The largest centered rect of `ratio`, normalized to an iw x ih image
 * -- what an EMPTY crop means under a fixed aspect. The servers compute
 * the same box, so what an editor shows is what runs.
 */
export function impliedAspectRect(iw, ih, ratio) {
    let w = iw;
    let h = w / ratio;
    if (h > ih) { h = ih; w = h * ratio; }
    return { x: (iw - w) / 2 / iw, y: (ih - h) / 2 / ih,
             w: w / iw, h: h / ih };
}

/**
 * A ratio-locked rect from an anchor toward a pointer, in screen space,
 * kept inside the drawn image `box` ({bx, by, bw, bh}); null while the
 * drag is smaller than `minSel`. The dominant axis leads, the other
 * follows, and clamping at an edge shrinks both so the shape holds.
 */
export function ratioDragRect(box, ax, ay, px, py, ratio, minSel) {
    const { bx, by, bw, bh } = box;
    const sx = px >= ax ? 1 : -1;
    const sy = py >= ay ? 1 : -1;
    let w = Math.max(Math.abs(px - ax), Math.abs(py - ay) * ratio);
    let h = w / ratio;
    const availW = sx > 0 ? bx + bw - ax : ax - bx;
    const availH = sy > 0 ? by + bh - ay : ay - by;
    const fit = Math.min(1, availW / w, availH / h);
    w *= fit;
    h *= fit;
    if (w < minSel || h < minSel) return null;
    const x0 = sx > 0 ? ax : ax - w;
    const y0 = sy > 0 ? ay : ay - h;
    return { x: (x0 - bx) / bw, y: (y0 - by) / bh,
             w: w / bw, h: h / bh };
}

/**
 * An existing rect reshaped to `ratio`: same center, same pixel area,
 * shrunk only when the image cannot hold the shape. What switching the
 * aspect option does to a crop that is already drawn.
 */
export function snapRectToAspect(rect, iw, ih, ratio) {
    const area = (rect.w * iw) * (rect.h * ih);
    let w = Math.sqrt(area * ratio);
    let h = w / ratio;
    const fit = Math.min(1, iw / w, ih / h);
    w *= fit;
    h *= fit;
    const cx = (rect.x + rect.w / 2) * iw;
    const cy = (rect.y + rect.h / 2) * ih;
    const x0 = Math.max(0, Math.min(iw - w, cx - w / 2));
    const y0 = Math.max(0, Math.min(ih - h, cy - h / 2));
    return { x: x0 / iw, y: y0 / ih, w: w / iw, h: h / ih };
}
