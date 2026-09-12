"""Contact-sheet layout: fit N images of any size into ONE canvas.

Images keep their ORDER and their exact ASPECT RATIO in both modes, and
in both the only thing being decided is where the row breaks go. What
differs is what a row is allowed to do to the images in it.

`target_aspect` names a shape to aim the sheet at, or `auto`, which aims
at nothing: it takes the tightest packing it can find whose sheet is not
a ribbon. "Tightest" cannot be the whole rule on its own -- a single row
of identical images wastes nothing at all, and so does a single column --
which is why the shape is a BAND (PACK_ASPECT_MIN..MAX) rather than
another term to be weighed.

NATURAL (the default) gives every image ONE shared scale factor, never
above 1. The relative pixel sizes of the sources therefore survive
exactly: a 300x200 crop next to a 3000x2000 one comes out nine times
smaller in area, because that is what it is. A small crop cannot take
space away from a large one by being stretched to fill a slot, and
nothing is ever enlarged past the pixels it actually has -- so here the
megapixel budget is a CAP, not a target, and a sheet of small images
comes out small. The cost is that rows no longer end flush, which is
what the scorer's waste term is for:

    score = |ln(canvas_aspect / target_aspect)| + 2 * dead_fraction

"Dead" means neither an image nor a gap that was asked for: the ragged
end of a short row, and the band under an image shorter than its row.

FILL is the "justified rows" layout photo galleries use. Every row is
filled edge to edge and the rows stack to fill the canvas, so nothing is
wasted -- but an image is scaled to whatever its slot turned out to be,
up as readily as down. Its scorer trades the shape of the sheet against
how evenly the budget is shared:

    score = |ln(canvas_aspect / target_aspect)| + stdev(ln area_i)

Both terms of both scores are in log space (or a fraction), so they are
scale-free and directly comparable, which is why they can simply be
added. In neither mode is the scoring a heuristic bolted on top of the
packing; it IS the packing.

Worked example, five square images in FILL mode. `[3, 2]` scores 0.58
and wins: three across the top, two below -- the layout a person would
draw. A single row of five scores 1.61 (a ribbon), five stacked rows
score 1.61 (a column), and `[2, 2, 1]` scores 1.25 (the lone image on
the bottom row is 4x the others).

Deliberately kept free of torch, PIL and ComfyUI imports: the node uses
it to compose, `web/compose_images.js` mirrors it to draw the live
preview, and the test suite cross-checks the two against each other.
"""

import math

# Packing compares sums of pixel counts, where a float wobble is many
# orders of magnitude below one pixel.
EPS = 1e-9


# Canvas sides are rounded to a multiple of this. 16 rather than 8: it
# is what every latent path downstream (VAE stride 8, patch 2) actually
# wants, and it divides 8 for anything that only needs that.
ALIGN = 16

# Named target shapes for the canvas. "auto" is not a shape: it is None,
# and means "no target -- fit them as tightly as they will go, within
# PACK_ASPECT_MIN..MAX". See _pack_sweep.
TARGET_ASPECTS = {
    "auto": None,
    "1:1": 1.0,
    "4:3": 4.0 / 3.0,
    "3:4": 3.0 / 4.0,
    "3:2": 3.0 / 2.0,
    "2:3": 2.0 / 3.0,
    "16:9": 16.0 / 9.0,
    "9:16": 9.0 / 16.0,
}

# Above this many images, enumerating every row-break combination
# (2^(n-1)) stops being free, so a balanced partition per row count is
# used instead. 12 -> 2048 candidates, which is nothing.
EXHAUSTIVE_LIMIT = 12

# Row counts considered when the exhaustive path is skipped.
MAX_ROWS = 24

BACKGROUNDS = {"black": 0.0, "grey": 0.5, "white": 1.0}

# "natural" keeps the sources' relative pixel sizes and never enlarges;
# "fill" scales every image to its slot so the sheet has no dead space.
SIZINGS = ("natural", "fill")

