"""Named sets of values on one wire, from a template you edit in the graph.

A preset is DATA. The obvious way to build one in ComfyUI is not: you
copy a little sub-graph of primitives per preset and change the numbers,
and now the *structure* is duplicated N times while only the values
differ. Nothing holds the copies together, so the day one of them is
renamed the others do not follow, and a bundle whose keys quietly stopped
matching still unpacks -- by position -- into the wrong meanings.

So this node keeps exactly one copy of the structure and as many copies
of the values as you like:

    schema    the template: one field per line, with its type
    values    what is set right now, keyed BY NAME
    presets   named sets of the same, also keyed by name
      -> bundle

Everything is keyed by name and nothing by position, which is what makes
editing the template cheap. Add a field and every stored preset gains it
at its default; remove one and the leftover value is ignored rather than
shifting the field after it; reorder them and nothing moves at all.

WHY THE VALUES ARE NOT WIDGETS THIS FILE DECLARES. A node's widgets are
serialised BY POSITION into `widgets_values`, so a schema-driven pool of
them would renumber every stored value the moment a line moved -- exactly
the fragility the name-keyed store exists to avoid. The per-field
controls are therefore built in the browser and mirrored into `values`,
one opaque JSON channel, the same arrangement the H3 timeline uses for
its pin state. This node's own signature is five widgets, forever,
whatever the schema says.

THE TYPES ARE REAL. A field may borrow another node's dropdown by naming
it -- `@LoraName (obvpm).lora_name` reads the live list a LoRA loader shows, so
it follows the folder rather than a copy of it made when the preset was
written. Resolution is a dict lookup over the classes ComfyUI has already
imported (`NODE_CLASS_MAPPINGS`); nothing here imports a module named by
a workflow, evaluates one, or opens a path from one. That matters more
than usual: a workflow travels inside every MP4 this pack writes, so a
schema is text that arrives from elsewhere, and it is only ever parsed
as data. Referenced installed classes are trusted code: their
INPUT_TYPES methods do execute.
"""

import json
import logging
import math
import os
import re

from .bundle import BUNDLE, MAX_FIELDS as BUNDLE_MAX_FIELDS
from .common import _lines
from .ids import RENAMED

_LOG = logging.getLogger("obvpm")

# A schema is user input that travels in shared files, so every list it
# can grow has a ceiling. None of these is a design limit anyone should
# meet; they are there so a malformed or hostile one fails fast.
MAX_SCHEMA_BYTES = 64 * 1024
MAX_FIELDS = 64
MAX_CHOICES = 8192
MAX_TEXT = 4096
MAX_PRESET_BYTES = 1024 * 1024

CUSTOM = "custom"

TEXT_KINDS = ("text", "string", "str")
BOOL_KINDS = ("bool", "boolean")
TRUE_WORDS = ("true", "1", "yes", "on")
FALSE_WORDS = ("false", "0", "no", "off")

_MISSING = object()

DEFAULT_SCHEMA = """# one field per line:  name: type [range] [= default]
# types: text | int | float | bool | choice a, b, c | @Node.input
steps: int 1..200 = 20
cfg: float 0..100 = 5.0
sampler: @SamplerName (obvpm).sampler_name
"""


class SchemaError(ValueError):
    """A schema line that cannot be read. Always quotes the line."""


def _fail(line_no, line, why):
    raise SchemaError(
        "Value Presets: schema line %d (%r) %s" % (line_no, line, why))


