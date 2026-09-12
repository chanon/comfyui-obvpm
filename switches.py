"""Lazy switches: only the selected branch executes, so the
unselected side costs nothing -- including everything
upstream of it.
"""

from .common import ANY, _LOG_CASE, _lines

class LazySwitch:
    CATEGORY = "obvpm/switches"
    FUNCTION = "switch"
    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("value",)
    DESCRIPTION = (
        "Outputs on_true when boolean is true, else on_false. Lazy: only the "
        "selected branch executes — every node feeding the unselected side is "
        "skipped entirely, saving its compute. An unconnected selected side "
        "outputs None instead of erroring, and blocked (muted) branches can "
        "be picked back up by selecting the other side. Drive the boolean "
        "from a gate's 'present' output to switch automatically."
    )

    OUTPUT_TOOLTIPS = (
        "The selected side's value. None when the selected side is unconnected.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "boolean": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Selects which side to execute and output: true = on_true, false = on_false.",
                }),
            },
            "optional": {
                "on_false": (ANY, {
                    "lazy": True,
                    "tooltip": "Output when boolean is false. Only executes while selected; may be left unconnected.",
                }),
                "on_true": (ANY, {
                    "lazy": True,
                    "tooltip": "Output when boolean is true. Only executes while selected; may be left unconnected.",
                }),
            },
            "hidden": {
                "dynprompt": "DYNPROMPT",
                "unique_id": "UNIQUE_ID",
            },
        }

    def check_lazy_status(self, boolean, on_true=None, on_false=None, dynprompt=None, unique_id=None):
        wanted = "on_true" if boolean else "on_false"
        # Requesting a lazy input that has no link is a hard engine error,
        # so only ask for the selected side if it is actually connected.
        if dynprompt is not None and unique_id is not None:
            from comfy_execution.graph_utils import is_link

            value = dynprompt.get_node(unique_id)["inputs"].get(wanted)
            if not is_link(value):
                return []
        return [wanted]

    def switch(self, boolean, on_true=None, on_false=None, dynprompt=None, unique_id=None):
        return (on_true if boolean else on_false,)


class LazySwitchMultiBase:
    CATEGORY = "obvpm/switches"
    FUNCTION = "switch"
    DESCRIPTION = (
        "A Lazy Switch for several values at once: when boolean is true the "
        "on_true_value_* inputs are output as value_*, otherwise the "
        "on_false_value_* inputs. Only the selected side executes — nodes "
        "feeding the unselected side are skipped entirely. Unconnected slots "
        "on the selected side output None."
    )

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for side in ("false", "true"):
            for i in range(1, cls.COUNT + 1):
                optional[f"on_{side}_value_{i}"] = (ANY, {
                    "lazy": True,
                    "tooltip": f"Output as value_{i} when boolean is {side}. Only executes while selected; may be left unconnected.",
                })
        return {
            "required": {
                "boolean": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Selects which side to execute and output: true = the on_true_value inputs, false = the on_false_value inputs.",
                }),
            },
            "optional": optional,
            "hidden": {
                "dynprompt": "DYNPROMPT",
                "unique_id": "UNIQUE_ID",
            },
        }

    def check_lazy_status(self, boolean, dynprompt=None, unique_id=None, **kwargs):
        side = "true" if boolean else "false"
        wanted = [f"on_{side}_value_{i}" for i in range(1, self.COUNT + 1)]
        # Requesting a lazy input that has no link is a hard engine error,
        # so only ask for selected-side inputs that are actually connected.
        if dynprompt is not None and unique_id is not None:
            from comfy_execution.graph_utils import is_link

            inputs = dynprompt.get_node(unique_id)["inputs"]
            wanted = [name for name in wanted if is_link(inputs.get(name))]
        return wanted

    def switch(self, boolean, dynprompt=None, unique_id=None, **kwargs):
        side = "true" if boolean else "false"
        return tuple(
            kwargs.get(f"on_{side}_value_{i}")
            for i in range(1, self.COUNT + 1)
        )


_LAZY_VALUE_TOOLTIP = "The selected side's value for this slot. None when that slot is unconnected."


class LazySwitch2(LazySwitchMultiBase):
    COUNT = 2
    RETURN_TYPES = (ANY, ANY)
    RETURN_NAMES = ("value_1", "value_2")
    OUTPUT_TOOLTIPS = (_LAZY_VALUE_TOOLTIP,) * 2


class LazySwitch3(LazySwitchMultiBase):
    COUNT = 3
    RETURN_TYPES = (ANY, ANY, ANY)
    RETURN_NAMES = ("value_1", "value_2", "value_3")
    OUTPUT_TOOLTIPS = (_LAZY_VALUE_TOOLTIP,) * 3