# How hard the natural layout works to avoid dead space, against how hard
# it works to hit the target shape. The waste term is a fraction in
# [0, 1) and the aspect term is |ln ratio| (coming out twice as wide as
# asked for = 0.69), so a weight of 2 makes a third of the sheet going to
# waste cost about the same as missing the shape by 2x.
WASTE_WEIGHT = 2.0

# Natural mode packs; these govern how hard it looks.
#
# A sheet may not become a ribbon, so `auto` maximises the fill INSIDE a
# band of sane shapes rather than trading shape against fill with a
# weight. The band is the only arbitrary number in the packer, and it is
# arbitrary in a way anyone can see and argue with, which a weight is
# not.
PACK_ASPECT_MIN = 0.45
PACK_ASPECT_MAX = 2.2

# Candidate sheet widths, swept from "as wide as the widest image" to
# "everything in one row". 48 is well past where more steps stop changing
# the answer on real inputs.
PACK_WIDTH_STEPS = 48

# The layer order is something the USER SET -- they can drag to reorder
# -- so a sorted placement order has to earn the right to override it.
# Three points of fill.
PACK_ORDER_MARGIN = 0.03


def _compositions(n):
    """Every way to cut a sequence of n items into contiguous rows.

    Yielded as row LENGTHS, e.g. n=3 -> [3], [2,1], [1,2], [1,1,1].
    There are 2^(n-1) of them: one binary choice per gap between items.
    """
    for bits in range(1 << (n - 1)):
        rows = []
        run = 1
        for i in range(n - 1):
            if bits & (1 << i):
                rows.append(run)
                run = 1
            else:
                run += 1
        rows.append(run)
        yield rows


def _balanced(aspects, rows):
    """Split into `rows` contiguous groups with the most even aspect sums.

    Used instead of full enumeration once the item count makes that
    expensive. Classic O(n^2 * rows) partition DP minimising the sum of
    squared deviations of each group's aspect sum from the ideal share --
    the same quantity the scorer cares about, approached greedily.
    """
    n = len(aspects)
    if rows >= n:
        return [1] * n
    prefix = [0.0]
    for a in aspects:
        prefix.append(prefix[-1] + a)
    ideal = prefix[n] / rows

    # best[i][r] = cost of splitting the first i items into r groups.
    inf = float("inf")
    best = [[inf] * (rows + 1) for _ in range(n + 1)]
    cut = [[0] * (rows + 1) for _ in range(n + 1)]
    best[0][0] = 0.0
    for r in range(1, rows + 1):
        for i in range(r, n - (rows - r) + 1):
            for j in range(r - 1, i):
                if best[j][r - 1] == inf:
                    continue
                dev = prefix[i] - prefix[j] - ideal
                cost = best[j][r - 1] + dev * dev
                if cost < best[i][r]:
                    best[i][r] = cost
                    cut[i][r] = j
    out = []
    i, r = n, rows
    while r > 0:
        j = cut[i][r]
        out.append(i - j)
        i, r = j, r - 1
    out.reverse()
    return out


def _candidates(aspects):
    n = len(aspects)
    if n <= EXHAUSTIVE_LIMIT:
        return list(_compositions(n))
    return [_balanced(aspects, r) for r in range(1, min(n, MAX_ROWS) + 1)]


def _geometry(aspects, rows, budget, gap):
    """Solve a row split for its exact canvas size. None if impossible.

    With canvas width W, a row of k items whose aspects sum to S has
    content width W - gap*(k-1), so every item in it is
    (W - gap*(k-1)) / S tall. Stacking the rows and adding the gaps
    between them makes total height a straight line in W:

        H = c1*W + c0        c1 = sum(1/S_r)
                             c0 = gap*(rows-1) - gap*sum((k_r-1)/S_r)

    Filling the budget exactly is then W*H = budget, i.e. the quadratic
    c1*W^2 + c0*W - budget = 0 -- one positive root, no iteration.
    """
    sums = []
    idx = 0
    for k in rows:
        s = sum(aspects[idx:idx + k])
        if s <= 0:
            return None
        sums.append((k, s))
        idx += k

    c1 = sum(1.0 / s for _, s in sums)
    c0 = gap * (len(rows) - 1) - gap * sum((k - 1) / s for k, s in sums)
    disc = c0 * c0 + 4.0 * c1 * budget
    w = (-c0 + math.sqrt(disc)) / (2.0 * c1)
    h = c1 * w + c0
    if w <= 0 or h <= 0:
        return None

    heights = []
    for k, s in sums:
        row_h = (w - gap * (k - 1)) / s
        if row_h <= 0:
            return None
        heights.append(row_h)
    return w, h, heights


