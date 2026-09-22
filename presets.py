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

DEFAULT_SCHEMA = """# one field per line:  name: type [range] [= default] [when field = value] [# hint]
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


class When:
    """`when field = a, b` / `when field != a, b`: the one condition a
    field may carry.

    A LOOKUP, not an expression. It names a choice or bool field
    declared above and lists the values that show this one; the only
    operators are = and !=. That is all a settings panel needs (a LoRA
    picker that appears once the loader is on), and it keeps the rule
    the docstring at the top of this file states: schema text arrives
    inside shared workflows and is only ever read as data.
    """

    def __init__(self, field, negate, values, text):
        self.field = field
        self.negate = negate
        self.values = values
        # AS WRITTEN (normalised), so the schema editor hands it back
        self.text = text

    def holds(self, value):
        """Whether `value` -- the deciding field's resolved value --
        shows the field carrying this condition."""
        if isinstance(value, bool):
            text = "true" if value else "false"
        else:
            text = str(value)
        return (text in self.values) != self.negate


class Field:
    """One line of the schema: a name, a type, and how to check a value."""

    def __init__(self, name, kind, default_text="", choices=None,
                 ref=None, lo=None, hi=None, span_text="", decimals=None,
                 when=None, hint=""):
        self.name = name
        self.kind = kind
        self.default_text = default_text
        self._choices = choices
        self.ref = ref
        self.lo = lo
        self.hi = hi
        # the range AS WRITTEN, so the schema editor can hand it back
        # unchanged (0..1.00 must not come back as 0..1)
        self.span_text = span_text
        # how many decimals a float shows and steps by: as many as the
        # range was written with, two when it names none
        self.decimals = decimals
        # `when ...`: shown (and emitted) only while it holds -- see When
        self.when = when
        # `# ...` after the type: what the widget says on hover
        self.hint = hint

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
            for option in options:
                # compared as text -- a preset arrives as JSON, where a
                # borrowed numeric choice may have become "8" -- but the
                # value handed on is the option AS THE NODE DECLARED IT,
                # 8 and not "8", which is the only form core's validator
                # and the node's own arithmetic accept
                if text == str(option):
                    return option
            raise ValueError(
                "Value Presets: %s %r for field %r is not one of its "
                "%d choices%s." % (what, text, self.name, len(options),
                                   _near(text, options)))
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


def _combo_options(entry):
    """The choices an INPUT_TYPES entry offers, as text, or None.

    TWO DECLARATIONS MEAN THE SAME THING. A V1 node writes the list in
    slot 0 -- ("euler", "heun") as (["euler", "heun"], {...}). A V3 node
    declares a Combo input instead, and core converts it back for V1 in
    `add_to_dict_v1` by putting the io_type in slot 0 and moving the
    list into the options dict -- ("COMBO", {"options": [...]}). On a
    current install more than half of every dropdown is the second
    shape, so reading slot 0 alone makes those inputs look like plain
    sockets with nothing to borrow.

    A remote combo names a route rather than a list (LoadImageOutput's
    image is the one on a stock install): there is no list to read here
    and it reads as None, the same as a non-dropdown.
    """
    if not isinstance(entry, (list, tuple)) or not entry:
        return None
    first = entry[0]
    if isinstance(first, (list, tuple)):
        options = first
    elif first == "COMBO":
        extra = entry[1] if len(entry) > 1 and isinstance(entry[1], dict) else {}
        options = extra.get("options")
        if not isinstance(options, (list, tuple)):
            return None
    else:
        return None
    # A combo may list numbers -- CreateVideo's bit_depth is 'auto', 8,
    # 10. Each option is kept AS DECLARED rather than turned into text,
    # because core validates a queued value with `val not in options`
    # and coerces nothing on the way: hand it "8" where the node wrote
    # 8 and the prompt is refused with "Value not in list", and the
    # node's own `bit_depth >= 10` would raise on a string besides.
    # Matching by text happens in `coerce`, which returns the option
    # itself. Anything but a number or a string is not a value a preset
    # could carry, and such a list is refused whole rather than thinned.
    for option in options:
        if isinstance(option, bool) or not isinstance(option, (str, int, float)):
            return None
    return list(options)


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
        options = _combo_options(entry)
        if options is not None:
            if len(options) > MAX_CHOICES:
                raise ValueError("Value Presets: dropdown exceeds 8192 choices")
            if not all(len(str(o)) <= MAX_TEXT for o in options):
                raise ValueError("Value Presets: dropdown choices must be strings of at most 4096 characters")
            if sum(len(str(o).encode("utf-8")) for o in options) > 256 * 1024:
                raise ValueError("Value Presets: dropdown exceeds 256 KiB")
            return options
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
        spec, when_text, hint = _split_tail(rest.strip())
        field = _parse_type(number, line, name, spec)
        if when_text is not None:
            field.when = _parse_when(number, line, name, when_text, fields)
        field.hint = hint
        fields.append(field)
    return fields


# a line's optional tails: ` when field = a, b` and ` # a hint`, in
# that order, each introduced by whitespace so a name like `a#b` or a
# choice called `when` is left alone
_HINT_AT = re.compile(r"\s#")
_WHEN_AT = re.compile(r"\swhen\s")


def _split_tail(rest):
    """(type spec, when text or None, hint) from everything after the ':'.

    The hint comes off first, at the FIRST ` #`, so it may say anything
    -- including 'when'. What is left is split at the first ` when `.
    A default therefore cannot contain ' #' or ' when '; the syntax
    line in DEFAULT_SCHEMA says so by showing the order.
    """
    hint = ""
    at = _HINT_AT.search(rest)
    if at:
        hint = rest[at.end():].strip()
        rest = rest[:at.start()].rstrip()
    when_text = None
    at = _WHEN_AT.search(rest)
    if at:
        when_text = rest[at.end():].strip()
        rest = rest[:at.start()].rstrip()
    return rest, when_text, hint


_WHEN_SHAPE = re.compile(r"^(.+?)\s*(!=|=)\s*(.*)$")


def _parse_when(number, line, name, text, above):
    """A `when` clause checked against the fields declared before it."""
    shape = _WHEN_SHAPE.match(text)
    if not shape or not shape.group(3).strip():
        _fail(number, line, "has a 'when' that is not written  "
              "when field = value  or  when field != value, other")
    deciding, op, listed = shape.groups()
    deciding = deciding.strip()
    if deciding == name:
        _fail(number, line, "depends on itself")
    target = next((f for f in above if f.name == deciding), None)
    if target is None:
        _fail(number, line, "depends on %r, which is not a field declared "
              "above it" % deciding)
    if target.kind not in ("choice", "bool"):
        _fail(number, line, "depends on %r, which is %s -- only a choice "
              "or bool field can decide whether another is shown"
              % (deciding, {"int": "a whole number", "float": "a number"}
                 .get(target.kind, "text")))
    values = [v.strip() for v in listed.split(",") if v.strip()]
    if target.kind == "bool":
        try:
            values = ["true" if _as_bool(v, deciding, "when") else "false"
                      for v in values]
        except ValueError:
            _fail(number, line, "compares %r, a bool, with something that "
                  "is not true or false" % deciding)
    elif target._choices is not None:
        # an explicit list can be checked now; a borrowed one is read
        # live and is checked when the node runs
        known = [str(c) for c in target._choices]
        odd = [v for v in values if v not in known]
        if odd:
            _fail(number, line, "compares %r with %s, which is not one of "
                  "its choices%s" % (deciding, ", ".join(repr(v) for v in odd),
                                     _near(odd[0], known)))
    return When(deciding, op == "!=", values,
                "%s %s %s" % (deciding, op, ", ".join(values)))


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
        span = span.strip()
        lo, hi, typed = _parse_range(number, line, kind, span)
        decimals = 0 if kind == "int" else (
            typed if typed is not None else DEFAULT_DECIMALS)
        return Field(name, kind, default.strip(), lo=lo, hi=hi,
                     span_text=span, decimals=decimals)
    _fail(number, line,
          "has an unknown type %r -- use text, int, float, bool, "
          "'choice a, b, c', or @Node.input" % kind)


def _default_of(tail):
    """Everything after the first '=', or ''."""
    _, sep, default = tail.partition("=")
    return default.strip() if sep else ""


# a float range written without decimals (0..1) shows this many
DEFAULT_DECIMALS = 2
MAX_DECIMALS = 6


def _decimals_of(text):
    """How many digits follow the point in a number as typed, or None."""
    text = text.strip().lower()
    if "e" in text or "." not in text:
        return None
    return len(text.rsplit(".", 1)[1])


def _parse_range(number, line, kind, span):
    """(min, max, decimals as typed): 0..1.0 asks for one decimal,
    0..1.00 for two, 0..1 for none in particular (None)."""
    if not span:
        return (None, None, None)
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
    typed = [d for d in (_decimals_of(lo_text), _decimals_of(hi_text))
             if d is not None]
    decimals = min(max(typed), MAX_DECIMALS) if typed else None
    return (lo, hi, decimals)


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
    shown = {}
    for field in fields:
        # A field whose condition does not hold is None on the bundle,
        # WHATEVER IS STORED -- the store keeps the value so it comes
        # back when the condition holds again, but a hidden turbo LoRA
        # must not be applied because a name was still sitting in the
        # JSON. Not coerced either: a file that has since been deleted
        # is no reason to refuse a run that was not going to use it.
        shown[field.name] = is_shown(field, shown, packed)
        if not shown[field.name]:
            packed[field.name] = None
            continue
        held = stored.get(field.name, _MISSING)
        packed[field.name] = (field.default() if held is _MISSING
                              else field.coerce(held))
    extra = [name for name in stored if name not in packed]
    if extra:
        # not an error: a value left over from a deleted field is exactly
        # what a name-keyed store is supposed to survive
        _LOG.info("Value Presets: ignoring stored value(s) for %s, which "
                  "the schema no longer has", ", ".join(sorted(extra)))
    _check_label(packed, library, preset, fields, shown)
    return packed, fields


def is_shown(field, shown, packed):
    """Whether `field` is shown, given the fields resolved before it.

    `shown` and `packed` cover the fields above it, which is where its
    deciding field must be. A field decided by one that is itself
    hidden is hidden too: what nobody can see cannot decide anything.
    The browser applies the same rule to the widgets it built (see
    web/value_presets.js isShown), from the condition this module
    parsed and described -- the rule lives in two places, the parser
    in one.
    """
    if field.when is None:
        return True
    if not shown.get(field.when.field, False):
        return False
    return field.when.holds(packed[field.when.field])


def _check_label(packed, library, preset, fields=(), shown=None):
    name = str(preset or "").strip()
    if not name or name == CUSTOM:
        return
    saved = library.get(name)
    if not isinstance(saved, dict):
        return
    # Over the schema's fields, as the UI compares: a field the preset
    # was saved without is taken at its default, so a new field moved
    # off its default counts as a change from the preset. A hidden
    # field is None here whatever the preset holds, so it is skipped.
    differs = []
    for field in fields:
        key = field.name
        if key not in packed or (shown is not None and not shown.get(key)):
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
                 "span": field.span_text, "decimals": field.decimals,
                 # the default AS WRITTEN, so the schema editor can
                 # rebuild the line it came from without inventing one
                 "default_text": field.default_text,
                 "hint": field.hint,
                 # the condition parsed, for the widgets to apply, and
                 # as written, for the schema editor to hand back
                 "when": None if field.when is None else {
                     "field": field.when.field, "not": field.when.negate,
                     "values": list(field.when.values)},
                 "when_text": "" if field.when is None else field.when.text}
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
                options = _combo_options(entry)
                if not (options and len(options) <= MAX_CHOICES
                        and all(len(str(o)) <= MAX_TEXT for o in options)):
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
        "copy of it, can be shown only while another field holds a "
        "value ('when turbo = on'; hidden, it is None on the bundle), "
        "and can carry a hint ('# ...'). Outputs an ordinary bundle -- "
        "Unbundle it (hide fields in its config to take a subset)."
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
                               "dropdown. A float range sets the decimals "
                               "shown: 0..1.0 one, 0..1.00 two, 0..1 two. "
                               "Lines starting with # are "
                               "ignored. A default follows '=', so a "
                               "choice cannot contain one. After the "
                               "default, 'when other_field = a, b' (or "
                               "!=) shows this field only while a choice "
                               "or bool field above it holds one of those "
                               "values; otherwise it is hidden and its "
                               "value on the bundle is None. Last, "
                               "' # text' is the hint shown on hover.",
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