class Field:
    """One line of the schema: a name, a type, and how to check a value."""

    def __init__(self, name, kind, default_text="", choices=None,
                 ref=None, lo=None, hi=None):
        self.name = name
        self.kind = kind
        self.default_text = default_text
        self._choices = choices
        self.ref = ref
        self.lo = lo
        self.hi = hi

    # ---------------------------------------------------------- choices

    def choices(self):
        """The allowed values, or None for the free types.

        Resolved on every call rather than cached: the whole point of
        borrowing a loader's dropdown is that it tracks the folder, and
        a list frozen when the schema was parsed would not.
        """
        if self.ref is not None:
            return ref_choices(self.ref, self.name)
        return self._choices

    # ------------------------------------------------------------ value

    def default(self):
        text = self.default_text
        if not text:
            options = self.choices()
            if options:
                return options[0]
            return {"int": 0, "float": 0.0, "bool": False}.get(self.kind, "")
        return self.coerce(text, what="default")

    def coerce(self, value, what="value"):
        """The value as this field's type, or a refusal naming the field.

        REFUSES RATHER THAN CLAMPS. A preset carrying a LoRA that has
        since been deleted, or a number outside the range the schema
        declares, is a question the node cannot answer on its own -- and
        silently substituting the nearest legal thing would produce a
        take made with settings nobody chose. Presets arrive inside
        shared workflows, so "near enough" is not a safe default here.
        """
        options = self.choices()
        if options is not None:
            text = "" if value is None else str(value)
            if text not in options:
                raise ValueError(
                    "Value Presets: %s %r for field %r is not one of its "
                    "%d choices%s." % (what, text, self.name, len(options),
                                       _near(text, options)))
            return text
        if self.kind == "bool":
            return _as_bool(value, self.name, what)
        if self.kind in ("int", "float"):
            return self._number(value, what)
        text = "" if value is None else str(value)
        if len(text) > MAX_TEXT:
            raise ValueError(
                "Value Presets: %s for field %r is %d characters; the "
                "limit is %d." % (what, self.name, len(text), MAX_TEXT))
        return text

    def _number(self, value, what):
        try:
            number = int(value) if self.kind == "int" else float(value)
        except (TypeError, ValueError, OverflowError):
            raise ValueError(
                "Value Presets: %s %r for field %r is not %s."
                % (what, value, self.name,
                   "a whole number" if self.kind == "int" else "a number"))
        if isinstance(number, float) and not math.isfinite(number):
            raise ValueError("Value Presets: numbers must be finite")
        if self.lo is not None and number < self.lo:
            raise ValueError(
                "Value Presets: %s %s for field %r is below its minimum "
                "of %s." % (what, number, self.name, self.lo))
        if self.hi is not None and number > self.hi:
            raise ValueError(
                "Value Presets: %s %s for field %r is above its maximum "
                "of %s." % (what, number, self.name, self.hi))
        return number


def _near(text, options):
    """' Did you mean ...' when one option is obviously the intended one."""
    lowered = str(text).strip().lower()
    hit = [o for o in options if str(o).strip().lower() == lowered]
    if hit:
        return " Did you mean %r? (the check is case-sensitive)" % hit[0]
    if len(options) <= 8:
        return " It has: %s." % ", ".join(repr(o) for o in options)
    return ""


def _as_bool(value, name, what):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError("Value Presets: numbers must be finite")
        return bool(value)
    text = str(value or "").strip().lower()
    if text in TRUE_WORDS:
        return True
    if text in FALSE_WORDS:
        return False
    raise ValueError(
        "Value Presets: %s %r for field %r is not true or false."
        % (what, value, name))


