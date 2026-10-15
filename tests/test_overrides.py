"""Override Bundle Values: overrides checked against a Value Presets
schema (and its `when` lines applied again), typed overrides on plain
bundles, wired overrides, and the incoming bundle left untouched.

Runs without ComfyUI: `nodes` is stubbed as in test_presets_when.py.
"""

import json
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

from obvpm_testpack import presets  # noqa: E402
from obvpm_testpack import overrides as ov  # noqa: E402
from obvpm_testpack.bundle import SchemaBundle  # noqa: E402


class Loader:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"lora_name": (["a.safetensors", "b.safetensors"],)}}


def install(**classes):
    mapping = sys.modules["nodes"].NODE_CLASS_MAPPINGS
    mapping.clear()
    mapping.update(classes)


SCHEMA = """
steps: int 1..200 = 20
cfg: float 0..10.0 = 5.0
sampler: choice euler, heun = euler
turbo_loader: choice off, normal = off
turbo_lora: @Loader.lora_name when turbo_loader != off
turbo_strength: float 0..1.00 = 1.0 when turbo_loader != off
"""
VALUES = {"steps": 20, "cfg": 5.0, "sampler": "euler", "turbo_loader": "off",
          "turbo_lora": "b.safetensors", "turbo_strength": 0.7}


def preset_bundle(values=VALUES):
    (bundle,) = presets.ValuePresets().pack(SCHEMA, "custom", json.dumps(values), "{}")
    return bundle


def state(on=(), **values):
    return json.dumps({"fields": sorted(values), "on": list(on), "values": values})


class FromValuePresets(unittest.TestCase):
    def setUp(self):
        install(Loader=Loader)

    def test_the_preset_bundle_carries_its_schema_and_values(self):
        b = preset_bundle()
        self.assertIsInstance(b, SchemaBundle)
        self.assertEqual(b.obvpm_schema, SCHEMA)
        self.assertEqual(b.obvpm_values["turbo_lora"], "b.safetensors")
        # still an ordinary bundle to everything else
        self.assertEqual(dict(b)["steps"], 20)
        self.assertIsNone(b["turbo_lora"])          # hidden by its when line

    def test_an_override_replaces_the_value(self):
        out = ov.apply_overrides(preset_bundle(), state(on=["steps"], steps=8))
        self.assertEqual(out["steps"], 8)
        self.assertEqual(out["cfg"], 5.0)

    def test_toggled_off_passes_the_bundles_value(self):
        out = ov.apply_overrides(preset_bundle(), state(on=[], steps=8))
        self.assertEqual(out["steps"], 20)

    def test_the_incoming_bundle_is_untouched(self):
        b = preset_bundle()
        before = dict(b)
        out = ov.apply_overrides(b, state(on=["steps"], steps=8))
        self.assertIsNot(out, b)
        self.assertEqual(dict(b), before)
        self.assertEqual(b.obvpm_values["steps"], 20)

    def test_the_schema_checks_the_override(self):
        with self.assertRaisesRegex(ValueError, "above its maximum"):
            ov.apply_overrides(preset_bundle(), state(on=["steps"], steps=500))
        with self.assertRaisesRegex(ValueError, "not one of its"):
            ov.apply_overrides(preset_bundle(), state(on=["sampler"], sampler="dpm"))
        with self.assertRaisesRegex(ValueError, "Override Bundle Values"):
            ov.apply_overrides(preset_bundle(), state(on=["cfg"], cfg="lots"))

    def test_a_borrowed_choice_is_checked_live(self):
        out = ov.apply_overrides(preset_bundle(), state(
            on=["turbo_loader", "turbo_lora"], turbo_loader="normal",
            turbo_lora="a.safetensors"))
        self.assertEqual(out["turbo_lora"], "a.safetensors")
        with self.assertRaisesRegex(ValueError, "not one of its"):
            ov.apply_overrides(preset_bundle(), state(
                on=["turbo_loader", "turbo_lora"], turbo_loader="normal",
                turbo_lora="gone.safetensors"))

    def test_when_lines_apply_again(self):
        # turning the deciding field on brings back the fields it hides,
        # with the values the preset node holds for them
        out = ov.apply_overrides(preset_bundle(), state(
            on=["turbo_loader"], turbo_loader="normal"))
        self.assertEqual(out["turbo_lora"], "b.safetensors")
        self.assertEqual(out["turbo_strength"], 0.7)
        # and turning it off hides them again
        on_bundle = preset_bundle(dict(VALUES, turbo_loader="normal"))
        self.assertEqual(on_bundle["turbo_lora"], "b.safetensors")
        out = ov.apply_overrides(on_bundle, state(on=["turbo_loader"],
                                                  turbo_loader="off"))
        self.assertIsNone(out["turbo_lora"])
        self.assertIsNone(out["turbo_strength"])

    def test_overrides_chain(self):
        first = ov.apply_overrides(preset_bundle(), state(on=["steps"], steps=8))
        second = ov.apply_overrides(first, state(on=["cfg"], cfg=3.5))
        self.assertEqual((second["steps"], second["cfg"]), (8, 3.5))
        with self.assertRaisesRegex(ValueError, "below its minimum"):
            ov.apply_overrides(first, state(on=["steps"], steps=0))


