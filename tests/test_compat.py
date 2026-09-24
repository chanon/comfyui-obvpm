"""Compatibility Check: the rules read as written, each result says what
was found and what to do, a broken check never blocks, and the node
refuses a run with the list.

Run: python -s -m unittest discover -s tests   (from the pack folder)
"""

import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if "obvpm_testpack" not in sys.modules:
    pack = types.ModuleType("obvpm_testpack")
    pack.__path__ = [str(ROOT)]
    sys.modules[pack.__name__] = pack
if "nodes" not in sys.modules:
    stub = types.ModuleType("nodes")
    stub.NODE_CLASS_MAPPINGS = {}
    sys.modules["nodes"] = stub

from obvpm_testpack import compat


def module_at(name, path):
    mod = types.ModuleType(name)
    mod.__file__ = path
    sys.modules[name] = mod
    return mod


def node_with_inputs(*names):
    def INPUT_TYPES():
        return {"required": {n: ("INT",) for n in names}}
    return type("Node", (), {"INPUT_TYPES": staticmethod(INPUT_TYPES)})


def core(version):
    mod = types.ModuleType("comfyui_version")
    mod.__version__ = version
    sys.modules["comfyui_version"] = mod


class Parsing(unittest.TestCase):
    def test_the_four_forms(self):
        rules = compat.parse_rules(
            "# a comment\n"
            "comfyui >= 0.35.0\n"
            "comfyui-obvpm >= 0.2.3   node: ValuePresets (obvpm)   https://github.com/chanon/comfyui-obvpm\n"
            "node Power Lora Loader (rgthree)   https://github.com/rgthree/rgthree-comfy   # rgthree-comfy\n"
            "node MinimaxH3LatentUpscaler3D has enable_temporal_chunking  # the original, not the Plus fork\n")
        self.assertEqual([r.kind for r in rules], ["core", "pack", "node", "node"])
        self.assertEqual(rules[0].version, (0, 35, 0))
        self.assertEqual((rules[1].name, rules[1].version, rules[1].node, rules[1].url),
                         ("comfyui-obvpm", (0, 2, 3), "ValuePresets (obvpm)",
                          "https://github.com/chanon/comfyui-obvpm"))
        self.assertEqual((rules[2].name, rules[2].input_name, rules[2].note),
                         ("Power Lora Loader (rgthree)", None, "rgthree-comfy"))
        self.assertEqual((rules[3].name, rules[3].input_name, rules[3].note),
                         ("MinimaxH3LatentUpscaler3D", "enable_temporal_chunking",
                          "the original, not the Plus fork"))

    def test_the_not_forms(self):
        rules = compat.parse_rules(
            "not node SomeForkNode   https://x.y/fork   # replaces a node we need\n"
            "not pack ComfyUI-Workflow-Encrypt\n")
        self.assertEqual([r.kind for r in rules], ["no_node", "no_pack"])
        self.assertEqual((rules[0].name, rules[0].url, rules[0].note),
                         ("SomeForkNode", "https://x.y/fork", "replaces a node we need"))
        self.assertEqual(rules[1].name, "ComfyUI-Workflow-Encrypt")
        for line in ("not", "not node", "not folder X", "not pack "):
            self.assertEqual(compat.parse_rules(line)[0].kind, "error", line)

    def test_a_line_that_cannot_be_read_is_a_failing_rule_not_a_refusal(self):
        # a pack rule no longer needs `node:` -- it is found by repository or name
        self.assertEqual(compat.parse_rules("obvpm >= 0.2.3")[0].kind, "pack")
        for line, why in (("comfyui >= new", "not written like 1.2.3"),
                          ("something else entirely", "not a rule this node knows"),
                          ("node", "names no node"),
                          ("node X has ", "missing the node or the input"),
                          ("https://only.a/link", "names nothing to check")):
            rules = compat.parse_rules(line)
            self.assertEqual(rules[0].kind, "error", line)
            self.assertFalse(rules[0].ok)
            self.assertIn(why, rules[0].detail, line)

    def test_note_may_contain_anything_and_a_name_may_contain_a_hash(self):
        rule = compat.parse_rule("node a#b has c   # node X has y https://x.y")
        self.assertEqual((rule.name, rule.input_name, rule.note, rule.url),
                         ("a#b", "c", "node X has y https://x.y", ""))

    def test_limits(self):
        with self.assertRaises(ValueError):
            compat.parse_rules("node X\n" * (compat.MAX_RULES + 1))
        with self.assertRaises(ValueError):
            compat.parse_rules(" " * (compat.MAX_RULES_BYTES + 1))