def ref_choices(ref, field_name, descriptors=None):
    """The live options of another node's input, named `Node.input`.

    A DICT LOOKUP, never an import. `NODE_CLASS_MAPPINGS` holds the
    classes this ComfyUI already loaded at startup, so a schema can point
    at one but cannot bring one into being -- which is the whole
    difference between reading a name and running it.
    """
    node_name, _, input_name = str(ref or "").partition(".")
    node_name, input_name = node_name.strip(), input_name.strip()
    if not node_name or not input_name:
        raise ValueError(
            "Value Presets: field %r says %r; a borrowed dropdown is "
            "written @NodeName.input_name." % (field_name, ref))
    try:
        from nodes import NODE_CLASS_MAPPINGS
    except Exception:                      # pragma: no cover - no ComfyUI
        raise ValueError(
            "Value Presets: field %r borrows %s.%s, but the node registry "
            "is not available here." % (field_name, node_name, input_name))
    node_class = NODE_CLASS_MAPPINGS.get(node_name)
    if node_class is None and node_name in RENAMED:
        # a schema written before 0.2.0 names this pack's bare ids
        node_class = NODE_CLASS_MAPPINGS.get(RENAMED[node_name])
    if node_class is None:
        raise ValueError(
            "Value Presets: field %r borrows its choices from node %r, "
            "which is not installed. Install the pack that provides it, "
            "or give the field an explicit 'choice' list."
            % (field_name, node_name))
    try:
        if descriptors is None:
            spec = node_class.INPUT_TYPES()
        else:
            if node_class not in descriptors:
                try:
                    descriptors[node_class] = node_class.INPUT_TYPES()
                except Exception as exc:
                    descriptors[node_class] = exc
            spec = descriptors[node_class]
            if isinstance(spec, Exception):
                raise spec
    except Exception as why:
        raise ValueError(
            "Value Presets: field %r borrows %s.%s, but that node refused "
            "to describe its inputs (%s)."
            % (field_name, node_name, input_name, str(why)[:512]))
    for section in ("required", "optional"):
        entry = (spec.get(section) or {}).get(input_name)
        if entry is None:
            continue
        options = entry[0] if isinstance(entry, (list, tuple)) else entry
        if isinstance(options, (list, tuple)):
            if len(options) > MAX_CHOICES:
                raise ValueError("Value Presets: dropdown exceeds 8192 choices")
            if not all(isinstance(o, str) and len(o) <= MAX_TEXT for o in options):
                raise ValueError("Value Presets: dropdown choices must be strings of at most 4096 characters")
            if sum(len(o.encode("utf-8")) for o in options) > 256 * 1024:
                raise ValueError("Value Presets: dropdown exceeds 256 KiB")
            return list(options)
        raise ValueError(
            "Value Presets: field %r borrows %s.%s, but that input is not "
            "a dropdown -- only inputs offering a list of choices can be "
            "borrowed." % (field_name, node_name, input_name))
    raise ValueError(
        "Value Presets: field %r borrows %s.%s, but that node has no "
        "input called %r." % (field_name, node_name, input_name, input_name))


