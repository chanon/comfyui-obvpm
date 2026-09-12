"""Load Image & Crop: LoadImage plus an interactive crop rectangle.

The frontend (web/load_image_crop.js) shows the picked image on the node
and lets the user drag/resize a crop area. The selection is stored in the
hidden "crop" string widget as JSON with normalized coordinates
{"x":0..1,"y":0..1,"w":0..1,"h":0..1}. Empty string means no crop.
"""

import json
import os
import math

import numpy as np
import torch
from PIL import ImageOps

import folder_paths
import node_helpers

from .image_safety import (image_path, inspect_images, hash_images, bounded_text,
                           finite_number, check_pixels, open_checked_image)


def _input_images():
    """Every file under the input directory, as input-relative paths.

    Core's LoadImage lists the input folder FLAT (os.listdir), so images
    filed in subfolders are invisible to it -- and a folder per project
    is the obvious way to keep a few hundred references straight. This
    walks instead, and returns paths in the form the rest of the stack
    already understands: relative to the input dir, forward slashes,
    e.g. "selfie_walk2/ref_01.png". That is the same shape core's own
    Load3D node produces (comfy_extras/nodes_load_3d.py), it is what
    our pack-owned path resolver confines to the selected image directory, and
    the crop editor's front end already splits it into ?subfolder= and
    ?filename= for its preview.

    Symlinked directories are NOT followed: os.walk's default. A loop
    there would hang the node list, and the node menu is built often.
    """
    root = folder_paths.get_input_directory()
    out = []
    for dirpath, _subdirs, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        for name in filenames:
            try:
                image_path(os.path.relpath(os.path.join(dirpath, name), root))
            except (ValueError, OSError):
                continue
            if rel_dir == os.curdir:
                out.append(name)
            else:
                out.append(os.path.join(rel_dir, name).replace(os.sep, "/"))
    return sorted(out)


def _parse_crop(crop, width, height):
    """Return (x0, y0, x1, y1) pixel box, or None for full image."""
    if not crop:
        return None
    bounded_text(crop, 4096, "Crop JSON")
    try:
        data = json.loads(crop)
        x = float(data["x"])
        y = float(data["y"])
        w = float(data["w"])
        h = float(data["h"])
    except (ValueError, KeyError, TypeError):
        return None
    if not all(math.isfinite(v) and 0 <= v <= 1 for v in (x, y, w, h)):
        raise ValueError("Crop coordinates must be finite normalized numbers between 0 and 1")
    x0 = max(0, min(width - 1, round(x * width)))
    y0 = max(0, min(height - 1, round(y * height)))
    x1 = max(x0 + 1, min(width, round((x + w) * width)))
    y1 = max(y0 + 1, min(height, round((y + h) * height)))
    if x0 == 0 and y0 == 0 and x1 == width and y1 == height:
        return None
    return (x0, y0, x1, y1)


# Offered shapes, widest to tallest. "free" is the unconstrained editor
# this node always had; the others pin the crop rectangle's pixel ratio.
ASPECTS = ("free", "21:9", "2:1", "16:9", "3:2", "4:3", "5:4", "1:1",
           "4:5", "3:4", "2:3", "9:16", "1:2")


def _aspect_value(aspect):
    """'a:b' -> finite positive a/b; None for free/absent."""
    try:
        a, b = str(aspect or "").split(":")
        ratio = float(a) / float(b)
        if not math.isfinite(ratio) or not 1 / 16384 <= ratio <= 16384:
            raise ValueError("Aspect ratio must be finite, positive and within 1:16384..16384:1")
        return ratio
    except (ValueError, ZeroDivisionError):
        if aspect not in (None, "", "free"):
            raise ValueError("Invalid aspect ratio: %r" % aspect) from None
        return None


def _centered_box(width, height, ratio):
    """The largest centered (x0, y0, x1, y1) of pixel ratio `ratio`.

    What an empty crop MEANS under a fixed aspect: the full image is not
    that shape, so the honest default is the biggest cut of it that is.
    The editor shows the same rectangle (implied, dashed) so what is on
    the node is what runs.
    """
    w = width
    h = round(w / ratio)
    if h > height:
        h = height
        w = round(h * ratio)
    x0 = (width - w) // 2
    y0 = (height - h) // 2
    return (x0, y0, x0 + max(1, w), y0 + max(1, h))