class Checking(unittest.TestCase):
    def setUp(self):
        sys.modules["nodes"].NODE_CLASS_MAPPINGS.clear()

    def test_core(self):
        for have, ok in (("0.34.0", False), ("0.35.0", True), ("0.37.0", True)):
            core(have)
            try:
                rule = compat.check("comfyui >= 0.35.0")[0]
            finally:
                del sys.modules["comfyui_version"]
            self.assertEqual(rule.ok, ok, have)
            if not ok:
                self.assertEqual(rule.title, "ComfyUI is too old")
                self.assertIn("0.34.0", rule.detail)
                self.assertIn("0.35.0", rule.detail)
                self.assertIn("Update ComfyUI", rule.fix)

    def test_pack_by_version(self):
        with Install({"comfyui-obvpm": dict(name="comfyui-obvpm", version="0.2.2",
                                            repo="https://github.com/chanon/comfyui-obvpm")}):
            rule = compat.check("comfyui-obvpm >= 0.2.3 https://github.com/chanon/comfyui-obvpm", {})[0]
            self.assertFalse(rule.ok)
            self.assertEqual(rule.title, "comfyui-obvpm needs updating")
            self.assertIn("0.2.2 is installed (custom_nodes/comfyui-obvpm)", rule.detail)
            self.assertIn("Update", rule.fix)
            rule = compat.check("comfyui-obvpm >= 0.2.2", {})[0]
            self.assertTrue(rule.ok)
            self.assertEqual(rule.title, "comfyui-obvpm 0.2.2")

    def test_pack_missing_or_without_a_version(self):
        with Install({"other": dict(name="other", version="1.0.0")}):
            rule = compat.check("some-pack >= 1.0 https://github.com/someone/some-pack", {})[0]
            self.assertFalse(rule.ok)
            self.assertEqual(rule.title, "some-pack is not installed")
            self.assertIn("github.com/someone/some-pack", rule.detail)
        with Install({"some-pack": dict(name="some-pack")}):       # no version in it
            rule = compat.check("some-pack >= 1.0", {})[0]
            self.assertTrue(rule.ok, "an unreadable version does not block")
            self.assertIn("version unknown", rule.title)


    def test_node_present_and_node_has_input(self):
        reg = {"MinimaxH3LatentUpscaler3D": node_with_inputs(
            "latent", "align", "keep_proportion", "device", "offload_after_upscale")}
        self.assertTrue(compat.check("node MinimaxH3LatentUpscaler3D", reg)[0].ok)
        rule = compat.check("node MinimaxH3LatentUpscaler3D has enable_temporal_chunking "
                            "https://github.com/LBH-123-AI/x # the original", reg)[0]
        self.assertFalse(rule.ok)
        self.assertEqual(rule.title, "The wrong MinimaxH3LatentUpscaler3D is installed")
        self.assertIn("fork", rule.detail)
        self.assertIn("see the link", rule.fix)
        self.assertEqual(rule.note, "the original")
        reg = {"MinimaxH3LatentUpscaler3D": node_with_inputs("enable_temporal_chunking")}
        self.assertTrue(compat.check("node MinimaxH3LatentUpscaler3D has enable_temporal_chunking", reg)[0].ok)
        rule = compat.check("node Missing", {})[0]
        self.assertFalse(rule.ok)
        self.assertEqual(rule.title, "Node Missing is not installed")

    def test_a_node_that_will_not_describe_itself_does_not_block(self):
        def INPUT_TYPES():
            raise RuntimeError("no models folder here")
        reg = {"N": type("N", (), {"INPUT_TYPES": staticmethod(INPUT_TYPES)})}
        rule = compat.check("node N has x", reg)[0]
        self.assertTrue(rule.ok)
        self.assertIn("could not be checked", rule.detail)

    def test_a_check_that_crashes_does_not_block(self):
        class Bad(dict):
            def get(self, *a):
                raise RuntimeError("registry on fire")
        rule = compat.check("node N", Bad())[0]
        self.assertTrue(rule.ok)
        self.assertEqual(rule.title, "Could not check")


    def test_not_node(self):
        registry = {}
        rule = compat.check("not node Fork", registry)[0]
        self.assertTrue(rule.ok)
        self.assertEqual(rule.title, "No node Fork")
        mod = module_at("obvpm_test_forkpack", "C:/x/custom_nodes/fork-pack/nodes.py")
        registry["Fork"] = type("Fork", (), {"__module__": mod.__name__})
        sys.modules["nodes"].LOADED_MODULE_DIRS = {"fork-pack": "C:/x/custom_nodes/fork-pack", "C:/x/comfy_extras/nodes_core": "C:/x/comfy_extras/nodes_core"}
        try:
            rule = compat.check("not node Fork  # breaks X", registry)[0]
        finally:
            del sys.modules["nodes"].LOADED_MODULE_DIRS
        self.assertFalse(rule.ok)
        self.assertEqual(rule.title, "Node Fork must not be installed")
        self.assertIn("custom_nodes/fork-pack", rule.detail)
        self.assertIn("Uninstall", rule.fix)
        self.assertEqual(rule.note, "breaks X")

    def test_not_pack_by_folder_name_any_case(self):
        sys.modules["nodes"].LOADED_MODULE_DIRS = {
            "comfyui-workflow-encrypt": "C:/x/custom_nodes/comfyui-workflow-encrypt",
            "ComfyUI-KJNodes": "C:/x/custom_nodes/ComfyUI-KJNodes"}
        try:
            bad = compat.check("not pack ComfyUI-Workflow-Encrypt")[0]
            fine = compat.check("not pack Some-Other-Pack")[0]
            kj = compat.check("not pack comfyui-kjnodes")[0]
        finally:
            del sys.modules["nodes"].LOADED_MODULE_DIRS
        self.assertFalse(bad.ok)
        self.assertEqual(bad.title, "comfyui-workflow-encrypt must not be installed")
        self.assertIn("custom_nodes/comfyui-workflow-encrypt", bad.detail)
        self.assertTrue(fine.ok)
        self.assertFalse(kj.ok)
        # nothing loaded at all: fine
        self.assertTrue(compat.check("not pack Anything")[0].ok)

    def test_install_report_reads_versions_and_commits(self):
        with tempfile.TemporaryDirectory() as root:
            tmp = os.path.join(root, "custom_nodes")
            a = os.path.join(tmp, "pack-a")
            os.makedirs(os.path.join(a, ".git", "refs", "heads"))
            with open(os.path.join(a, "pyproject.toml"), "w") as fh:
                fh.write('[project]\nversion = "1.2.3"\n')
            with open(os.path.join(a, ".git", "HEAD"), "w") as fh:
                fh.write("ref: refs/heads/main\n")
            with open(os.path.join(a, ".git", "refs", "heads", "main"), "w") as fh:
                fh.write("0123456789abcdef0123456789abcdef01234567\n")
            b = os.path.join(tmp, "pack-b")
            os.makedirs(os.path.join(b, ".git"))
            with open(os.path.join(b, ".git", "HEAD"), "w") as fh:
                fh.write("ref: refs/heads/dev\n")
            with open(os.path.join(b, ".git", "packed-refs"), "w") as fh:
                fh.write("# pack-refs\nfedcba9876543210fedcba9876543210fedcba98 refs/heads/dev\n")
            c = os.path.join(tmp, "pack-c")
            os.makedirs(c)
            sys.modules["nodes"].LOADED_MODULE_DIRS = {"pack-b": b, "pack-a": a, "pack-c": c,
                                                        os.path.join(root, "comfy_extras", "x"): os.path.join(root, "comfy_extras", "x")}
            core("0.37.2")
            try:
                report = compat.install_report()
            finally:
                del sys.modules["nodes"].LOADED_MODULE_DIRS
                del sys.modules["comfyui_version"]
        self.assertEqual(report["comfyui"], "0.37.2")
        self.assertTrue(report["python"] and report["os"])
        self.assertEqual([p["name"] for p in report["packs"]], ["pack-a", "pack-b", "pack-c"])
        self.assertEqual(report["packs"][0], {"name": "pack-a", "version": "1.2.3", "commit": "012345678"})
        self.assertEqual(report["packs"][1], {"name": "pack-b", "version": "", "commit": "fedcba987"})
        self.assertEqual(report["packs"][2], {"name": "pack-c", "version": "", "commit": ""})


