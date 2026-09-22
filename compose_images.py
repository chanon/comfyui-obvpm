"""Load Images & Compose: several input images, cropped, onto one sheet.

One node that replaces a stack of Load Image + crop + image-stitch nodes
when what you actually want is a single reference frame built out of
several pictures -- H3's reference input takes one image, so getting a
character, a location and a prop in front of the model means putting
them in the same frame.

Layers live in the hidden `layers` widget as JSON, managed entirely by
the editor in `web/compose_images.js`:

    [{"image": "refs/face.png", "crop": {"x":0.1,"y":0,"w":0.5,"h":0.8}},
     {"image": "car.jpg"}]

An absent or null `crop` means the whole image. The coordinates are
normalised exactly like Load Image & Crop's, and both nodes share
`_parse_crop`, so a crop means the same thing in both places.

The layout itself is `compose_layout.plan` -- see that module for why
the row breaks are chosen the way they are.
"""

import json

import numpy as np
import torch
from PIL import ImageOps

import folder_paths
import node_helpers

from .image_safety import (MAX_LAYERS, bounded_text, image_path, inspect_images,
                           hash_images, finite_number, check_pixels, open_checked_image)
from . import compose_layout
from .load_image_crop import (_input_images, _parse_crop,
                              _aspect_value, _centered_box)


def _parse_layers(layers):
    """The layers widget's JSON -> [(image_path, crop_json_or_None,
    aspect_or_None)].

    Tolerant on purpose: this string is written by the frontend, and a
    node that raises on a half-written value is a node that cannot be
    recovered from by editing the widget.
    """
    bounded_text(layers or "[]", what="Layers JSON")
    try:
        data = json.loads(layers) if layers else []
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    if len(data) > MAX_LAYERS:
        raise ValueError("Load Images & Compose: at most 64 layers are allowed")
    out = []
    for entry in data:
        if isinstance(entry, str):
            out.append((entry, None, None))
            continue
        if not isinstance(entry, dict):
            continue
        name = entry.get("image")
        if not name:
            continue
        if not isinstance(name, str):
            raise ValueError("Layer image must be a filename string")
        crop = entry.get("crop")
        aspect = entry.get("aspect")
        out.append((name,
                    json.dumps(crop) if isinstance(crop, dict) else None,
                    aspect if _aspect_value(aspect) is not None else None))
    return out


def _load_layer(name, crop, aspect=None):
    """One layer as a float RGB tensor (h, w, 3), already cropped.

    `aspect` is the layer's shape lock, same policy as Load Image &
    Crop: no crop means the largest centered cut of that ratio, and a
    stored crop that disagrees refuses naming the layer rather than
    being silently reshaped.
    """
    path = image_path(name)
    with open_checked_image(path) as img:
        check_pixels(*img.size)
        img = node_helpers.pillow(ImageOps.exif_transpose, img)
        frame = img.convert("RGB")
    pixels = torch.from_numpy(np.array(frame).astype(np.float32) / 255.0)

    box = _parse_crop(crop, pixels.shape[1], pixels.shape[0])
    ratio = _aspect_value(aspect)
    if ratio is not None:
        if box is None:
            box = _centered_box(pixels.shape[1], pixels.shape[0], ratio)
        else:
            bw, bh = box[2] - box[0], box[3] - box[1]
            if abs(bw - ratio * bh) > 2.0 * (1.0 + ratio):
                raise ValueError(
                    "Load Images & Compose: layer %r has a %dx%d crop, "
                    "which is not %s. Redraw its crop with the aspect "
                    "set, or switch that layer back to 'free'."
                    % (name, bw, bh, aspect))
    if box is not None:
        x0, y0, x1, y1 = box
        pixels = pixels[y0:y1, x0:x1, :]
    return pixels