def _score(aspects, rows, heights, width, height, target):
    """Aspect deviation plus area imbalance, both in log space."""
    areas = []
    idx = 0
    for k, row_h in zip(rows, heights):
        for a in aspects[idx:idx + k]:
            areas.append(a * row_h * row_h)
        idx += k

    logs = [math.log(a) for a in areas]
    mean = sum(logs) / len(logs)
    var = sum((v - mean) ** 2 for v in logs) / len(logs)
    return abs(math.log((width / height) / target)) + math.sqrt(var)


def _key(score, rows):
    """Rank a split: one score, then its SHAPE.

    Ties are not rare -- [2,3] and [3,2] are mirror images and score
    identically, and so do [3,3,1] and [3,1,3]. Comparing the row
    lengths negated and in order puts the full rows first and the short
    one last, which is how a contact sheet is read; without it the
    winner falls out of enumeration order and a lone image can end up
    stranded in the middle of the sheet.
    """
    return ((int(math.floor(score * 1e9 + 0.5)),)
            + tuple(-k for k in rows))


def _align_down(v, align):
    return max(align, int(v // align) * align)


def _align_up(v, align):
    return max(align, int(math.ceil(v / float(align))) * align)


def _align_near(v, align):
    # floor(x + 0.5), not round(): Python rounds halves to EVEN and
    # JavaScript rounds them up, and web/compose_images.js has to
    # reproduce these numbers exactly to preview the real layout.
    return max(align, int(math.floor(v / align + 0.5)) * align)


def _q(v):
    """Quantise a score for comparison. floor(x + 0.5), never round().

    Python rounds halves to even and JavaScript rounds them up, and
    web/compose_images.js has to pick the SAME packing out of a sweep of
    near-identical candidates.
    """
    return int(math.floor(v * 1e9 + 0.5))


def _skyline_pack(sizes, width, gap):
    """Place rectangles bottom-left into a strip `width` wide.

    Returns (placements, w0, h0) in source pixels, or None if anything
    will not fit. Placements are (x, y, w, h), in the order given.

    NOTHING IS EVER ROTATED. A rotated reference is a wrong reference --
    the point of the sheet is that a model reads what is in it -- so a
    quarter turn is not the free win here that it is in a texture atlas,
    and it is not attempted at any point.

    The skyline is the profile of what has been placed: (x, width, y)
    segments, left to right, no gaps between them. Each rectangle goes at
    the lowest y where it fits, leftmost to break ties, which is what
    lets a small image tuck into the space beside a tall one instead of
    starting a new row underneath it. That one behaviour is the
    difference between 69% and 87% mean fill.
    """
    sky = [(0.0, width, 0.0)]
    placed = []
    for w, h in sizes:
        iw = w + gap
        ih = h + gap
        if iw > width + EPS:
            return None
        best = None
        for i in range(len(sky)):
            start = sky[i][0]
            if start + iw > width + EPS:
                continue
            # the highest skyline anywhere under this span
            y = 0.0
            span = iw
            j = i
            while span > EPS and j < len(sky):
                if sky[j][2] > y:
                    y = sky[j][2]
                span -= sky[j][1]
                j += 1
            if span > EPS:
                continue            # ran off the right-hand end
            if best is None or (y, start) < best:
                best = (y, start)
        if best is None:
            return None
        y, x = best
        placed.append((x, y, w, h))

        # Cut the covered span out of the skyline, lay the new top over
        # it, then merge neighbours at the same height so the list cannot
        # grow without bound.
        cut = []
        end = x + iw
        for sx, sw, sy in sky:
            if sx + sw <= x + EPS or sx >= end - EPS:
                cut.append((sx, sw, sy))
                continue
            if sx < x:
                cut.append((sx, x - sx, sy))
            if sx + sw > end:
                cut.append((end, sx + sw - end, sy))
        cut.append((x, iw, y + ih))
        cut.sort(key=lambda seg: seg[0])
        merged = []
        for seg in cut:
            if merged and abs(merged[-1][2] - seg[2]) < EPS:
                merged[-1] = (merged[-1][0], merged[-1][1] + seg[1], seg[2])
            else:
                merged.append(seg)
        sky = merged

    w0 = max(p[0] + p[2] for p in placed)
    h0 = max(p[1] + p[3] for p in placed)
    return placed, w0, h0


def _pack_orders(sizes):
    """Placement orders to try, the user's own first.

    Descending height is the classic packing heuristic and usually wins,
    but the layer order is something the user set on purpose, so it goes
    first and is only displaced by PACK_ORDER_MARGIN. Every sort ends in
    the index, so all of them are stable.
    """
    n = range(len(sizes))
    return [
        ("given", list(n)),
        ("tallest first", sorted(n, key=lambda i: (-sizes[i][1], i))),
        ("widest first", sorted(n, key=lambda i: (-sizes[i][0], i))),
        ("largest first",
         sorted(n, key=lambda i: (-sizes[i][0] * sizes[i][1], i))),
    ]


def _pack_sweep(sizes, gap, target, band):
    """The best packing each placement order can manage.

    One entry per order that produced anything at all:
    (key, fill, placed, w0, h0, order, name).
    """
    used = sum(w * h for w, h in sizes)
    lo = max(w for w, h in sizes) + gap
    hi = sum(w for w, h in sizes) + gap * len(sizes)
    out = []
    for name, order in _pack_orders(sizes):
        ordered = [sizes[i] for i in order]
        found = None
        for step in range(PACK_WIDTH_STEPS):
            width = lo + (hi - lo) * step / (PACK_WIDTH_STEPS - 1)
            got = _skyline_pack(ordered, width, gap)
            if got is None:
                continue
            placed, w0, h0 = got
            fill = used / float(w0 * h0)
            aspect = w0 / h0
            if band and not PACK_ASPECT_MIN <= aspect <= PACK_ASPECT_MAX:
                continue
            if target is None:
                # As tight as it goes, within a shape that is not a
                # ribbon. Ties (equal fill, mirror-image aspects) go to
                # the squarer sheet, then to the wider one.
                key = (-_q(fill), _q(abs(math.log(aspect))), -_q(aspect))
            else:
                key = (_q(abs(math.log(aspect / target))
                          + WASTE_WEIGHT * (1.0 - fill)),)
            if found is None or key < found[0]:
                found = (key, fill, placed, w0, h0, order, name)
        if found is not None:
            out.append(found)
    return out


def _q(v):
    """Quantise a score for comparison. floor(x + 0.5), never round().

    Python rounds halves to even and JavaScript rounds them up, and
    web/compose_images.js has to pick the SAME packing out of a sweep of
    near-identical candidates.
    """
    return int(math.floor(v * 1e9 + 0.5))


def _skyline_pack(sizes, width, gap):
    """Place rectangles bottom-left into a strip `width` wide.

    Returns (placements, w0, h0) in source pixels, or None if anything
    will not fit. Placements are (x, y, w, h), in the order given.

    NOTHING IS EVER ROTATED. A rotated reference is a wrong reference --
    the point of the sheet is that a model reads what is in it -- so a
    quarter turn is not the free win here that it is in a texture atlas,
    and it is not attempted at any point.

    The skyline is the profile of what has been placed: (x, width, y)
    segments, left to right, no gaps between them. Each rectangle goes at
    the lowest y where it fits, leftmost to break ties, which is what
    lets a small image tuck into the space beside a tall one instead of
    starting a new row underneath it. That one behaviour is the
    difference between 69% and 87% mean fill.
    """
    sky = [(0.0, width, 0.0)]
    placed = []
    for w, h in sizes:
        iw = w + gap
        ih = h + gap
        if iw > width + EPS:
            return None
        best = None
        for i in range(len(sky)):
            start = sky[i][0]
            if start + iw > width + EPS:
                continue
            # the highest skyline anywhere under this span
            y = 0.0
            span = iw
            j = i
            while span > EPS and j < len(sky):
                if sky[j][2] > y:
                    y = sky[j][2]
                span -= sky[j][1]
                j += 1
            if span > EPS:
                continue            # ran off the right-hand end
            if best is None or (y, start) < best:
                best = (y, start)
        if best is None:
            return None
        y, x = best
        placed.append((x, y, w, h))

        # Cut the covered span out of the skyline, lay the new top over
        # it, then merge neighbours at the same height so the list cannot
        # grow without bound.
        cut = []
        end = x + iw
        for sx, sw, sy in sky:
            if sx + sw <= x + EPS or sx >= end - EPS:
                cut.append((sx, sw, sy))
                continue
            if sx < x:
                cut.append((sx, x - sx, sy))
            if sx + sw > end:
                cut.append((end, sx + sw - end, sy))
        cut.append((x, iw, y + ih))
        cut.sort(key=lambda seg: seg[0])
        merged = []
        for seg in cut:
            if merged and abs(merged[-1][2] - seg[2]) < EPS:
                merged[-1] = (merged[-1][0], merged[-1][1] + seg[1], seg[2])
            else:
                merged.append(seg)
        sky = merged

    w0 = max(p[0] + p[2] for p in placed)
    h0 = max(p[1] + p[3] for p in placed)
    return placed, w0, h0


def _pack_orders(sizes):
    """Placement orders to try, the user's own first.

    Descending height is the classic packing heuristic and usually wins,
    but the layer order is something the user set on purpose, so it goes
    first and is only displaced by PACK_ORDER_MARGIN. Every sort ends in
    the index, so all of them are stable.
    """
    n = range(len(sizes))
    return [
        ("given", list(n)),
        ("tallest first", sorted(n, key=lambda i: (-sizes[i][1], i))),
        ("widest first", sorted(n, key=lambda i: (-sizes[i][0], i))),
        ("largest first",
         sorted(n, key=lambda i: (-sizes[i][0] * sizes[i][1], i))),
    ]


def _pack_sweep(sizes, gap, target, band):
    """The best packing each placement order can manage.

    One entry per order that produced anything at all:
    (key, fill, placed, w0, h0, order, name).
    """
    used = sum(w * h for w, h in sizes)
    lo = max(w for w, h in sizes) + gap
    hi = sum(w for w, h in sizes) + gap * len(sizes)
    out = []
    for name, order in _pack_orders(sizes):
        ordered = [sizes[i] for i in order]
        found = None
        for step in range(PACK_WIDTH_STEPS):
            width = lo + (hi - lo) * step / (PACK_WIDTH_STEPS - 1)
            got = _skyline_pack(ordered, width, gap)
            if got is None:
                continue
            placed, w0, h0 = got
            fill = used / float(w0 * h0)
            aspect = w0 / h0
            if band and not PACK_ASPECT_MIN <= aspect <= PACK_ASPECT_MAX:
                continue
            if target is None:
                # As tight as it goes, within a shape that is not a
                # ribbon. Ties (equal fill, mirror-image aspects) go to
                # the squarer sheet, then to the wider one.
                key = (-_q(fill), _q(abs(math.log(aspect))), -_q(aspect))
            else:
                key = (_q(abs(math.log(aspect / target))
                          + WASTE_WEIGHT * (1.0 - fill)),)
            if found is None or key < found[0]:
                found = (key, fill, placed, w0, h0, order, name)
        if found is not None:
            out.append(found)
    return out


def _natural_geometry(sizes, rows, gap):
    """Row extents at SOURCE pixel size, or None if degenerate.

    Each image keeps the pixels it actually has, so a row is as tall as
    its tallest member and as wide as its members laid side by side --
    and the sheet is as wide as its widest row.
    """
    row_w, row_h = [], []
    idx = 0
    for k in rows:
        group = sizes[idx:idx + k]
        row_w.append(sum(g[0] for g in group) + gap * (k - 1))
        row_h.append(max(g[1] for g in group))
        idx += k
    w0 = max(row_w)
    h0 = sum(row_h) + gap * (len(rows) - 1)
    if w0 <= 0 or h0 <= 0:
        return None
    return w0, h0, row_w, row_h


def _natural_score(sizes, rows, w0, h0, row_w, row_h, gap, target):
    """How bad this split is. Lower is better.

    Dead space is space that is neither an image nor a gap that was asked
    for. Counting the requested gaps as USED is what stops a larger `gap`
    quietly steering the layout towards fewer columns to hide them.

    With a TARGET SHAPE the score trades missing that shape against dead
    space, weighted by WASTE_WEIGHT.

    With `auto` (target None) there is no shape to miss, and the score
    becomes the dead fraction of the smallest SQUARE that would hold the
    sheet. Measuring against the square rather than against the sheet's
    own box is the whole trick, and it is not a fudge -- a bare "least
    dead space" cannot answer the question at all. Five identical images
    in one row waste NOTHING (every row is one image tall and they are
    all the same height), and so does a single column, while the compact
    3+2 wastes 17%: literal waste-minimisation therefore returns a 5:1
    ribbon, every time, for the most ordinary input this node has. The
    enclosing square asks the useful question instead -- how much of the
    space you would need to HOLD this sheet is actually image -- and it
    answers it with one number and no weight to tune.
    """
    used = sum(w * h for w, h in sizes)
    for r, k in enumerate(rows):
        used += gap * (k - 1) * row_h[r]
    used += gap * (len(rows) - 1) * w0
    waste = max(0.0, 1.0 - used / float(w0 * h0))
    if target is None:
        # Two measurements, ranked, the first one to a TOLERANCE. The
        # square answers "how tight is this overall"; the box then
        # decides between everything the square found equally tight --
        # both the ties it genuinely cannot see (four portraits as 3+1
        # and as 2+2 need the same 3840 square, but the 2+2 box wastes
        # nothing while the 3+1 box wastes a third) and the differences
        # too small to be worth a sheet with more background in it.
        # Ranked rather than blended: no weight to argue about.
        side = max(w0, h0)
        return (max(0.0, 1.0 - used / float(side * side)), waste)
    return (abs(math.log((w0 / h0) / target)) + WASTE_WEIGHT * waste, 0.0)


def _box(x, y, w, h, width, height):
    """One integer box: SIZE rounded once, position rounded and clamped.

    The SIZE is rounded directly, never derived from rounded endpoints.
    Endpoint rounding (floor(x+w+.5) - floor(x+.5)) made a box's integer
    size depend on the fractional part of its POSITION: two identical
    620x620 crops came out 617x617 and 617x616 in one sheet
    (2026-09-01), and a square quietly breaking its own shape defeats
    the per-layer aspect lock. Rounding the size keeps equal sources
    equal and squares square; the cost is that a flush (gap 0) seam can
    drift by one pixel of background or overlap, which reads far less
    than a wrong size. (The FILL mode keeps endpoint rounding: its
    justified rows must tile exactly, and it scales images to slots
    anyway.)

    The `max(1, ...)` floor can make two boxes share a pixel when a layer
    is scaled below one pixel across -- measured at three 1-pixel
    overlaps in 3200 random plans, all of them an 18x8 source at scale
    0.014. A layer one pixel wide sitting on its neighbour is a better
    answer than a layer zero pixels wide that nobody can see.
    """
    bw = max(1, min(width, int(math.floor(w + 0.5))))
    bh = max(1, min(height, int(math.floor(h + 0.5))))
    x0 = max(0, min(width - bw, int(math.floor(x + 0.5))))
    y0 = max(0, min(height - bh, int(math.floor(y + 0.5))))
    return (x0, y0, bw, bh)


def _plan_natural(sizes, budget, target, gap, align):
    """One scale for every image, never above 1, packed rather than
    shelved. See the module docstring for the mode, _skyline_pack for the
    packing, and note that nothing is ever rotated."""
    found = _pack_sweep(sizes, gap, target, band=target is None)
    if not found and target is None:
        # Nothing landed inside the aspect band -- one extreme panorama
        # can do it. A sheet of some shape beats no sheet at all.
        found = _pack_sweep(sizes, gap, target, band=False)
    if not found:
        return None

    # The user's own layer order is the default answer; another ordering
    # takes it only by packing PACK_ORDER_MARGIN tighter.
    best = next((r for r in found if r[6] == "given"), found[0])
    for other in found:
        if other[0] < best[0] and other[1] > best[1] + PACK_ORDER_MARGIN:
            best = other
    _, fill, placed, w0, h0, order, order_name = best

    # The one scale factor, capped at 1: this is the whole point of the
    # mode. Above 1 it would be enlarging pixels that do not exist.
    s_exact = min(1.0, math.sqrt(budget / float(w0 * h0)))
    if s_exact >= 1.0 and _align_up(w0, align) * _align_up(h0, align)             <= budget:
        # The budget is not binding: align the canvas UP and pad with
        # background instead of shrinking pixels. Aligning down here
        # scaled every layer by up to 15/width -- a 620x620 crop came
        # out 617x617 under a budget it fit with room to spare
        # (2026-09-01), and "full size" was unreachable off-alignment.
        width = _align_up(w0, align)
        height = _align_up(h0, align)
        scale = 1.0
    else:
        width = _align_down(s_exact * w0, align)
        height = _align_near(h0 * width / float(w0), align)
        # Alignment has a floor of one step, so on a very small sheet
        # the canvas can come out LARGER than the content asked for --
        # clamp again or that floor would enlarge the images after all.
        scale = min(width / float(w0), height / float(h0), 1.0)

    ox = (width - w0 * scale) / 2.0
    oy = (height - h0 * scale) / 2.0
    boxes = [None] * len(sizes)
    for slot, (x, y, w, h) in zip(order, placed):
        boxes[slot] = _box(ox + x * scale, oy + y * scale,
                           w * scale, h * scale, width, height)

    # The fill REPORTED is the one the caller can see: integer boxes
    # against the aligned canvas. The packing fill above is in source
    # pixels and differs by the alignment margin, which on a small sheet
    # is a large fraction -- reporting that one would be telling the user
    # about a sheet they are not getting.
    covered = sum(b[2] * b[3] for b in boxes)
    return {"width": width, "height": height, "rows": None, "boxes": boxes,
            "scale": scale, "fill": covered / float(width * height),
            "order": order_name}


def _plan_fill(aspects, budget, target, gap, align):
    """Justified rows: every row edge to edge. See the module docstring."""
    if target is None:
        # `auto` means "least dead space", and fill mode HAS no dead
        # space -- every row is full by construction, so the criterion
        # cannot separate a ribbon from a grid. What is left of it is the
        # part that still applies: the tightest sheet is the squarest
        # one. (Minimising the dead fraction of the enclosing square is
        # monotone in |ln aspect|, so this IS that criterion here, not a
        # substitute for it.)
        target = 1.0
    best = None
    for rows in _candidates(aspects):
        geom = _geometry(aspects, rows, budget, gap)
        if geom is None:
            continue
        w, h, heights = geom
        score = _score(aspects, rows, heights, w, h, target)
        key = _key(score, rows)
        if best is None or key < best[0]:
            best = (key, rows, w, h, heights)
    if best is None:
        # Every split was degenerate (a gap wider than the budget can
        # carry). Fall back to one row with no gap at all.
        rows = [len(aspects)]
        w, h, heights = _geometry(aspects, rows, budget, 0)
        gap = 0
        best = (_key(0.0, rows), rows, w, h, heights)

    _, rows, w_exact, h_exact, heights = best

    width = _align_down(w_exact, align)
    # Height rounds to NEAREST: flooring both sides compounds into a
    # visible band, and the overshoot is under half an alignment step.
    height = _align_near(h_exact * (width / w_exact), align)

    # Re-solve the content at the final integer width, then shrink it if
    # the rounded canvas came out shorter than the content needs.
    row_heights = []
    idx = 0
    for k in rows:
        s = sum(aspects[idx:idx + k])
        row_heights.append((width - gap * (k - 1)) / s)
        idx += k
    content_h = sum(row_heights) + gap * (len(rows) - 1)
    scale = min(1.0, height / content_h) if content_h > 0 else 1.0
    content_w = width * scale
    content_h *= scale

    ox = (width - content_w) / 2.0
    oy = (height - content_h) / 2.0

    boxes = []
    idx = 0
    y = oy
    for r, k in enumerate(rows):
        row_h = row_heights[r] * scale
        # Cumulative edges, rounded once: adjacent boxes then share an
        # edge exactly instead of each rounding its own size and leaving
        # a one-pixel seam between them.
        y0 = int(math.floor(y + 0.5))
        y1 = int(math.floor(y + row_h + 0.5))
        x = ox
        for a in aspects[idx:idx + k]:
            item_w = a * row_h
            x0 = int(math.floor(x + 0.5))
            x1 = int(math.floor(x + item_w + 0.5))
            boxes.append((x0, y0, max(1, x1 - x0), max(1, y1 - y0)))
            x += item_w + gap * scale
        y += row_h + gap * scale
        idx += k

    used = sum(b[2] * b[3] for b in boxes)
    return {"width": width, "height": height, "rows": rows, "boxes": boxes,
            "scale": None, "fill": used / float(width * height),
            "order": "given"}


def plan(sizes, max_megapixels, target_aspect="auto", gap=0, align=ALIGN,
         sizing="natural"):
    """Lay `sizes` (each a (width, height) in source pixels) out on one sheet.

    Returns {"width", "height", "rows", "boxes", "scale"} where boxes are
    integer (x, y, w, h) in canvas pixels, in the same order as `sizes`,
    or None for an empty list. `scale` is the single factor applied to
    every image in natural mode, and None in fill mode, where each image
    gets its own.

    The canvas sides are rounded to `align`, so the result can land up to
    one alignment step either side of the exact budget. The laid-out
    content is then scaled to fit whatever the rounding left and centred:
    aspect ratios stay exact, and the cost is at most `align` pixels of
    background on each axis rather than a stretch nobody asked for.
    """
    pairs = []
    for item in sizes or []:
        try:
            w = float(item[0])
            h = float(item[1])
        except (TypeError, ValueError, IndexError, KeyError):
            continue
        if w > 0 and h > 0:
            pairs.append((w, h))
    if not pairs:
        return None

    # 0 (or less) is "no cap". Natural mode then simply never shrinks:
    # an infinite budget makes the shared scale exactly 1. Fill mode has
    # to fill SOMETHING, so with no cap it fills a sheet of the sources'
    # own area -- the pixels that exist, no more.
    try:
        mp = float(max_megapixels)
    except (TypeError, ValueError):
        mp = 0.0
    if mp > 0:
        budget = max(1.0, mp * 1024.0 * 1024.0)
    elif sizing == "fill":
        budget = max(1.0, sum(w * h for w, h in pairs))
    else:
        budget = math.inf
    gap = max(0, int(gap))
    # None is a VALUE here ("auto"), not a missing key -- so membership
    # is the test, and an unreadable name falls through to auto rather
    # than to a shape nobody asked for.
    if target_aspect in TARGET_ASPECTS:
        target = TARGET_ASPECTS[target_aspect]
    else:
        try:
            target = float(target_aspect)
        except (TypeError, ValueError):
            target = None
    if target is not None and target <= 0:
        target = None

    if sizing == "fill":
        return _plan_fill([w / h for w, h in pairs], budget, target, gap,
                          align)
    return _plan_natural(pairs, budget, target, gap, align)
