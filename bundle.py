"""Bundles: several values on one wire.

A bundle is a plain {name: value} mapping, so anything can
travel in it, and a Lazy Case Switch carries the whole set
down one branch.
"""

from .common import ANY, _LOG_CASE, _lines

# Prefixed 2026-08-20, before the first release -- see
# h3/wiretypes.py for why every type this pack defines carries it.
BUNDLE = "OBVPM_BUNDLE"


MAX_FIELDS = 16


class Bundle:
    CATEGORY = "obvpm/bundle"
    FUNCTION = "pack"
    # One output, and no meaningful name on it: the node is a plug.
    # The name list still exists as a hidden widget (that is how the
    # wire names reach the server) but nothing downstream needs it --
    # Unbundle reads the names off the bundle. (There used to be a
    # second "names" output; nothing ever wired it, and the UI drops
    # the stale pin from old saves.)
    RETURN_TYPES = (BUNDLE,)
    RETURN_NAMES = ("out",)
    DESCRIPTION = (
        "Packs several values into ONE wire so they can travel together -- "
        "through a Lazy Case Switch, for instance, which carries a single "
        "value per branch. Each field is named after whatever is connected "
        "to it; the config dialog (the node's small button, or right-click "
        "-> Configure) renames and reorders them. Starts with one empty "
        "input and grows another as each is filled, so there is always one "
        "spare. Unpack the other end with Unbundle. Laziness is preserved: "
        "this node sits on a branch, so it only runs when that branch is "
        "chosen."
    )
    OUTPUT_TOOLTIPS = ("The packed fields as one value.",)

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for i in range(1, MAX_FIELDS + 1):
            optional[f"in_{i}"] = (ANY, {
                "tooltip": f"Value for name line {i}. May be left "
                           f"unconnected; it then unpacks as None.",
            })
        return {
            "required": {
                # Hidden in the UI and filled in from the connected wires
                # (with the config dialog's renames applied): the names
                # live in the browser, so a widget is how they reach the
                # server at all. Line i names the value on in_i.
                "names": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "Filled in from the connected wires.",
                }),
            },
            "optional": optional,
        }

    def pack(self, names, **kwargs):
        fields = _lines(names)[:MAX_FIELDS]
        packed = {}
        for i, name in enumerate(fields, start=1):
            if name in packed:
                _LOG_CASE.warning(
                    "Bundle: %r is listed more than once; the later line "
                    "wins", name)
            packed[name] = kwargs.get(f"in_{i}")
        return (packed,)


def _as_bundle(bundle, node):
    """Bundles are plain {name: value} dicts -- anything else is a miswire."""
    if not isinstance(bundle, dict):
        raise ValueError(
            "%s: expected a bundle (a name/value mapping) but got %s. Wire "
            "the bundle output of a Bundle node here."
            % (node, type(bundle).__name__))
    return bundle