class TheNode(unittest.TestCase):
    def test_refuses_with_every_failure_and_has_no_sockets(self):
        self.assertEqual(compat.CompatibilityCheck.RETURN_TYPES, ())
        self.assertTrue(compat.CompatibilityCheck.OUTPUT_NODE, "runs on every queue")
        self.assertEqual(set(compat.CompatibilityCheck.INPUT_TYPES()), {"required"})
        self.assertEqual(set(compat.CompatibilityCheck.INPUT_TYPES()["required"]), {"rules"})
        sys.modules["nodes"].NODE_CLASS_MAPPINGS.clear()
        node = compat.CompatibilityCheck()
        with self.assertRaises(RuntimeError) as caught:
            node.run("node A https://a.b/c # pack A\nnode B\nthis is not a rule")
        text = str(caught.exception)
        self.assertIn("1. Node A is not installed", text)
        self.assertIn("pack A", text)
        self.assertIn("See: https://a.b/c", text)
        self.assertIn("2. Node B is not installed", text)
        self.assertIn("3. This rule cannot be read", text)
        sys.modules["nodes"].NODE_CLASS_MAPPINGS["A"] = object
        self.assertEqual(node.run("node A"), ())
        self.assertEqual(node.run(compat.DEFAULT_RULES), ())

    def test_results_are_json_shaped_for_the_widget(self):
        d = compat.check("node Missing https://x.y # n", {})[0].result()
        self.assertEqual(sorted(d), ["detail", "fix", "input_name", "installed", "kind",
                                     "line", "link", "name", "node", "note", "ok", "required",
                                     "rule", "state", "title", "url", "version"])
        self.assertEqual(d["ok"], False)
        self.assertEqual(d["state"], "fail")
        self.assertEqual(d["installed"], "not installed")
        self.assertEqual(d["required"], "installed")
        self.assertEqual(d["link"], "https://x.y")

    def test_comfyui_and_the_frontend_always_link_to_their_repos(self):
        core("0.30.0")
        try:
            plain, own = compat.check("comfyui >= 0.35.0\ncomfyui >= 0.35.0 https://x.y/fork", {})
        finally:
            del sys.modules["comfyui_version"]
        self.assertEqual((plain.url, plain.result()["link"]),
                         ("", "https://github.com/comfy-org/comfyui"))
        self.assertIn("See: https://github.com/comfy-org/comfyui", plain.as_text(),
                      "the run-time refusal names it too")
        # fixed: a URL on the line does not replace it (and is kept in the text)
        self.assertEqual((own.url, own.result()["link"]),
                         ("https://x.y/fork", "https://github.com/comfy-org/comfyui"))
        fe = compat.check("frontend >= 1.0.0", {}, frontend="1.0.0")[0].result()
        self.assertEqual(fe["link"], "https://github.com/comfy-org/ComfyUI_frontend")
        # everything else links to what its line says, or nothing
        self.assertEqual(compat.check("node Missing", {})[0].result()["link"], "")
        self.assertEqual(compat.check("node Missing https://x.y/m", {})[0].result()["link"], "https://x.y/m")
        self.assertEqual(set(compat.FIXED_LINKS), {"core", "frontend"})