class LoadImagesCompose:
    CATEGORY = "obvpm/image"
    FUNCTION = "compose"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    DESCRIPTION = (
        "Loads several input images as a stack of layers, each with its "
        "own crop, and composes them into ONE image that fits the given "
        "megapixel budget. The layout is chosen automatically: images "
        "keep their order and their exact aspect ratio, rows are filled "
        "edge to edge, and the row breaks are picked so the sheet comes "
        "out as tightly packed as it can. The layers keep their "
        "relative pixel sizes and are never enlarged, so a small crop "
        "stays small instead of being stretched into space a larger one "
        "could have used, and nothing is ever rotated. Add images with "
        "the + button or by dropping them on the node; click one in the "
        "list to crop it."
    )

    OUTPUT_TOOLTIPS = (
        "The composed sheet, one image containing every layer -- or None "
        "when the node holds no images, so an unused one can stay in the "
        "workflow.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "layers": ("STRING", {
                    "default": "[]",
                    "tooltip": "Managed by the layer editor on the node — no need to edit by hand.",
                }),
                "max_megapixels": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 128.0, "step": 0.01,
                    "tooltip": "Largest the composed image may be (1.0 = 1024x1024 pixels). A CAP, not a target: every layer is scaled by one shared factor and none is ever enlarged, so a sheet of small images comes out small rather than being blown up to fill this. 0 = no cap: every layer at its own size (in fill sizing, a sheet of the sources' total area). Sides are rounded to a multiple of 16.",
                }),
                "gap": ("INT", {
                    "default": 0, "min": 0, "max": 256, "step": 2,
                    "tooltip": "Pixels of background between layers. 0 puts them flush against each other; a few pixels helps a model tell one reference from the next.",
                }),
                "background": (list(compose_layout.BACKGROUNDS), {
                    "default": "black",
                    "tooltip": "Colour behind the layers — seen in the gaps, and in the up-to-16-pixel margin left by rounding.",
                }),
            }
        }

    # target_aspect and sizing are no longer widgets: the alternatives
    # (a named sheet shape, and the justified-rows "fill" layout) both
    # waste pixels for no gain, so the node stopped offering the choice.
    # They stay as ARGUMENTS rather than being inlined, because
    # compose_layout still implements both and its tests still cover
    # both -- a caller with a reason can pass them, and the defaults here
    # are the single place the node's answer is written down.
    #
    # The JS mirror reads them through widgetValue(name, fallback), which
    # returns these same defaults when the widget is absent;
    # test_compose_plan.mjs checks the two agree.
    def compose(self, layers, max_megapixels=1.0, target_aspect="auto",
                gap=0, background="black", sizing="natural"):
        items = _parse_layers(layers)
        if not items:
            # No images is not an error: an empty node passes None on, the
            # same as an unconnected optional input, so a spare Picture
            # slot can sit in a workflow without being bypassed by hand.
            # (Every consumer here already takes None: Bundle unpacks a
            # missing field as None and the H3 reference node skips it.)
            return (None,)

        max_megapixels = finite_number(max_megapixels, "max_megapixels", 0, 128)
        gap = int(finite_number(gap, "gap", 0, 256))
        if not isinstance(target_aspect, (str, int, float)):
            raise ValueError("target_aspect must be a named aspect or finite ratio")
        if target_aspect not in compose_layout.TARGET_ASPECTS:
            finite_number(target_aspect, "target_aspect", 1 / 16384, 16384)
        for _name, crop, aspect in items:
            _parse_crop(crop, 1, 1)
        inspect_images([name for name, _crop, _aspect in items])
        tiles = [_load_layer(name, crop, aspect)
                 for name, crop, aspect in items]
        # (width, height) in SOURCE pixels, after the crop -- natural
        # sizing needs the real sizes, not just the aspect ratios.
        sizes = [(t.shape[1], t.shape[0]) for t in tiles]
        layout = compose_layout.plan(
            sizes, max_megapixels, target_aspect, gap,
            sizing=sizing)

        width, height = layout["width"], layout["height"]
        check_pixels(width, height, canvas=True)
        fill = compose_layout.BACKGROUNDS.get(background, 0.0)
        canvas = torch.full((1, height, width, 3), fill, dtype=torch.float32)

        import comfy.utils

        for tile, (x, y, w, h) in zip(tiles, layout["boxes"]):
            # common_upscale wants BCHW; lanczos both ways (a slot can be
            # larger than its source when one layer is much smaller than
            # the rest -- the layout fills its row either way).
            scaled = comfy.utils.common_upscale(
                tile.unsqueeze(0).movedim(-1, 1), w, h, "lanczos", "disabled"
            ).movedim(1, -1)
            canvas[:, y:y + h, x:x + w, :] = scaled.clamp(0.0, 1.0)

        return (canvas,)

    @classmethod
    def IS_CHANGED(cls, layers, **_):
        items = _parse_layers(layers)
        return hash_images([name for name, _crop, _aspect in items],
                           (layers or "[]").encode("utf-8"))

    @classmethod
    def VALIDATE_INPUTS(cls, layers, **_):
        try:
            for name, crop, aspect in _parse_layers(layers):
                image_path(name)
                _parse_crop(crop, 1, 1)
        except (ValueError, OSError) as exc:
            return str(exc)
        return True


def _register_routes():
    """GET /obvpm/input_images -> {"files": [...]} for the layer picker.

    The editor needs a LIVE list of the input folder (a combo widget's
    values are a page-load snapshot, so anything uploaded since would be
    missing), and this node has no combo to re-read via /object_info.
    One tiny read-only route is cheaper than giving the node a widget it
    does not otherwise want.
    """
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/obvpm/input_images")
    async def _input_image_list(_request):
        files = folder_paths.filter_files_content_types(
            _input_images(), ["image"])
        return web.json_response({"files": files})


try:
    _register_routes()
except Exception:  # headless/test runs have no PromptServer
    import logging
    logging.getLogger("obvpm").debug(
        "obvpm: /obvpm/input_images not registered", exc_info=True)
