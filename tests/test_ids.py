"""Every registered id is namespaced, the frontend's copy of the rename
table matches the server's, and the replacement specs cover each node.

Run: python -s -m unittest tests.test_ids   (from the pack's parent)
"""
import json
import os
import re
import sys
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.dirname(HERE)


class _Anything(types.ModuleType):
    """A module that answers `from it import Whatever` with a dummy class,
    so the pack's modules import without ComfyUI on the path."""
    __path__ = []

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return type(name, (), {"__init__": lambda self, *a, **k: None})


def _stub(name, **attrs):
    mod = _Anything(name) if not attrs else types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    return sys.modules.setdefault(name, mod)


def _load_pack():
    """Import the pack without a ComfyUI checkout on sys.path."""
    samplers = _stub("comfy.samplers", SCHEDULER_HANDLERS={}, SCHEDULER_NAMES=[],
                     SchedulerHandler=lambda *a, **k: None,
                     beta_scheduler=lambda *a, **k: None,
                     KSampler=types.SimpleNamespace(SCHEDULERS=[], SAMPLERS=[]))
    _stub("comfy", samplers=samplers)
    _stub("nodes", NODE_CLASS_MAPPINGS={})
    # no node_replace_manager: register_replacements must then be a no-op
    _stub("server", PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace()))
    for name in ("torch", "numpy", "comfy.utils", "comfy.model_management",
                 "folder_paths", "node_helpers", "aiohttp", "aiohttp.web", "av",
                 "comfy_execution", "comfy_execution.graph_utils", "safetensors",
                 "safetensors.torch", "comfy_api", "comfy_api.latest", "PIL",
                 "PIL.Image", "PIL.ImageOps", "PIL.ImageSequence"):
        _stub(name)
    # The pack folder is named with a hyphen, so it cannot be named in
    # an import statement. A package that points at the folder can, and
    # its __init__ loads as an ordinary submodule -- with __package__
    # set, so the pack's relative imports resolve through this package.
    pack = types.ModuleType(PACK_NAME)
    pack.__path__ = [PACK]
    sys.modules[PACK_NAME] = pack
    # (`from pkg import __init__` would hand back the package object's own
    # __init__ method; the submodule form binds it under its dotted name)
    import obvpm_pack_under_test.__init__  # noqa: E402,F401
    loaded = sys.modules[PACK_NAME + ".__init__"]
    pack.NODE_CLASS_MAPPINGS = loaded.NODE_CLASS_MAPPINGS
    pack.NODE_DISPLAY_NAME_MAPPINGS = loaded.NODE_DISPLAY_NAME_MAPPINGS
    return pack


PACK_NAME = "obvpm_pack_under_test"


def _renamed_from_js():
    with open(os.path.join(PACK, "web", "obvpm_migrate.js"), encoding="utf-8") as fh:
        src = fh.read()
    body = re.search(r"export const RENAMED = \{(.*?)\n\};", src, re.S).group(1)
    return dict(re.findall(r'^\s+(\w+): "([^"]+)",', body, re.M))


class RenameTable(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # The stubs must not leak into the other test modules, which
        # import the real torch and PIL: restore sys.modules afterwards.
        cls._modules_before = set(sys.modules)
        try:
            cls.pack = _load_pack()
        except Exception as e:  # pragma: no cover - environment
            # tearDownClass does not run after a failed setUpClass, and
            # the stubs are already in place by now
            cls.tearDownClass()
            raise unittest.SkipTest("pack import needs ComfyUI: %s" % e)
        cls.ids = sys.modules[cls.pack.__name__ + ".ids"]

    @classmethod
    def tearDownClass(cls):
        for name in set(sys.modules) - cls._modules_before:
            gone = sys.modules.pop(name)
            # `from PIL import ImageOps` also SETS PIL.ImageOps on the
            # real package, and a later import answers from that
            # attribute -- so the stub must come off the parent too
            parent, _, child = name.rpartition(".")
            holder = sys.modules.get(parent) if parent else None
            if holder is not None and getattr(holder, child, None) is gone:
                delattr(holder, child)

    def test_every_registered_id_is_suffixed(self):
        for key in self.pack.NODE_CLASS_MAPPINGS:
            self.assertTrue(key.endswith(" (obvpm)"), key)
        self.assertEqual(set(self.pack.NODE_CLASS_MAPPINGS),
                         set(self.pack.NODE_DISPLAY_NAME_MAPPINGS))

    def test_rename_targets_are_registered_and_sources_are_not(self):
        keys = set(self.pack.NODE_CLASS_MAPPINGS)
        self.assertEqual(set(self.ids.RENAMED.values()), keys)
        self.assertFalse(set(self.ids.RENAMED) & keys)

    def test_js_table_matches_python(self):
        self.assertEqual(_renamed_from_js(), self.ids.RENAMED)

    def test_replacement_specs(self):
        specs = self.ids.replacements(self.pack.NODE_CLASS_MAPPINGS)
        self.assertEqual(len(specs), len(self.ids.RENAMED))
        by_old = {s["old_node_id"]: s for s in specs}
        bundle = by_old["Bundle"]
        self.assertEqual(bundle["new_node_id"], "Bundle (obvpm)")
        names = [m["old_id"] for m in bundle["input_mapping"]]
        self.assertIn("in_1", names)
        self.assertIn("names", bundle["old_widget_ids"])
        for s in specs:
            for m in s["input_mapping"]:
                self.assertEqual(m["new_id"], m["old_id"])
            json.dumps(s)  # serialisable, as the registry's route needs

    def test_old_id_in_a_schema_ref_is_an_alias(self):
        presets = sys.modules[self.pack.__name__ + ".presets"]
        sys.modules["nodes"].NODE_CLASS_MAPPINGS = self.pack.NODE_CLASS_MAPPINGS
        try:
            old = presets.ref_choices("SchedulerName.scheduler", "f")
            new = presets.ref_choices("SchedulerName (obvpm).scheduler", "f")
            self.assertEqual(old, new)
            with self.assertRaises(ValueError):
                presets.ref_choices("NoSuchNode.scheduler", "f")
        finally:
            sys.modules["nodes"].NODE_CLASS_MAPPINGS = {}

    def test_registration_is_a_no_op_without_a_server(self):
        self.assertEqual(self.ids.register_replacements(self.pack.NODE_CLASS_MAPPINGS), 0)


if __name__ == "__main__":
    unittest.main()