class Frontend(unittest.TestCase):
    """`frontend >= X`: the page's own version when a page asks, else the
    one the server serves; unknown passes."""

    def setUp(self):
        self._served = compat.served_frontend_version

    def tearDown(self):
        compat.served_frontend_version = self._served

    def test_parse_forms(self):
        for line in ("frontend >= 1.53.0", "Frontend >= 1.53", "comfyui-frontend-package >= v1.53.0"):
            rule = compat.parse_rules(line)[0]
            self.assertEqual((rule.kind, rule.name, rule.version), ("frontend", "Frontend", (1, 53, 0)), line)
        self.assertEqual(compat.parse_rules("frontend >= 1.53.0")[0].required(), ">= 1.53.0")

    def test_the_page_version_wins_over_the_served_one(self):
        compat.served_frontend_version = lambda: ((1, 54, 0), "1.54.0")
        rule = compat.check("frontend >= 1.53.0 https://x.y/fe", {}, frontend="1.52.7")[0]
        self.assertFalse(rule.ok)
        self.assertEqual(rule.title, "The frontend is too old")
        self.assertIn("1.52.7", rule.detail)
        self.assertEqual(rule.installed, "1.52.7")
        self.assertIn("requirements", rule.fix)
        self.assertEqual(rule.result()["state"], "fail")

    def test_run_time_uses_the_served_version_and_unknown_passes(self):
        compat.served_frontend_version = lambda: ((1, 53, 6), "1.53.6")
        rule = compat.check("frontend >= 1.53.0", {})[0]
        self.assertTrue(rule.ok)
        self.assertEqual((rule.title, rule.installed), ("Frontend 1.53.6", "1.53.6"))
        compat.served_frontend_version = lambda: (None, "")
        rule = compat.check("frontend >= 1.53.0", {}, frontend="not-a-version")[0]
        self.assertTrue(rule.ok)
        self.assertEqual((rule.result()["state"], rule.installed), ("unknown", "unknown"))

    def test_served_version_follows_the_startup_flags(self):
        cli = types.ModuleType("comfy.cli_args")
        cli.DEFAULT_VERSION_STRING = "comfyanonymous/ComfyUI@latest"
        cli.args = types.SimpleNamespace(front_end_root=None,
                                         front_end_version="Comfy-Org/ComfyUI_frontend@v1.54.7")
        comfy = sys.modules.get("comfy") or types.ModuleType("comfy")
        saved = {k: sys.modules.get(k) for k in ("comfy", "comfy.cli_args")}
        sys.modules["comfy"], sys.modules["comfy.cli_args"] = comfy, cli
        try:
            self.assertEqual(compat.served_frontend_version(), ((1, 54, 7), "1.54.7"))
            cli.args.front_end_version = "Comfy-Org/ComfyUI_frontend@latest"
            self.assertEqual(compat.served_frontend_version(), (None, ""))
            cli.args.front_end_root = "C:/some/folder"
            self.assertEqual(compat.served_frontend_version(), (None, ""))
        finally:
            for k, v in saved.items():
                if v is None:
                    sys.modules.pop(k, None)
                else:
                    sys.modules[k] = v


