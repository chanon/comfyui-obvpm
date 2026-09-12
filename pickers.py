"""Registry-backed pickers: choose a name from a list ComfyUI already
keeps, and send it down a wire.

A LoRA file, a sampler or a scheduler is normally chosen on a widget
INSIDE the node that consumes it, which means the choice cannot be
routed, switched or bundled -- and two consumers cannot share it
without being set twice. These put the same lists on an OUTPUT
instead, so one picker can feed a Bundle, a Lazy Case Switch, or
several loaders at once.

Nothing is loaded or sampled here: the value is a NAME.

Written to replace nodes from two other packs -- see
THIRD_PARTY_NOTICES.md for the credit.
"""

import comfy.samplers
import folder_paths

from .common import ANY

# Socket names deliberately mirror the nodes these replace. A widget
# that has been converted to an input is re-bound BY NAME when a
# workflow loads, so a rename would drop that wire silently -- keeping
# the names means an existing graph only has to change the node type.


class LoraName:
    CATEGORY = "obvpm/values"
    FUNCTION = "pick"
    # ANY, not STRING: the consumer is usually a loader's own `lora_name`
    # combo, and a combo input only accepts a wire whose type matches its
    # option list -- which is built at refresh time and cannot be named
    # here. ANY matches whatever it is plugged into.
    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("lora_name",)
    DESCRIPTION = (
        "Pick a LoRA file and send its name down a wire. The list is the "
        "same one a loader shows, read from the loras folder. Nothing is "
        "loaded here -- this is the name only, so it can be bundled, "
        "switched between presets, or fed to several loaders at once."
    )
    OUTPUT_TOOLTIPS = (
        "The chosen file name, exactly as a loader's own widget reports "
        "it (including any subfolder).",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "lora_name": (folder_paths.get_filename_list("loras"), {
                    "tooltip": "Any file under models/loras.",
                }),
            }
        }

    def pick(self, lora_name):
        return (lora_name,)


class SamplerName:
    CATEGORY = "obvpm/values"
    FUNCTION = "pick"
    # The list object itself is the type, so this output plugs straight
    # into any `sampler_name` combo (KSamplerSelect, KSampler, ...). The
    # second output is the plain string, for bundling or captions.
    RETURN_TYPES = (comfy.samplers.KSampler.SAMPLERS, "STRING")
    RETURN_NAMES = ("sampler", "sampler_name")
    DESCRIPTION = (
        "Pick a sampler and send it down a wire, instead of setting it on "
        "the sampler node itself. Wire `sampler` into any sampler_name "
        "combo; `sampler_name` is the same choice as plain text."
    )
    OUTPUT_TOOLTIPS = (
        "The choice, typed to match a sampler_name combo.",
        "The same choice as a plain string.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {
                    "tooltip": "Any sampler this ComfyUI knows about.",
                }),
            }
        }

    def pick(self, sampler_name):
        return (sampler_name, sampler_name)


class SchedulerName:
    CATEGORY = "obvpm/values"
    FUNCTION = "pick"
    RETURN_TYPES = (comfy.samplers.KSampler.SCHEDULERS, "STRING")
    RETURN_NAMES = ("scheduler", "scheduler_name")
    DESCRIPTION = (
        "Pick a scheduler and send it down a wire, instead of setting it "
        "on the sampler node itself. The list is read live, so schedulers "
        "registered by a pack -- this one's `beta57` included -- appear "
        "here too."
    )
    OUTPUT_TOOLTIPS = (
        "The choice, typed to match a scheduler combo.",
        "The same choice as a plain string.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {
                    "tooltip": "Any scheduler this ComfyUI knows about.",
                }),
            }
        }

    def pick(self, scheduler):
        return (scheduler, scheduler)
