"""Small value helpers: a user-defined dropdown, and
first-connected-wins fallbacks.
"""

from .common import _lines

class Dropdown:
    CATEGORY = "obvpm/values"
    FUNCTION = "pick"
    RETURN_TYPES = ("STRING", "INT", "STRING")
    RETURN_NAMES = ("value", "index", "options")
    DESCRIPTION = (
        "A dropdown you define yourself: type the choices one per line and "
        "pick one from the list. Outputs the chosen line verbatim, its "
        "position, and the whole list -- so one Dropdown can drive a Lazy "
        "Case Switch entirely: 'options' into its cases, 'value' into its "
        "selected. Feeding both means the names, the branch sockets and "
        "the routing all come from this one list."
    )
    OUTPUT_TOOLTIPS = (
        "The selected line, verbatim.",
        "Its position in the list, counting from 0.",
        "The whole list, unchanged — wire it into a Lazy Case Switch's "
        "'cases' so both nodes share one source.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "options": ("STRING", {
                    "default": "first\nsecond\nthird",
                    "multiline": True,
                    "tooltip": "The choices, one per line. Blank lines are "
                               "ignored and surrounding spaces trimmed. "
                               "Editing this refills the dropdown.",
                }),
                "selected": ("STRING", {
                    "default": "",
                    "tooltip": "The chosen line. Shown as a dropdown of the "
                               "options above; empty means the first "
                               "option.",
                }),
            },
        }

    def pick(self, options, selected):
        choices = _lines(options)
        if not choices:
            raise ValueError(
                "Dropdown: the options list is empty -- put one choice per "
                "line in the options widget.")
        chosen = str(selected or "").strip()
        if not chosen:
            chosen = choices[0]
        if chosen not in choices:
            # Silently falling back would change what a saved workflow
            # means without saying so; an edited options list should be
            # re-picked deliberately.
            raise ValueError(
                "Dropdown: %r is not one of the options (%s). Pick again "
                "from the dropdown, or restore that line."
                % (chosen, ", ".join(repr(c) for c in choices)))
        # `options` is passed through rather than rebuilt from `choices` so
        # that whatever is wired into a Lazy Case Switch's cases is exactly
        # what this node's own dropdown was built from.
        return (chosen, choices.index(chosen), options)


class FirstValueBase:
    CATEGORY = "obvpm/values"
    FUNCTION = "select"
    SLOTS = 3
    DESCRIPTION = (
        "Outputs the first connected input that carries a value, or the "
        "fallback widget value when none do. Inputs fed by a gate in bypass "
        "mode (None) are skipped over, so this fans multiple optional paths "
        "back into one guaranteed value."
    )

    OUTPUT_TOOLTIPS = (
        "The first connected input that has a value, or the fallback.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        name = cls.TYPE.lower()
        return {
            "required": {
                "fallback": (cls.TYPE, {
                    **cls.FALLBACK_OPTS,
                    "tooltip": "Output when none of the inputs carry a value.",
                }),
            },
            "optional": {
                f"{name}{i}": (cls.TYPE, {
                    "forceInput": True,
                    "tooltip": f"Candidate {i}: used when it is the first connected input with a value. Bypassed (None) inputs are skipped.",
                })
                for i in range(1, cls.SLOTS + 1)
            },
        }

    def select(self, fallback, **values):
        name = self.TYPE.lower()
        for i in range(1, self.SLOTS + 1):
            value = values.get(f"{name}{i}")
            if value is not None:
                return (value,)
        return (fallback,)


class FirstFloat(FirstValueBase):
    TYPE = "FLOAT"
    RETURN_TYPES = ("FLOAT",)
    RETURN_NAMES = ("float",)
    FALLBACK_OPTS = {"default": 0.0, "min": -1.0e18, "max": 1.0e18, "step": 0.01}


class FirstInt(FirstValueBase):
    TYPE = "INT"
    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("int",)
    FALLBACK_OPTS = {"default": 0, "min": -2**53, "max": 2**53}
