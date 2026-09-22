"""Value Presets: `when` conditions and `#` hints.

Runs without ComfyUI: `nodes` is stubbed the way test_security.py stubs
it, so borrowed dropdowns can be declared per test.
"""

import importlib
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if "obvpm_testpack" not in sys.modules:
    pack = types.ModuleType("obvpm_testpack")
    pack.__path__ = [str(ROOT)]
    sys.modules[pack.__name__] = pack
try:
    import torch  # noqa: F401
except ImportError:
    sys.modules.setdefault("torch", types.ModuleType("torch"))
if "nodes" not in sys.modules:
    stub = types.ModuleType("nodes")
    stub.NODE_CLASS_MAPPINGS = {}
    sys.modules["nodes"] = stub

presets = importlib.import_module("obvpm_testpack.presets")


def install(**classes):
    """Make these the installed node classes.

    Looked up at call time: test_security.py REPLACES the `nodes` stub
    at import, and under discover it is imported after this file.
    """
    mapping = sys.modules["nodes"].NODE_CLASS_MAPPINGS
    mapping.clear()
    mapping.update(classes)

SCHEMA = """
turbo_loader: choice off, normal, larryvrh = off   # which loader applies the LoRA
turbo_lora: @Loader.lora_name when turbo_loader != off  # the LoRA file
turbo_strength: float 0..1.00 = 1.0 when turbo_loader != off
spectrum: bool = false
spectrum_amount: int 0..10 = 3 when spectrum = true
steps: int = 20
"""


class Loader:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"lora_name": (["a.safetensors", "b.safetensors"],)}}


class WhenParsing(unittest.TestCase):
    def setUp(self):
        install(Loader=Loader)

    def test_tails_come_off_in_order(self):
        fields = {f.name: f for f in presets.parse_schema(SCHEMA)}
        self.assertEqual(fields["turbo_loader"].hint, "which loader applies the LoRA")
        self.assertIsNone(fields["turbo_loader"].when)
        self.assertEqual(fields["turbo_loader"].default_text, "off")
        lora = fields["turbo_lora"]
        self.assertEqual(lora.ref, "Loader.lora_name")
        self.assertEqual(lora.hint, "the LoRA file")
        self.assertEqual((lora.when.field, lora.when.negate, lora.when.values),
                         ("turbo_loader", True, ["off"]))
        self.assertEqual(lora.when.text, "turbo_loader != off")
        strength = fields["turbo_strength"]
        self.assertEqual((strength.lo, strength.hi, strength.default_text, strength.span_text),
                         (0.0, 1.0, "1.0", "0..1.00"))
        self.assertEqual(strength.when.text, "turbo_loader != off")
        self.assertEqual(fields["spectrum_amount"].when.values, ["true"])
        self.assertEqual(fields["steps"].hint, "")

    def test_hint_may_say_when_and_a_default_may_be_anything_else(self):
        f = presets.parse_schema("a: text = go #b # when it is time")[0]
        self.assertEqual((f.default_text, f.hint), ("go", "b # when it is time"))
        f = presets.parse_schema("mode: choice fast, when, slow = when")[0]
        self.assertEqual((f.choices(), f.default_text), (["fast", "when", "slow"], "when"))
        f = presets.parse_schema("a#b: int = 3 #the hint")[0]
        self.assertEqual((f.name, f.hint), ("a#b", "the hint"))

    def test_bool_values_normalise_and_any_of_lists(self):
        f = presets.parse_schema("s: bool\nx: int when s = on, no")[1]
        self.assertEqual(f.when.values, ["true", "false"])
        self.assertEqual(f.when.text, "s = true, false")
        f = presets.parse_schema("m: choice a, b, c\nx: int when m = a, c")[1]
        self.assertTrue(f.when.holds("a"))
        self.assertTrue(f.when.holds("c"))
        self.assertFalse(f.when.holds("b"))
        f = presets.parse_schema("m: choice a, b, c\nx: int when m != a, c")[1]
        self.assertFalse(f.when.holds("a"))
        self.assertTrue(f.when.holds("b"))

    def test_refusals_name_the_line(self):
        cases = [
            ("x: int when y = 1", "not a field declared above"),
            ("x: int when x = 1", "depends on itself"),
            ("y: int\nx: int when y = 1", "only a choice or bool"),
            ("y: text\nx: int when y = a", "only a choice or bool"),
            ("y: choice a, b\nx: int when y = c", "not one of its choices"),
            ("y: choice a, b\nx: int when y", "not written"),
            ("y: choice a, b\nx: int when y =", "not written"),
            ("y: bool\nx: int when y = maybe", "not true or false"),
            ("x: int when y = 1\ny: choice 1, 2", "not a field declared above"),
        ]
        for schema, why in cases:
            with self.assertRaises(presets.SchemaError, msg=schema) as caught:
                presets.parse_schema(schema)
            self.assertIn(why, str(caught.exception), schema)
            self.assertIn("schema line", str(caught.exception))

    def test_a_borrowed_list_is_checked_at_run_time_not_parse_time(self):
        # the loader's list is live, so the parser cannot know it
        presets.parse_schema("l: @Loader.lora_name\nx: int when l = z.safetensors")


