"""obvpm nodes: image loaders, optional gates, lazy switches, and small
workflow helpers.

The nodes themselves live in one module per category -- gates, switches,
values, bundle, image, presets -- with `common` holding the few pieces
they share. This file registers them, and registers the "beta57"
scheduler (RES4LYF's beta schedule with alpha=0.5, beta=0.7) into
ComfyUI's global registry.

Node classes are addressed by their NODE_CLASS_MAPPINGS key, never by
module path, so which file a class lives in is invisible to a workflow.

The MiniMax H3 clip-composition nodes live in the companion pack
comfyui-obvpm-timeline; the two packs share nothing at import time.
"""

from functools import partial

import comfy.samplers

from .compose_images import LoadImagesCompose
from .load_image_crop import LoadImageCrop

if "beta57" not in comfy.samplers.SCHEDULER_HANDLERS:
    comfy.samplers.SCHEDULER_HANDLERS["beta57"] = comfy.samplers.SchedulerHandler(
        partial(comfy.samplers.beta_scheduler, alpha=0.5, beta=0.7)
    )
# SCHEDULER_NAMES and KSampler.SCHEDULERS are the same list object in
# comfy/samplers.py, so append to each only if genuinely missing.
for _names in (comfy.samplers.SCHEDULER_NAMES, comfy.samplers.KSampler.SCHEDULERS):
    if "beta57" not in _names:
        _names.append("beta57")

from .bundle import (
    Bundle,
    BundlePeek,
    UnbundleAuto,
)
from .gates import (
    AnyOptionalGate,
    AudioOptionalGate,
    ImageOptionalGate,
    LatentOptionalGate,
    ModelOptionalGate,
    MuteGate,
    VideoOptionalGate,
)
from .image import DownscaleImageToMegapixels
from .pickers import LoraName, SamplerName, SchedulerName
from .presets import ValuePresets
from . import presets as _presets
from .switches import (
    LazyCaseSwitch,
    LazyCaseSwitchAuto,
    LazySwitch,
    LazySwitch2,
    LazySwitch3,
)
from .values import Dropdown, FirstFloat, FirstInt
from .vram import CleanVRAM


NODE_CLASS_MAPPINGS = {
    "ImageOptionalGate": ImageOptionalGate,
    "VideoOptionalGate": VideoOptionalGate,
    "AudioOptionalGate": AudioOptionalGate,
    "ModelOptionalGate": ModelOptionalGate,
    "LatentOptionalGate": LatentOptionalGate,
    "AnyOptionalGate": AnyOptionalGate,
    "MuteGate": MuteGate,
    "LazySwitch": LazySwitch,
    "LazySwitch2": LazySwitch2,
    "LazySwitch3": LazySwitch3,
    "LazyCaseSwitch": LazyCaseSwitch,
    "LazyCaseSwitchAuto": LazyCaseSwitchAuto,
    "DownscaleImageToMegapixels": DownscaleImageToMegapixels,
    "FirstFloat": FirstFloat,
    "FirstInt": FirstInt,
    "Dropdown": Dropdown,
    "Bundle": Bundle,
    # Historical id -- saved workflows name it, so it stays. Display: the
    # plain "Unbundle" (the named variants and BundleGet were folded into
    # these two before anything shipped).
    "UnbundleAuto": UnbundleAuto,
    "BundlePeek": BundlePeek,
    "ValuePresets": ValuePresets,
    "LoadImageCrop": LoadImageCrop,
    "LoadImagesCompose": LoadImagesCompose,
    "LoraName": LoraName,
    "SamplerName": SamplerName,
    "SchedulerName": SchedulerName,
    "CleanVRAM": CleanVRAM,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ImageOptionalGate": "Optional Image",
    "VideoOptionalGate": "Optional Video",
    "AudioOptionalGate": "Optional Audio",
    "ModelOptionalGate": "Required Model",
    "LatentOptionalGate": "Optional Latent",
    "AnyOptionalGate": "Optional Any",
    "MuteGate": "Mute",
    "LazySwitch": "Lazy Switch",
    "LazySwitch2": "Lazy Switch 2 Values",
    "LazySwitch3": "Lazy Switch 3 Values",
    "LazyCaseSwitch": "Lazy Case Switch",
    "LazyCaseSwitchAuto": "Lazy Case Switch (auto)",
    "DownscaleImageToMegapixels": "Downscale Image to Megapixels",
    "FirstFloat": "First Float (else fallback)",
    "FirstInt": "First Int (else fallback)",
    "Dropdown": "Dropdown",
    "Bundle": "Bundle",
    "UnbundleAuto": "Unbundle",
    "BundlePeek": "Peek Bundle",
    "ValuePresets": "Value Presets",
    "LoadImageCrop": "Load Image & Crop",
    "LoadImagesCompose": "Load Images & Compose",
    "LoraName": "Lora Name",
    "SamplerName": "Sampler Name",
    "SchedulerName": "Scheduler Name",
    "CleanVRAM": "Clean VRAM",
}

try:
    _presets.register()
except Exception:   # headless/test runs have no PromptServer
    import logging
    logging.getLogger("obvpm").info(
        "obvpm: Value Presets schema route not registered (no server)",
        exc_info=True)

WEB_DIRECTORY = "./web"

# Every node carries the pack's name, so a search for "obvpm" finds them
# all and a node in a workflow says where it came from. Applied here, once
# and last, rather than written into each entry, so a new node cannot be
# added without it. The companion pack comfyui-obvpm-timeline does the same.
_SUFFIX = "(obvpm)"
NODE_DISPLAY_NAME_MAPPINGS = {
    key: name if name.endswith(_SUFFIX) else "%s %s" % (name, _SUFFIX)
    for key, name in NODE_DISPLAY_NAME_MAPPINGS.items()
}
# A class with no display name of its own would show as its bare key.
for _key in NODE_CLASS_MAPPINGS:
    NODE_DISPLAY_NAME_MAPPINGS.setdefault(_key, "%s %s" % (_key, _SUFFIX))

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