class FromPlainBundles(unittest.TestCase):
    BUNDLE = {"steps": 20, "cfg": 5.0, "turbo": True, "name": "a", "image": object()}

    def test_typed_like_the_value_it_replaces(self):
        out = ov.apply_overrides(self.BUNDLE, state(
            on=["steps", "cfg", "turbo", "name"], steps="12", cfg=3, turbo="off",
            name=7))
        self.assertEqual(out["steps"], 12)
        self.assertIsInstance(out["cfg"], float)
        self.assertIs(out["turbo"], False)
        self.assertEqual(out["name"], "7")
        self.assertIs(out["image"], self.BUNDLE["image"])

    def test_refusals(self):
        with self.assertRaisesRegex(ValueError, "whole number"):
            ov.apply_overrides(self.BUNDLE, state(on=["steps"], steps=2.5))
        with self.assertRaisesRegex(ValueError, "no widget can set"):
            ov.apply_overrides(self.BUNDLE, state(on=["image"], image="x"))

    def test_a_missing_field_is_added(self):
        out = ov.apply_overrides(self.BUNDLE, state(on=["seed"], seed=4))
        self.assertEqual(out["seed"], 4)

    def test_not_a_bundle(self):
        with self.assertRaisesRegex(ValueError, "expected a bundle"):
            ov.apply_overrides([1, 2], state())

    def test_nothing_came_in(self):
        # a Get whose name no setter has hands on None (issue #47)
        with self.assertRaisesRegex(ValueError, "no bundle came in.*set_constant"):
            ov.apply_overrides(None, state())


class Wired(unittest.TestCase):
    def test_a_wired_value_replaces_the_field(self):
        image = object()
        out = ov.OverrideBundleValues().override(
            {"image": "old", "steps": 3}, state(), "steps\nimage",
            wire_2=image)
        (out,) = out
        self.assertIs(out["image"], image)
        self.assertEqual(out["steps"], 3)          # wire_1 unwired: passes

    def test_the_declared_pool(self):
        spec = ov.OverrideBundleValues.INPUT_TYPES()
        self.assertEqual(sorted(k for k in spec["optional"] if k.startswith("wire_")),
                         sorted("wire_%d" % i for i in range(1, ov.MAX_WIRES + 1)))

    def test_set_is_the_last_input_and_changes_nothing(self):
        # widgets_values is positional: a save from before `set` holds
        # state and wires only, so the new widget must come after them
        spec = ov.OverrideBundleValues.INPUT_TYPES()
        self.assertEqual(list(spec["optional"])[-1], "set")
        (a,) = ov.OverrideBundleValues().override({"steps": 3}, "{}", "")
        (b,) = ov.OverrideBundleValues().override({"steps": 3}, "{}", "", set="engine")
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