class LazyCaseSwitch:
    CATEGORY = "obvpm/switches"
    FUNCTION = "switch"
    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("value",)
    # Branch sockets are declared up to this many and the ones past the
    # case list are removed in the UI, so the node shows exactly as many
    # as there are cases. Raising it costs nothing but object_info size.
    MAX_CASES = 16
    DESCRIPTION = (
        "Picks one of several branches by NAME rather than by a boolean: "
        "write the case names one per line, and the branch whose line "
        "matches 'selected' is the one that executes and is output. Lazy, "
        "like the other switches -- the branches that were not chosen "
        "never run, so everything feeding them is skipped. One on_case "
        "input appears per line, labelled with it, and 'selected' is a "
        "dropdown of the same lines; convert it to an input to drive "
        "several switches from one Choice node. No match falls through "
        "to 'fallback'."
    )
    OUTPUT_TOOLTIPS = (
        "The matching branch's value. None when that branch is unconnected "
        "and there is no fallback.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        # fallback is declared FIRST so it keeps a fixed position at the top
        # of the branch pins: the case pins below it come and go with the
        # lines, and a socket that moves as you edit the list is a socket
        # whose wire is easy to lose track of.
        optional = {
            "fallback": (ANY, {
                "lazy": True,
                "tooltip": "Output when no case line matches. Only executes "
                           "while selected; may be left unconnected.",
            }),
        }
        for i in range(1, cls.MAX_CASES + 1):
            optional[f"on_case_{i}"] = (ANY, {
                "lazy": True,
                "tooltip": f"Output when selected matches case line {i}. "
                           f"Only executes while selected; may be left "
                           f"unconnected.",
            })
        return {
            "required": {
                "selected": ("STRING", {
                    "default": "",
                    "tooltip": "Which case to run. Shown as a dropdown of "
                               "the case lines; convert it to an input to "
                               "drive it from a Choice node or any string.",
                }),
                "cases": ("STRING", {
                    "default": "first\nsecond",
                    "multiline": True,
                    "tooltip": "The case names, one per line. Each line "
                               "gets its own on_case input, in order. "
                               "Blank lines are ignored and surrounding "
                               "spaces trimmed; names are matched exactly.",
                }),
            },
            "optional": optional,
            "hidden": {
                "dynprompt": "DYNPROMPT",
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def _wanted(cls, selected, cases):
        """Which input feeds the output: on_case_<line number>, or fallback.

        The case names and the branch sockets come from this one list, so
        the dropdown, the labels and the routing cannot drift apart.
        """
        chosen = str(selected or "").strip()
        if not chosen:
            return "fallback"
        for i, label in enumerate(_lines(cases)[:cls.MAX_CASES], start=1):
            if label == chosen:
                return f"on_case_{i}"
        return "fallback"

    def check_lazy_status(self, selected, cases, dynprompt=None,
                          unique_id=None, **kwargs):
        wanted = self._wanted(selected, cases)
        # Requesting a lazy input that has no link is a hard engine error,
        # so only ask for the chosen branch if it is actually connected.
        if dynprompt is not None and unique_id is not None:
            from comfy_execution.graph_utils import is_link

            value = dynprompt.get_node(unique_id)["inputs"].get(wanted)
            if not is_link(value):
                return []
        return [wanted]

    def switch(self, selected, cases, dynprompt=None, unique_id=None,
               **kwargs):
        chosen = str(selected or "").strip()
        names = _lines(cases)
        if chosen and chosen not in names and "fallback" not in kwargs:
            _LOG_CASE.info(
                "LazyCaseSwitch: %r matches no case line (%s) and no "
                "fallback is connected; outputting None",
                chosen, ", ".join(names) or "none")
        return (kwargs.get(self._wanted(selected, cases)),)


class LazyCaseSwitchAuto(LazyCaseSwitch):
    """A Lazy Case Switch whose cases come from what is wired into it.

    Same routing and the same laziness underneath -- only where the case
    list comes from differs. The list still exists as a widget, hidden
    and filled in by the UI, because that is how the names reach the
    server for `selected` to be matched against.
    """

    DESCRIPTION = (
        "Picks a branch by NAME, with the names taken from whatever is "
        "connected: each branch is called after the node feeding it. "
        "Starts with a single empty input and grows another as each one "
        "is filled, so there is always one spare; unplugging one closes "
        "its gap. Lazy like the other switches -- the branches that were "
        "not chosen never run. Use Lazy Case Switch to write the case "
        "names yourself."
    )

    @classmethod
    def INPUT_TYPES(cls):
        spec = super().INPUT_TYPES()
        spec["required"] = dict(spec["required"])
        spec["required"]["cases"] = ("STRING", {
            "default": "",
            "multiline": True,
            "tooltip": "Filled in from the connected branches.",
        })
        return spec