def parse_schema(text):
    """The schema text as Fields, in the order written.

    Hand-parsed, one line at a time. There is no expression to evaluate
    here and there must never be one: this text arrives inside shared
    workflows.
    """
    raw = str(text or "")
    if len(raw.encode("utf-8", "replace")) > MAX_SCHEMA_BYTES:
        raise SchemaError(
            "Value Presets: the schema is larger than %d KB."
            % (MAX_SCHEMA_BYTES // 1024))
    fields, seen = [], set()
    for number, line in enumerate(raw.splitlines(), start=1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if len(fields) >= MAX_FIELDS:
            raise SchemaError(
                "Value Presets: more than %d fields." % MAX_FIELDS)
        name, sep, rest = line.partition(":")
        name = name.strip()
        if not sep:
            _fail(number, line, "has no ':' -- write  name: type")
        if not name:
            _fail(number, line, "has no field name before the ':'")
        if name in seen:
            _fail(number, line, "repeats the field name %r" % name)
        seen.add(name)
        fields.append(_parse_type(number, line, name, rest.strip()))
    return fields


def _parse_type(number, line, name, rest):
    if not rest:
        _fail(number, line, "has no type after the ':'")
    if rest.startswith("@"):
        ref, _, default = rest[1:].partition("=")
        return Field(name, "choice", default.strip(), ref=ref.strip())
    kind, _, tail = rest.partition(" ")
    kind = kind.strip().lower()
    tail = tail.strip()
    if kind in TEXT_KINDS:
        return Field(name, "text", _default_of(tail))
    if kind in BOOL_KINDS:
        return Field(name, "bool", _default_of(tail))
    if kind == "choice":
        listed, _, default = tail.partition("=")
        options = [c.strip() for c in listed.split(",") if c.strip()]
        if not options:
            _fail(number, line, "is a choice with no options listed")
        if len(options) > MAX_CHOICES:
            _fail(number, line, "lists more than %d choices" % MAX_CHOICES)
        return Field(name, "choice", default.strip(), choices=options)
    if kind in ("int", "float"):
        span, _, default = tail.partition("=")
        lo, hi = _parse_range(number, line, kind, span.strip())
        return Field(name, kind, default.strip(), lo=lo, hi=hi)
    _fail(number, line,
          "has an unknown type %r -- use text, int, float, bool, "
          "'choice a, b, c', or @Node.input" % kind)


def _default_of(tail):
    """Everything after the first '=', or ''."""
    _, sep, default = tail.partition("=")
    return default.strip() if sep else ""


def _parse_range(number, line, kind, span):
    if not span:
        return (None, None)
    lo_text, sep, hi_text = span.partition("..")
    if not sep:
        _fail(number, line, "has a range %r; write it as  min..max" % span)
    cast = int if kind == "int" else float
    try:
        lo = cast(lo_text.strip()) if lo_text.strip() else None
        hi = cast(hi_text.strip()) if hi_text.strip() else None
    except ValueError:
        _fail(number, line, "has a range that is not numeric: %r" % span)
    if any(isinstance(v, float) and not math.isfinite(v) for v in (lo, hi)):
        _fail(number, line, "has a nonfinite range")
    if lo is not None and hi is not None and lo > hi:
        _fail(number, line, "has a range whose minimum is above its maximum")
    return (lo, hi)


def load_store(text, what):
    """A JSON widget as a dict. json.loads and nothing else, ever."""
    body = str(text or "").strip()
    if not body:
        return {}
    if len(body.encode("utf-8", "replace")) > MAX_PRESET_BYTES:
        raise ValueError(
            "Value Presets: the %s store is larger than %d KB."
            % (what, MAX_PRESET_BYTES // 1024))
    try:
        loaded = json.loads(body)
    except ValueError as why:
        raise ValueError(
            "Value Presets: the %s store is not valid JSON (%s)."
            % (what, why))
    if not isinstance(loaded, dict):
        raise ValueError(
            "Value Presets: the %s store must be a JSON object, got %s."
            % (what, type(loaded).__name__))
    return loaded


def resolve(schema, values, presets=None, preset=CUSTOM):
    """The bundle this node emits, and the fields it was built from.

    `values` is the one source of truth for what runs; `preset` is the
    label the UI put on it. They are checked against each other so a
    hand-edited prompt cannot claim a preset it is not running -- a
    workflow is embedded in every take this pack saves, and a label that
    lies about the settings is worse than no label.
    """
    fields = parse_schema(schema)
    if len(fields) > BUNDLE_MAX_FIELDS:
        _LOG.info(
            "Value Presets: %d fields; Unbundle exposes %d at a time, so "
            "hide fields in its config to reach the rest",
            len(fields), BUNDLE_MAX_FIELDS)
    stored = load_store(values, "values")
    # Read even when nothing consults it. A corrupt library is a real
    # loss -- the run would succeed, the presets would be gone, and the
    # next save would write over the wreckage without anyone having been
    # told. Saying so while the JSON is still there is the only moment
    # that helps.
    library = load_store(presets, "presets") if presets is not None else {}
    packed = {}
    for field in fields:
        held = stored.get(field.name, _MISSING)
        packed[field.name] = (field.default() if held is _MISSING
                              else field.coerce(held))
    extra = [name for name in stored if name not in packed]
    if extra:
        # not an error: a value left over from a deleted field is exactly
        # what a name-keyed store is supposed to survive
        _LOG.info("Value Presets: ignoring stored value(s) for %s, which "
                  "the schema no longer has", ", ".join(sorted(extra)))
    _check_label(packed, library, preset, fields)
    return packed, fields


def _check_label(packed, library, preset, fields=()):
    name = str(preset or "").strip()
    if not name or name == CUSTOM:
        return
    saved = library.get(name)
    if not isinstance(saved, dict):
        return
    # Over the schema's fields, as the UI compares: a field the preset
    # was saved without is taken at its default, so a new field moved
    # off its default counts as a change from the preset.
    differs = []
    for field in fields:
        key = field.name
        if key not in packed:
            continue
        if key in saved:
            expected = saved[key]
        else:
            try:
                expected = field.default()
            except ValueError:
                continue
        if str(packed[key]) != str(expected):
            differs.append(key)
    if differs:
        # A statement, not a complaint: editing a value while a preset is
        # loaded is an ordinary thing to do, and the node says so on its
        # face. What matters is that the RECORD is honest -- this line
        # and the saved workflow both say "based on that preset, with
        # these changed" rather than naming a preset the run did not use.
        _LOG.info(
            "Value Presets: running preset %r with %s changed",
            name, ", ".join(sorted(differs)))


def describe(schema):
    """The schema as JSON-able field descriptions, choices resolved.

    ONE PARSER, not two. The browser has to draw a control per field and
    could read the schema itself, but then the rule for what a line means
    would live in two languages and drift the first time either moved --
    which is the failure this whole node exists to remove. So the server
    answers, and the widgets are drawn from what it says.

    A field that cannot resolve reports its own error and degrades to
    text rather than sinking the schema: the other fields are still
    usable, the broken one still SHOWS the value it holds, and `resolve`
    refuses at run time so nothing silently runs on it.
    """
    described = []
    descriptors = {}
    for field in parse_schema(schema):
        entry = {"name": field.name, "kind": field.kind,
                 "ref": field.ref, "lo": field.lo, "hi": field.hi,
                 # the default AS WRITTEN, so the schema editor can
                 # rebuild the line it came from without inventing one
                 "default_text": field.default_text}
        try:
            if field.ref is not None:
                field._choices = ref_choices(field.ref, field.name, descriptors)
                field.ref = None  # this request only; default/coerce reuse the snapshot
            entry["choices"] = field.choices()
            entry["default"] = field.default()
        except ValueError as why:
            entry["choices"] = None
            entry["default"] = field.default_text
            entry["error"] = str(why)
        described.append(entry)
    return described


_MY_FOLDER = os.path.basename(os.path.dirname(os.path.abspath(__file__)))


def _pack_of(module):
    """(label, rank, mine, core) for a node class's `__module__`.

    ComfyUI names a custom pack's modules after the file path it loaded
    them from ("c:/.../custom_nodes/<folder>/..." or
    "custom_nodes.<folder>.nodes"), and core's after the module
    ("nodes", "comfy_extras.nodes_x", or the path of that file). The
    label is the pack FOLDER, which is what a user recognises; core is
    one group called "ComfyUI core". Rank orders the picker: this pack, then
    core, then everyone else.
    """
    text = str(module or "").replace("\\", "/")
    parts = [p for p in re.split(r"[/.]", text) if p]
    if "custom_nodes" in parts:
        after = parts[parts.index("custom_nodes") + 1:]
        label = after[0] if after else "custom_nodes"
        mine = label.lower() == _MY_FOLDER.lower()
        return label, (0 if mine else 2), mine, False
    return "ComfyUI core", 1, False, True


def _own_pack(node_class):
    """Which pack a node class came from -- see `_pack_of`."""
    return _pack_of(getattr(node_class, "__module__", ""))


def _hidden_from_picker(node_name, input_name):
    """This pack's dropdowns that only repeat another entry.

    Every optional gate carries the same two-value `on_empty`; one entry
    (the Any gate's) is enough to borrow it from.
    """
    return (input_name == "on_empty"
            and not str(node_name).startswith("AnyOptionalGate"))


def catalogue():
    """Every borrowable dropdown on this install: (node, input, choices).

    What the schema editor's type picker offers. Scanned rather than
    listed, so a pack installed today shows up today.

    `INPUT_TYPES()` is called on every installed class, which is what
    ComfyUI itself does for `/object_info` -- but one node raising must
    not empty the list, so each is guarded on its own. The counts are a
    snapshot for browsing; the values a field actually validates against
    are resolved fresh by `describe` every time the node is built.
    """
    try:
        from nodes import NODE_CLASS_MAPPINGS
    except Exception:                      # pragma: no cover - no ComfyUI
        return []
    found = []
    for node_name, node_class in list(NODE_CLASS_MAPPINGS.items()):
        try:
            spec = node_class.INPUT_TYPES()
        except Exception:
            continue                       # its own problem, not ours
        pack, rank, mine, core = _own_pack(node_class)
        for section in ("required", "optional"):
            for input_name, entry in (spec.get(section) or {}).items():
                if mine and _hidden_from_picker(node_name, input_name):
                    continue
                options = entry[0] if isinstance(entry, (list, tuple)) \
                    else entry
                if not (isinstance(options, (list, tuple)) and options
                        and len(options) <= MAX_CHOICES
                        and all(isinstance(o, str) and len(o) <= MAX_TEXT for o in options)):
                    continue
                item = {
                    "node": node_name, "input": input_name,
                    "count": len(options),
                    # enough to recognise the list, not enough to ship a
                    # few thousand LoRA filenames to a dropdown menu
                    "sample": list(options[:6]),
                    "pack": pack, "mine": mine, "core": core, "rank": rank,
                }
                found.append(item)
    # grouped by pack: this pack, then core, then the rest alphabetically
    found.sort(key=lambda t: (t["rank"], t["pack"].lower(), t["node"].lower(),
                              t["input"].lower()))
    return found


def register():
    """The schema route. Guarded by the caller: no server, no route."""
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.post("/obvpm/presets/schema")
    async def _schema(request):
        try:
            data = await request.json()
            return web.json_response(
                {"fields": describe(str(data.get("schema", "")))})
        except ValueError as why:
            # a schema being edited is malformed most of the time; that
            # is a state to show in the node, not a server error to log
            return web.json_response({"error": str(why)}, status=200)
        except Exception as exc:
            _LOG.exception("Value Presets: schema route failed")
            return web.json_response({"error": str(exc)}, status=400)

    @PromptServer.instance.routes.get("/obvpm/presets/types")
    async def _types(request):
        import asyncio
        try:
            # off the event loop: some nodes list a models folder while
            # describing themselves, and there are a lot of nodes
            return web.json_response(
                {"types": await asyncio.to_thread(catalogue)})
        except Exception as exc:
            _LOG.exception("Value Presets: type catalogue failed")
            return web.json_response({"error": str(exc)}, status=400)


class ValuePresets:
    CATEGORY = "obvpm/bundle"
    FUNCTION = "pack"
    RETURN_TYPES = (BUNDLE,)
    RETURN_NAMES = ("bundle",)
    DESCRIPTION = (
        "Named sets of values on one wire. Describe the fields once in "
        "'schema' -- name, type and default, one per line -- and the node "
        "grows a control for each, then save what you have set as a "
        "preset and switch between them. Everything is stored BY NAME, so "
        "editing the schema does not disturb the presets: a new field "
        "arrives at its default, a deleted one is ignored, and reordering "
        "changes nothing. A field can borrow another node's dropdown "
        "(@LoraName.lora_name) and then tracks that list instead of a "
        "copy of it. Outputs an ordinary bundle -- Unbundle it (hide "
        "fields in its config to take a subset)."
    )
    OUTPUT_TOOLTIPS = (
        "The fields as one value, keyed by name, in schema order.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "schema": ("STRING", {
                    "default": DEFAULT_SCHEMA,
                    "multiline": True,
                    "tooltip": "The template: one field per line, written "
                               "name: type [range] [= default]. Types are "
                               "text, int, float, bool, 'choice a, b, c', "
                               "and @Node.input to borrow another node's "
                               "dropdown. Lines starting with # are "
                               "ignored. A default follows '=', so a "
                               "choice cannot contain one.",
                }),
                "preset": ("STRING", {
                    "default": CUSTOM,
                    "tooltip": "Which saved set is loaded. 'custom' is "
                               "whatever you have set by hand; the name "
                               "is a label on the values, which are what "
                               "actually runs.",
                }),
            },
            "optional": {
                # Owned by the UI, hidden there. One opaque channel each,
                # so the node's signature never follows the schema.
                "values": ("STRING", {"default": "{}", "multiline": True}),
                "presets": ("STRING", {"default": "{}", "multiline": True}),
                # Mirrors the schema's field names so a downstream
                # Unbundle traces this node exactly as it traces a
                # Bundle -- see bundleNamesFor in web/obvpm_dynamic.js,
                # which looks for a widget called `names`.
                "names": ("STRING", {"default": "", "multiline": True}),
            },
        }

    def pack(self, schema, preset, values="{}", presets="{}", names=""):
        packed, _fields = resolve(schema, values, presets, preset)
        return (packed,)