class Tables(unittest.TestCase):
    """What View Details shows and edits: each result's parts, where its
    line is, what is required and what is installed."""

    def setUp(self):
        sys.modules["nodes"].NODE_CLASS_MAPPINGS.clear()

    def test_line_indexes_the_text_with_comments_and_blanks(self):
        text = ("# header\n\ncomfyui >= 0.35\n   # indented comment\n"
                "node A has b   https://x.y/a   # the original\r\nnot pack Enc\n")
        rules = compat.check(text, {"A": node_with_inputs("b")})
        self.assertEqual([r.line for r in rules], [2, 4, 5])
        lines = text.splitlines()
        self.assertEqual(lines[4].strip(), rules[1].text)
        d = [r.result() for r in rules]
        self.assertEqual((d[0]["kind"], d[0]["name"], d[0]["version"], d[0]["required"]),
                         ("core", "ComfyUI", "0.35.0", ">= 0.35.0"))
        self.assertEqual((d[1]["name"], d[1]["input_name"], d[1]["url"], d[1]["note"],
                          d[1]["required"], d[1]["installed"], d[1]["state"]),
                         ("A", "b", "https://x.y/a", "the original",
                          "with input b", "installed, with b", "ok"))
        self.assertEqual((d[2]["kind"], d[2]["name"], d[2]["required"], d[2]["installed"]),
                         ("no_pack", "Enc", "not installed", "not installed"))

    def test_installed_says_what_was_found(self):
        reg = {"U": node_with_inputs("device")}
        with Install({"p": dict(name="p", version="0.2.5"), "q": dict(name="q")}):
            got = {r.text: r.result() for r in compat.check(
                "p >= 0.3\nq >= 1.0\nnode U has chunking\nnode U\nnode Z", reg)}
        self.assertEqual((got["p >= 0.3"]["installed"], got["p >= 0.3"]["state"]), ("0.2.5", "fail"))
        self.assertEqual((got["q >= 1.0"]["installed"], got["q >= 1.0"]["state"]),
                         ("version unknown", "unknown"))
        self.assertEqual(got["node U has chunking"]["installed"], "installed, without chunking")
        self.assertEqual(got["node U"]["installed"], "installed")
        self.assertEqual(got["node Z"]["installed"], "not installed")
        core("0.37.0")
        try:
            d = compat.check("comfyui >= 0.35.0")[0].result()
        finally:
            del sys.modules["comfyui_version"]
        self.assertEqual((d["installed"], d["state"]), ("0.37.0", "ok"))

    def test_the_lines_the_table_writes_read_back_as_the_same_rule(self):
        # the exact strings tests/test_compat_check.mjs asserts lineOf makes
        cases = {
            "comfyui-kjnodes >= 1.1.0   https://github.com/kijai/ComfyUI-KJNodes   # Set/Get":
                ("pack", "comfyui-kjnodes", "1.1.0", "", "", "https://github.com/kijai/ComfyUI-KJNodes", "Set/Get"),
            "frontend >= 1.53.0   # Nodes 2.0 fixes":
                ("frontend", "Frontend", "1.53.0", "", "", "", "Nodes 2.0 fixes"),
            "comfyui >= 0.35.0   https://x.y/c   # core note":
                ("core", "ComfyUI", "0.35.0", "", "", "https://x.y/c", "core note"),
            "comfyui-obvpm >= 0.2.5   node: ValuePresets (obvpm)   https://github.com/chanon/comfyui-obvpm":
                ("pack", "comfyui-obvpm", "0.2.5", "ValuePresets (obvpm)", "",
                 "https://github.com/chanon/comfyui-obvpm", ""),
            "node MinimaxH3LatentUpscaler3D has enable_temporal_chunking   # the original, not #2":
                ("node", "MinimaxH3LatentUpscaler3D", "", "", "enable_temporal_chunking", "",
                 "the original, not #2"),
            "node ModelPreviewOverrideKJ": ("node", "ModelPreviewOverrideKJ", "", "", "", "", ""),
            "not node Fork   https://x.y/f": ("no_node", "Fork", "", "", "", "https://x.y/f", ""),
            "not pack ComfyUI-Workflow-Encrypt   # rewrites saved workflows":
                ("no_pack", "ComfyUI-Workflow-Encrypt", "", "", "", "", "rewrites saved workflows"),
        }
        for line, want in cases.items():
            d = compat.parse_rules(line)[0]
            d.ok = True
            r = d.result()
            self.assertEqual((r["kind"], r["name"], r["version"], r["node"], r["input_name"],
                              r["url"], r["note"]), want, line)