class WhenResolving(unittest.TestCase):
    def setUp(self):
        install(Loader=Loader)

    def test_hidden_fields_are_none_whatever_is_stored(self):
        packed, _ = presets.resolve(
            SCHEMA, '{"turbo_loader": "off", "turbo_lora": "a.safetensors", '
                    '"turbo_strength": 0.5, "spectrum": false, "spectrum_amount": 7}')
        self.assertEqual(packed, {
            "turbo_loader": "off", "turbo_lora": None, "turbo_strength": None,
            "spectrum": False, "spectrum_amount": None, "steps": 20})
        # still in schema order, hidden or not: names on the bundle are
        # what Unbundle traces
        self.assertEqual(list(packed), ["turbo_loader", "turbo_lora", "turbo_strength",
                                        "spectrum", "spectrum_amount", "steps"])

    def test_shown_fields_carry_their_values(self):
        packed, _ = presets.resolve(
            SCHEMA, '{"turbo_loader": "normal", "turbo_lora": "b.safetensors", '
                    '"turbo_strength": 0.5, "spectrum": true, "spectrum_amount": 7}')
        self.assertEqual(packed["turbo_lora"], "b.safetensors")
        self.assertEqual(packed["turbo_strength"], 0.5)
        self.assertEqual(packed["spectrum_amount"], 7)

    def test_a_hidden_field_is_not_coerced(self):
        # a deleted LoRA behind an off switch must not refuse the run...
        packed, _ = presets.resolve(
            SCHEMA, '{"turbo_loader": "off", "turbo_lora": "gone.safetensors"}')
        self.assertIsNone(packed["turbo_lora"])
        # ... but the same value shown is still refused
        with self.assertRaises(ValueError):
            presets.resolve(SCHEMA, '{"turbo_loader": "normal", "turbo_lora": "gone.safetensors"}')

    def test_the_default_decides_when_nothing_is_stored(self):
        packed, _ = presets.resolve("s: bool = true\nx: int = 4 when s = true", "{}")
        self.assertEqual(packed, {"s": True, "x": 4})
        packed, _ = presets.resolve("s: bool\nx: int = 4 when s = true", "{}")
        self.assertEqual(packed, {"s": False, "x": None})

    def test_a_field_decided_by_a_hidden_field_is_hidden(self):
        schema = ("a: bool = false\n"
                  "b: choice x, y = y when a = true\n"
                  "c: int = 1 when b != x\n")
        # b is hidden (a is false), so c is hidden although b != x holds
        packed, _ = presets.resolve(schema, "{}")
        self.assertEqual(packed, {"a": False, "b": None, "c": None})
        packed, _ = presets.resolve(schema, '{"a": true}')
        self.assertEqual(packed, {"a": True, "b": "y", "c": 1})

    def test_a_numeric_choice_decides_by_its_text(self):
        install(Depth=type("Depth", (), {"INPUT_TYPES": classmethod(
            lambda cls: {"required": {"bit_depth": (["auto", 8, 10],)}})}))
        schema = "depth: @Depth.bit_depth\nfast: bool = true when depth = 8, 10"
        packed, _ = presets.resolve(schema, '{"depth": "8"}')
        self.assertEqual(packed, {"depth": 8, "fast": True})
        packed, _ = presets.resolve(schema, '{"depth": "auto"}')
        self.assertEqual(packed, {"depth": "auto", "fast": None})

    def test_describe_carries_the_condition_and_the_hint(self):
        described = {f["name"]: f for f in presets.describe(SCHEMA)}
        lora = described["turbo_lora"]
        self.assertEqual(lora["when"], {"field": "turbo_loader", "not": True, "values": ["off"]})
        self.assertEqual(lora["when_text"], "turbo_loader != off")
        self.assertEqual(lora["hint"], "the LoRA file")
        self.assertEqual(lora["choices"], ["a.safetensors", "b.safetensors"])
        self.assertIsNone(described["steps"]["when"])
        self.assertEqual(described["steps"]["when_text"], "")
        self.assertEqual(described["spectrum_amount"]["when"]["values"], ["true"])

    def test_the_label_check_ignores_hidden_fields(self):
        library = '{"p": {"turbo_loader": "off", "turbo_lora": "a.safetensors", "steps": 20}}'
        with self.assertLogs("obvpm", level="INFO") as logged:
            presets._LOG.info("marker")
            presets.resolve(SCHEMA, '{"turbo_loader": "off", "turbo_lora": "b.safetensors"}',
                            library, "p")
        self.assertFalse([m for m in logged.output if "changed" in m], logged.output)
        with self.assertLogs("obvpm", level="INFO") as logged:
            presets.resolve(SCHEMA, '{"turbo_loader": "off", "steps": 8}', library, "p")
        self.assertTrue([m for m in logged.output if "steps changed" in m], logged.output)


if __name__ == "__main__":
    unittest.main()
