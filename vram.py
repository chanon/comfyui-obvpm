"""Free VRAM part-way through a graph.

Written to replace nodes from two other packs -- see
THIRD_PARTY_NOTICES.md for the credit.
"""

import gc
import logging

import comfy.model_management as mm

from .common import ANY

_LOG = logging.getLogger("obvpm")


class CleanVRAM:
    CATEGORY = "obvpm/misc"
    FUNCTION = "clean"
    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("output",)
    # An output node so it runs even when nothing consumes its output:
    # the point of it is the side effect, and a pure passthrough whose
    # result went unused would be pruned before it could happen.
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Unload every loaded model and release cached VRAM, then pass the "
        "input straight through. Put it on the wire between two stages "
        "that will not fit in memory together -- a decode after a long "
        "sample, say. Everything unloaded is reloaded on next use, so the "
        "cost is that reload time; place it where that is cheaper than "
        "running out of memory."
    )
    OUTPUT_TOOLTIPS = (
        "The input, unchanged. Wire it onward so the cleanup is ordered "
        "before whatever needs the room.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "anything": (ANY, {
                    "tooltip": "Passed through untouched. Its only job is "
                               "to place the cleanup in execution order.",
                }),
            }
        }

    def clean(self, anything):
        gc.collect()
        mm.unload_all_models()
        mm.soft_empty_cache()
        _LOG.info("obvpm: unloaded all models and released cached VRAM")
        return (anything,)