class Packs(unittest.TestCase):
    """How a pack rule finds the installed pack: its repository (pyproject
    [project.urls] or git origin), else its pyproject name or folder."""

    def test_repository_urls_compare_however_written(self):
        key = "github.com/kijai/comfyui-kjnodes"
        for url in ("https://github.com/kijai/ComfyUI-KJNodes", "https://www.github.com/kijai/ComfyUI-KJNodes/",
                    "http://github.com/kijai/ComfyUI-KJNodes.git", "git@github.com:kijai/ComfyUI-KJNodes.git",
                    "https://github.com/kijai/ComfyUI-KJNodes/tree/main/nodes", "ssh://git@github.com/kijai/ComfyUI-KJNodes"):
            self.assertEqual(compat.normalize_repo(url), key, url)
        for junk in ("", "not a url", "https://github.com/", "https://github.com/onlyowner", "file:///C:/x/y"):
            self.assertEqual(compat.normalize_repo(junk), "", junk)

    def test_found_by_repository_whatever_the_folder_or_name(self):
        packs = {"ComfyUI-KJNodes-renamed": dict(name="something-else", version="1.2.0",
                                                 repo="https://github.com/kijai/ComfyUI-KJNodes")}
        with Install(packs):
            rule = compat.check("comfyui-kjnodes >= 1.1.0 https://github.com/kijai/ComfyUI-KJNodes", {})[0]
        self.assertTrue(rule.ok)
        self.assertEqual(rule.result()["state"], "ok")
        self.assertIn("custom_nodes/ComfyUI-KJNodes-renamed", rule.detail)

    def test_found_by_git_origin_when_the_pack_has_no_pyproject(self):
        with Install({"Comfyui_Minimax_h3_latent_Upscaler": dict(
                git="https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler")}):
            rule = compat.check("upscaler >= 1.0 https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler", {})[0]
        self.assertEqual((rule.ok, rule.title), (True, "upscaler (version unknown)"),
                         "found (by origin) though it has no version to compare")

    def test_a_clone_of_a_fork_matches_either_repository(self):
        # pyproject names upstream, the git origin is the fork (the Artius case)
        pack = dict(name="comfyui-artius-browser", version="1.19.0",
                    repo="https://github.com/AlexYez/comfyui-artius-browser",
                    git="https://github.com/chanon/comfyui-artius-browser")
        with Install({"comfyui-artius-browser": pack}):
            for url in ("https://github.com/AlexYez/comfyui-artius-browser",
                        "https://github.com/chanon/comfyui-artius-browser"):
                rule = compat.check("artius >= 1.0.0 " + url, {})[0]
                self.assertEqual(rule.result()["state"], "ok", url)

    def test_found_by_name_from_another_repository_says_so_without_refusing(self):
        with Install({"comfyui-thing": dict(name="comfyui-thing", version="2.0.0",
                                            repo="https://github.com/forker/comfyui-thing")}):
            rule = compat.check("comfyui-thing >= 1.0.0 https://github.com/original/comfyui-thing", {})[0]
            self.assertTrue(rule.ok)
            self.assertEqual(rule.result()["state"], "unknown", "passes, but marked")
            self.assertIn("github.com/forker/comfyui-thing, not github.com/original/comfyui-thing", rule.detail)
            # too old AND elsewhere: fails, and says both
            rule = compat.check("comfyui-thing >= 3.0 https://github.com/original/comfyui-thing", {})[0]
            self.assertFalse(rule.ok)
            self.assertIn("a fork, or a renamed repository", rule.detail)

    def test_found_by_folder_in_any_case_and_by_pyproject_name(self):
        with Install({"ComfyUI-Pack": dict(name="registry-name", version="1.0.0")}):
            self.assertTrue(compat.check("comfyui-pack >= 1.0", {})[0].ok, "folder, any case")
            self.assertTrue(compat.check("REGISTRY-NAME >= 1.0", {})[0].ok, "pyproject name")

    def test_the_older_node_form_still_finds_the_pack(self):
        with Install({"the-pack": dict(name="x", version="0.9.0")}) as inst:
            mod = module_at("obvpm_test_nodeform", os.path.join(inst.root, "the-pack", "nodes.py"))
            reg = {"TheNode": type("TheNode", (), {"__module__": mod.__name__})}
            rule = compat.check("the-product >= 1.0 node: TheNode", reg)[0]
        self.assertEqual((rule.ok, rule.title), (False, "the-product needs updating"))

    def test_not_pack_by_repository_or_name(self):
        with Install({"enc": dict(name="comfyui-workflow-encrypt",
                                  repo="https://github.com/jtydhr88/ComfyUI-Workflow-Encrypt")}):
            for line in ("not pack https://github.com/jtydhr88/ComfyUI-Workflow-Encrypt",
                         "not pack comfyui-workflow-encrypt", "not pack ENC"):
                rule = compat.check(line, {})[0]
                self.assertFalse(rule.ok, line)
                self.assertEqual(rule.title, "enc must not be installed", line)
            self.assertTrue(compat.check("not pack https://github.com/someone/else", {})[0].ok)

    def test_a_packs_own_repository_wins_over_a_link_it_lists(self):
        # Contex-Loop lists H3-Motion-Context's repository as its Homepage;
        # a rule naming that repository means Motion-Context itself
        packs = {"ComfyUI-MiniMaxH3-Contex-Loop": dict(raw=(
                     '[project]\nname = "comfyui-minimaxh3-contex-loop"\nversion = "0.5.51"\n'
                     '[project.urls]\nRepository = "https://github.com/ethanfel/ComfyUI-MiniMaxH3-Contex-Loop"\n'
                     'Homepage = "https://github.com/nikodemon80/ComfyUI-H3-Motion-Context"\n')),
                 "ComfyUI-H3-Motion-Context": dict(name="comfyui-h3-motion-context", version="0.2.0",
                                                   git="https://github.com/nikodemon80/ComfyUI-H3-Motion-Context")}
        with Install(packs):
            info, how = compat.find_installed("mc", "https://github.com/nikodemon80/ComfyUI-H3-Motion-Context")
            self.assertEqual((info["folder"], how), ("ComfyUI-H3-Motion-Context", "repository"))
            # and a link-only match still counts when nothing owns the repository
            del packs["ComfyUI-H3-Motion-Context"]
        with Install(packs):
            info, _ = compat.find_installed("mc", "https://github.com/nikodemon80/ComfyUI-H3-Motion-Context")
            self.assertEqual(info["folder"], "ComfyUI-MiniMaxH3-Contex-Loop")

    def test_query_and_fragment_do_not_change_the_repository(self):
        self.assertEqual(compat.normalize_repo("https://github.com/Luis/ComfyUI-MiniMaxH3Mod#readme"),
                         "github.com/luis/comfyui-minimaxh3mod")
        self.assertEqual(compat.normalize_repo("https://github.com/o/r?tab=readme-ov-file"), "github.com/o/r")

    def test_a_pyproject_is_read_as_toml_not_by_pattern(self):
        with Install({"p": dict(raw='[project]\nname = "p"\nversion = "1.2.3"\n'
                                    '[tool.other]\nversion = "9.9.9"\n'
                                    '[project.urls]\nHomepage = "https://github.com/o/p"\n')}):
            info = compat.installed_packs()[0]
        self.assertEqual((info["version"], info["repos"]), ("1.2.3", {"github.com/o/p"}))