class LoadImageCrop:
    CATEGORY = "obvpm/image"
    FUNCTION = "load"
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    DESCRIPTION = (
        "Loads an image and crops it to the area selected interactively on "
        "the node's preview. Drag to draw the crop area, drag inside it to "
        "move, drag its corners to resize, click to clear. With no crop "
        "drawn the full image is output. If max_megapixels is greater than "
        "0, the output is scaled down to fit within it (aspect preserved)."
    )

    OUTPUT_TOOLTIPS = (
        "The loaded image, cropped to the selection (if any) and scaled down to max_megapixels (if set).",
        "Mask from the image's alpha channel, cropped and scaled the same way.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        files = folder_paths.filter_files_content_types(
            _input_images(), ["image"])
        return {
            "required": {
                "image": (sorted(files), {
                    "image_upload": True,
                    "tooltip": "The image file to load. Upload, drag & drop, or pick an existing input file.",
                }),
                "crop": ("STRING", {
                    "default": "",
                    "tooltip": "Managed by the crop editor on the node — no need to edit by hand.",
                }),
                "max_megapixels": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 128.0, "step": 0.01,
                    "tooltip": "If the selected image area is larger than this many megapixels, then it is downscaled to it for output. Set to 0 to disable downscaling.",
                }),
                "aspect": (list(ASPECTS), {
                    "default": "free",
                    "tooltip": "Pin the crop rectangle to a fixed aspect "
                               "ratio: drawing and resizing keep the "
                               "shape, and with no crop drawn the output "
                               "is the largest centered cut of that "
                               "ratio. 'free' is the unconstrained "
                               "editor. A stored crop that disagrees "
                               "with the ratio refuses at run time "
                               "rather than being silently reshaped.",
                }),
            }
        }

    def load(self, image, crop="", max_megapixels=0.0, aspect="free"):
        max_megapixels = finite_number(max_megapixels, "max_megapixels", 0, 128)
        _aspect_value(aspect)
        _parse_crop(crop, 1, 1)
        paths, counts = inspect_images([image], animation=True)
        output_images, output_masks = [], []
        size = None
        total = 0
        with open_checked_image(paths[0]) as img:
            for index in range(counts[0]):
                img.seek(index)
                total = check_pixels(*img.size, total)
                i = node_helpers.pillow(ImageOps.exif_transpose, img)
                if size is None:
                    size = i.size
                if i.size != size:
                    continue
                frame = torch.from_numpy(np.array(i.convert("RGB")).astype(np.float32) / 255.0)[None,]
                if "A" in i.getbands():
                    mask = 1.0 - torch.from_numpy(np.array(i.getchannel("A")).astype(np.float32) / 255.0)
                else:
                    mask = torch.zeros((i.height, i.width), dtype=torch.float32)
                # Crop/downscale each frame before retaining the batch.
                images, masks = self._crop_frame(frame, mask.unsqueeze(0), crop, max_megapixels, aspect)
                output_images.append(images)
                output_masks.append(masks)
        return (torch.cat(output_images, dim=0), torch.cat(output_masks, dim=0))

    @staticmethod
    def _crop_frame(images, masks, crop, max_megapixels, aspect):
        box = _parse_crop(crop, images.shape[2], images.shape[1])
        ratio = _aspect_value(aspect)
        if ratio is not None:
            if box is None:
                box = _centered_box(images.shape[2], images.shape[1], ratio)
                if box == (0, 0, images.shape[2], images.shape[1]):
                    box = None          # already exactly that shape
            else:
                # The editor keeps crop and aspect in step, so a mismatch
                # means a hand-edited or wired-in crop: refuse by name
                # rather than silently reshaping a selection. Tolerance
                # covers the normalized->pixel rounding, nothing more.
                bw, bh = box[2] - box[0], box[3] - box[1]
                if abs(bw - ratio * bh) > 2.0 * (1.0 + ratio):
                    raise ValueError(
                        "Load Image & Crop: the stored crop is %dx%d, "
                        "which is not %s. Redraw the crop with the "
                        "aspect set, or switch aspect back to 'free'."
                        % (bw, bh, aspect))
        if box is not None:
            x0, y0, x1, y1 = box
            images = images[:, y0:y1, x0:x1, :]
            masks = masks[:, y0:y1, x0:x1]

        if max_megapixels > 0:
            import comfy.utils

            height, width = images.shape[1], images.shape[2]
            target = max_megapixels * 1024 * 1024
            current = width * height
            if current > target:
                scale = (target / current) ** 0.5
                new_width = max(1, round(width * scale))
                new_height = max(1, round(height * scale))
                images = comfy.utils.common_upscale(
                    images.movedim(-1, 1), new_width, new_height, "lanczos", "disabled"
                ).movedim(1, -1)
                masks = comfy.utils.common_upscale(
                    masks.unsqueeze(1), new_width, new_height, "bilinear", "disabled"
                ).squeeze(1)

        return (images, masks)

    @classmethod
    def IS_CHANGED(cls, image, crop="", max_megapixels=0.0, aspect="free"):
        return hash_images([image])

    @classmethod
    def VALIDATE_INPUTS(cls, image, crop="", max_megapixels=0.0,
                        aspect="free"):
        try:
            image_path(image)
            finite_number(max_megapixels, "max_megapixels", 0, 128)
            _aspect_value(aspect)
            _parse_crop(crop, 1, 1)
        except (ValueError, OSError) as exc:
            return str(exc)
        return True