class UnbundleAuto:
    """Unbundle: the bundle's own fields, in order, one output each.

    A bundle is an ordered mapping, so its keys are the field names as
    they were packed -- everything this node needs is already on the wire.
    The outputs are built in the browser by tracing that wire back to the
    Bundle that packed it, and the two agree because both read the same
    list in the same order. The optional 'names' list (hidden, written by
    the node's config dialog) overrides that: reorder, or a subset --
    the server pulls BY NAME in the order given.

    Registered as "Unbundle (obvpm)" (the class name is historical); the
    display name is plain "Unbundle".
    """

    CATEGORY = "obvpm/bundle"
    FUNCTION = "unpack"
    RETURN_TYPES = (ANY,) * MAX_FIELDS
    RETURN_NAMES = tuple(f"out_{i}" for i in range(1, MAX_FIELDS + 1))
    DESCRIPTION = (
        "Expands a bundle back into separate wires, one output per field, "
        "labelled with its name -- taken from the bundle itself, with "
        "nothing to fill in. The config dialog (the node's small button, "
        "or right-click -> Configure) reorders the outputs or hides the "
        "ones a branch does not need; hiding is also how to take a single "
        "field. A name that is no longer in the bundle outputs None."
    )
    OUTPUT_TOOLTIPS = tuple(
        "The bundle's value for field %d." % i
        for i in range(1, MAX_FIELDS + 1))

    @classmethod
    def INPUT_TYPES(cls):
        # Named "in" rather than "bundle": it is the node's only pin, and
        # the type already says what it carries. A one-word name survives
        # into every renderer, which a blanked label does not.
        # 'names' is OPTIONAL: prompts from saves that predate it carry no
        # such key, and a required input with no value fails validation.
        return {
            "required": {
                "in": (BUNDLE, {
                    "tooltip": "The packed value from a Bundle node.",
                }),
            },
            "optional": {
                "names": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "Written by the config dialog: the fields "
                               "to expose, one per line, in output order. "
                               "Empty = the bundle's own fields as packed.",
                }),
            },
        }

    # "in" is a keyword, so it can only arrive through kwargs.
    def unpack(self, **kwargs):
        packed = _as_bundle(kwargs.get("in"), "Unbundle")
        # Empty list = follow the bundle. A bundle is an ordered mapping, so
        # its keys are the Bundle node's name lines in their original order
        # -- the same list the outputs were built from client-side.
        fields = (_lines(kwargs.get("names") or "")[:MAX_FIELDS]
                  or list(packed)[:MAX_FIELDS])
        missing = [n for n in fields if n not in packed]
        if missing:
            # Not fatal: a bundle may legitimately carry a subset, and the
            # unused outputs are simply None.
            _LOG_CASE.info(
                "Unbundle: %s not in the bundle (has %s); those outputs "
                "are None", ", ".join(missing),
                ", ".join(packed) or "nothing")
        values = [packed.get(name) for name in fields]
        values += [None] * (MAX_FIELDS - len(values))
        return tuple(values)


def _describe(value):
    """One short line for a packed value.

    Deliberately not a dump: a bundle usually holds images, latents and
    audio, and printing those gives pages of numbers that say nothing
    about whether the right thing is on the wire. Shape and size answer
    that; the actual contents are what the preview nodes are for.
    """
    if value is None:
        return "None"
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, str):
        text = value if len(value) <= 120 else value[:117] + "..."
        return repr(text)
    # LATENT / AUDIO arrive as dicts with a known key
    if isinstance(value, dict):
        samples = value.get("samples")
        if samples is not None and hasattr(samples, "shape"):
            return "LATENT %s" % (tuple(samples.shape),)
        waveform = value.get("waveform")
        if waveform is not None and hasattr(waveform, "shape"):
            rate = int(value.get("sample_rate") or 0)
            shape = tuple(waveform.shape)
            seconds = (shape[-1] / rate) if rate else 0.0
            return "AUDIO %s @ %dHz (%.2fs)" % (shape, rate, seconds)
        if not value:
            return "BUNDLE (empty)"
        return "BUNDLE {%s}" % ", ".join(str(k) for k in value)
    if hasattr(value, "shape"):          # IMAGE / MASK / any tensor
        dtype = str(getattr(value, "dtype", "")).replace("torch.", "")
        return "%s %s%s" % (type(value).__name__, tuple(value.shape),
                            " " + dtype if dtype else "")
    if isinstance(value, (list, tuple)):
        return "%s of %d" % (type(value).__name__, len(value))
    return type(value).__name__


class BundlePeek:
    CATEGORY = "obvpm/bundle"
    FUNCTION = "peek"
    OUTPUT_NODE = True
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    DESCRIPTION = (
        "Shows what is inside a bundle: one line per field, with its name "
        "and a short description of the value -- shape for images and "
        "latents, duration for audio, the value itself for numbers and "
        "text. Passes the report on as a string as well. Nothing is "
        "unpacked or converted, so this costs nothing to leave wired in."
    )
    OUTPUT_TOOLTIPS = ("The same report, as text.",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "in": (BUNDLE, {
                    "tooltip": "The packed value to look inside.",
                }),
            },
        }

    def peek(self, **kwargs):
        packed = _as_bundle(kwargs.get("in"), "Peek")
        if not packed:
            report = "(empty bundle)"
        else:
            width = max(len(str(name)) for name in packed)
            report = "\n".join(
                "%-*s  %s" % (width, name, _describe(value))
                for name, value in packed.items())
        return {"ui": {"text": (report,)}, "result": (report,)}