class Install:
    """A custom_nodes folder with fake packs, listed as ComfyUI lists them
    (nodes.LOADED_MODULE_DIRS). Each pack: name / version / repo go into
    pyproject.toml (raw= for the whole file), git= into .git/config."""

    def __init__(self, packs):
        self.packs = packs

    def __enter__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "custom_nodes")
        dirs = {}
        for folder, spec in self.packs.items():
            path = os.path.join(self.root, folder)
            os.makedirs(path)
            text = spec.get("raw")
            if text is None and any(k in spec for k in ("name", "version", "repo")):
                text = "[project]\n"
                if "name" in spec:
                    text += 'name = "%s"\n' % spec["name"]
                if "version" in spec:
                    text += 'version = "%s"\n' % spec["version"]
                if "repo" in spec:
                    text += '\n[project.urls]\nRepository = "%s"\n' % spec["repo"]
            if text is not None:
                with open(os.path.join(path, "pyproject.toml"), "w", encoding="utf-8") as fh:
                    fh.write(text)
            if "git" in spec:
                os.makedirs(os.path.join(path, ".git"))
                with open(os.path.join(path, ".git", "config"), "w", encoding="utf-8") as fh:
                    fh.write('[core]\n\tbare = false\n[remote "origin"]\n\turl = %s\n'
                             '\tfetch = +refs/heads/*:refs/remotes/origin/*\n' % spec["git"])
            dirs[folder] = path
        self.saved = getattr(sys.modules["nodes"], "LOADED_MODULE_DIRS", None)
        sys.modules["nodes"].LOADED_MODULE_DIRS = dirs
        return self

    def __exit__(self, *exc):
        if self.saved is None:
            del sys.modules["nodes"].LOADED_MODULE_DIRS
        else:
            sys.modules["nodes"].LOADED_MODULE_DIRS = self.saved
        self.tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
