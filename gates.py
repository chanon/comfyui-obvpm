"""Optional gates: pass a value through, or decide what happens
when there is nothing to pass.

When the input is missing, the on_empty toggle picks what
downstream sees: 'mute' emits an ExecutionBlocker, silently
skipping every downstream node; 'bypass' forwards None, so a
node with an optional input treats it as unconnected.
"""

from comfy_execution.graph_utils import ExecutionBlocker

from .common import ANY

class OptionalGateBase:
    CATEGORY = "obvpm/gates"
    FUNCTION = "gate"
    DESCRIPTION = (
        "Passes the input through when connected. When the input is missing, "
        "on_empty decides what happens downstream: 'mute' blocks every node "
        "on this path (they are silently skipped), 'bypass' outputs None so a "
        "downstream node with an optional input treats it as unconnected. The "
        "'present' output is true when an input is connected — it stays live "
        "even in mute mode, so it can drive a Lazy Switch boolean."
    )

    OUTPUT_TOOLTIPS = (
        "The input passed through. When the input is empty: blocked (mute) or None (bypass).",
        "True when an input is connected. Stays live even in mute mode.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "on_empty": (["mute", "bypass"], {
                    "default": "mute",
                    "tooltip": "What downstream sees when no input is connected: mute skips every downstream node, bypass outputs None.",
                }),
            },
            "optional": {
                "input": (cls.TYPE, {
                    "tooltip": "The value to pass through. May be left unconnected.",
                }),
            },
        }

    def gate(self, on_empty, input=None):
        if input is None and on_empty == "mute":
            # The value path is blocked, but the present flag stays live so
            # it can drive switches even when the input is missing.
            return (ExecutionBlocker(None), False)
        return (input, input is not None)


class ImageOptionalGate(OptionalGateBase):
    TYPE = "IMAGE"
    RETURN_TYPES = ("IMAGE", "BOOLEAN")
    RETURN_NAMES = ("image", "present")


class VideoOptionalGate(OptionalGateBase):
    TYPE = "VIDEO"
    RETURN_TYPES = ("VIDEO", "BOOLEAN")
    RETURN_NAMES = ("video", "present")


class AudioOptionalGate(OptionalGateBase):
    TYPE = "AUDIO"
    RETURN_TYPES = ("AUDIO", "BOOLEAN")
    RETURN_NAMES = ("audio", "present")


class ModelOptionalGate(OptionalGateBase):
    TYPE = "MODEL"
    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("model",)
    DESCRIPTION = (
        "Passes the model through. The input is required: queueing with "
        "nothing connected is refused up front, so a missing model is a "
        "loud error at this node rather than a mystery downstream."
    )

    OUTPUT_TOOLTIPS = (
        "The model passed through.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input": (cls.TYPE, {
                    "tooltip": "The model to pass through.",
                }),
            },
        }

    def gate(self, input=None):
        if input is None:
            return (ExecutionBlocker(None),)
        return (input,)


class LatentOptionalGate(OptionalGateBase):
    TYPE = "LATENT"
    RETURN_TYPES = ("LATENT", "BOOLEAN")
    RETURN_NAMES = ("latent", "present")


class AnyOptionalGate(OptionalGateBase):
    TYPE = ANY
    RETURN_TYPES = (ANY, "BOOLEAN")
    RETURN_NAMES = ("value", "present")


class MuteGate:
    CATEGORY = "obvpm/gates"
    FUNCTION = "gate"
    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("value",)
    DESCRIPTION = (
        "Passes the input through unchanged; when mute is true, every node "
        "downstream of this gate is silently skipped. Accepts any type. Note "
        "that the nodes upstream of 'input' still run — to skip the upstream "
        "work as well, use a Lazy Switch instead."
    )

    OUTPUT_TOOLTIPS = (
        "The input passed through. Blocked while mute is true.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mute": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "When true, every node downstream of this gate is skipped. Connectable, so it can be driven by logic.",
                }),
            },
            "optional": {
                "input": (ANY, {
                    "tooltip": "Any value to pass through. Its upstream nodes still run even when muted.",
                }),
            },
        }

    def gate(self, mute, input=None):
        if mute:
            return (ExecutionBlocker(None),)
        return (input,)
