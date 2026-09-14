"""obvpm nodes: image loaders, optional gates, lazy switches, and small
workflow helpers.

The nodes themselves live in one module per category -- gates, switches,
values, bundle, image, presets -- with `common` holding the few pieces
they share. This file registers them, and registers the "beta57"
scheduler (RES4LYF's beta schedule with alpha=0.5, beta=0.7) into
ComfyUI's global registry.

Node classes are addressed by their NODE_CLASS_MAPPINGS key, never by
module path, so which file a class lives in is invisible to a workflow.
Every key carries the " (obvpm)" suffix (ids.py has the story, and the map
from the bare ids of 0.1.x that old workflows still load through).

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
from . import ids as _ids
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
    "ImageOptionalGate (obvpm)": ImageOptionalGate,
    "VideoOptionalGate (obvpm)": VideoOptionalGate,
    "AudioOptionalGate (obvpm)": AudioOptionalGate,
    "ModelOptionalGate (obvpm)": ModelOptionalGate,
    "LatentOptionalGate (obvpm)": LatentOptionalGate,
    "AnyOptionalGate (obvpm)": AnyOptionalGate,
    "MuteGate (obvpm)": MuteGate,
    "LazySwitch (obvpm)": LazySwitch,
    "LazySwitch2 (obvpm)": LazySwitch2,
    "LazySwitch3 (obvpm)": LazySwitch3,
    "LazyCaseSwitch (obvpm)": LazyCaseSwitch,
    "LazyCaseSwitchAuto (obvpm)": LazyCaseSwitchAuto,
    "DownscaleImageToMegapixels (obvpm)": DownscaleImageToMegapixels,
    "FirstFloat (obvpm)": FirstFloat,
    "FirstInt (obvpm)": FirstInt,
    "Dropdown (obvpm)": Dropdown,
    "Bundle (obvpm)": Bundle,
    "Unbundle (obvpm)": UnbundleAuto,
    "PeekBundle (obvpm)": BundlePeek,
    "ValuePresets (obvpm)": ValuePresets,
    "LoadImageCrop (obvpm)": LoadImageCrop,
    "LoadImagesCompose (obvpm)": LoadImagesCompose,
    "LoraName (obvpm)": LoraName,
    "SamplerName (obvpm)": SamplerName,
    "SchedulerName (obvpm)": SchedulerName,
    "CleanVRAM (obvpm)": CleanVRAM,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ImageOptionalGate (obvpm)": "Optional Image",
    "VideoOptionalGate (obvpm)": "Optional Video",
    "AudioOptionalGate (obvpm)": "Optional Audio",
    "ModelOptionalGate (obvpm)": "Required Model",
    "LatentOptionalGate (obvpm)": "Optional Latent",
    "AnyOptionalGate (obvpm)": "Optional Any",
    "MuteGate (obvpm)": "Mute If",
    "LazySwitch (obvpm)": "Lazy Switch",
    "LazySwitch2 (obvpm)": "Lazy Switch 2 Values",
    "LazySwitch3 (obvpm)": "Lazy Switch 3 Values",
    "LazyCaseSwitch (obvpm)": "Lazy Case Switch",
    "LazyCaseSwitchAuto (obvpm)": "Lazy Case Switch (auto)",
    "DownscaleImageToMegapixels (obvpm)": "Downscale Image to Megapixels",
    "FirstFloat (obvpm)": "First Float (else fallback)",
    "FirstInt (obvpm)": "First Int (else fallback)",
    "Dropdown (obvpm)": "Dropdown",
    "Bundle (obvpm)": "Bundle",
    "Unbundle (obvpm)": "Unbundle",
    "PeekBundle (obvpm)": "Peek Bundle",
    "ValuePresets (obvpm)": "Value Presets",
    "LoadImageCrop (obvpm)": "Load Image & Crop",
    "LoadImagesCompose (obvpm)": "Load Images & Compose",
    "LoraName (obvpm)": "Lora Name",
    "SamplerName (obvpm)": "Sampler Name",
    "SchedulerName (obvpm)": "Scheduler Name",
    "CleanVRAM (obvpm)": "Clean VRAM",
}

# The bare ids of 0.1.x still load: the frontend rewrites them on the way
# in, and ComfyUI's replacement registry covers API-format prompts.
_ids.register_replacements(NODE_CLASS_MAPPINGS)

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
