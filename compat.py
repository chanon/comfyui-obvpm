"""Compatibility Check: a workflow says what it needs, the node checks.

A workflow arrives with a list of node packs, and ComfyUI Manager can
install the missing ones. What nothing checks is whether what IS
installed is right: a pack too old to read the workflow's settings, a
fork registering a node under the same name with different widgets, a
core older than a node it uses. Those load without a word and fail
somewhere downstream with a message about the symptom.

This node carries the workflow's requirements as text, one per line,
and checks them against the install -- on its face when the workflow
loads (the widget asks /obvpm/compat) and again when a run reaches it,
where it refuses with the same list. Each failure says what was found,
what to do and where to go, so the person reading it can act on it
without knowing the pack.

    comfyui >= 0.35.0
    comfyui-obvpm >= 0.2.3   node: ValuePresets (obvpm)   https://github.com/chanon/comfyui-obvpm
    node MinimaxH3LatentUpscaler3D has enable_temporal_chunking   https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler   # the original, not the Plus fork
    node ModelPreviewOverrideKJ   https://github.com/kijai/ComfyUI-KJNodes   # ComfyUI-KJNodes

    not node SomeForkNode   https://...   # its pack replaces a node this workflow needs
    not pack ComfyUI-Workflow-Encrypt   # rewrites saved workflows

Four rule kinds: the core version, a pack's version (found by a node
it registers, read from that pack's pyproject.toml), a node that must
be present, or must declare an input (which is how a same-name fork is
told apart), and -- with `not` in front -- a node or a pack that must
be ABSENT, for the packs known to break the workflow when they are
installed alongside it. A pack is named by its folder under
custom_nodes (case does not matter), since some register no node at
all. A URL on the line becomes the link; text after ` #` is shown with
the failure. The rules are hand-parsed, one line at a time, and
nothing here imports or evaluates anything a workflow names: the
registry is a dict lookup, a version is a file read.

The node also offers a report of the install (ComfyUI, Python, torch,
the OS, every loaded pack with its version and git commit) for pasting
into a bug report; the browser adds what only it knows (frontend
version, Nodes 2.0 or classic, language).
"""

import logging
import os
import re
import sys


_LOG = logging.getLogger("obvpm")

MAX_RULES = 64
MAX_RULES_BYTES = 16 * 1024

MANAGER_HELP = ("In ComfyUI Manager: Custom Nodes Manager, find the pack, "
                "press Update (or Install), then restart ComfyUI.")

DEFAULT_RULES = """# one requirement per line; text after # is shown when it fails
# comfyui >= 0.35.0
# some-pack >= 1.2.0   node: SomeNode   https://github.com/someone/some-pack
# node SomeNode   https://github.com/someone/some-pack
# node SomeNode has some_input   https://...   # the original pack, not a fork
# not node SomeForkNode   # a node whose pack breaks this workflow
# not pack Some-Pack-Folder   # a pack (by its folder name) that breaks this workflow
"""

_URL = re.compile(r"https?://\S+")
_VERSION = re.compile(r"^v?(\d+)\.(\d+)(?:\.(\d+))?")


class Rule:
    """One line: what it asks, and how it came out once checked."""

    def __init__(self, text, kind, name, version=None, node=None,
                 input_name=None, url="", note=""):
        self.text = text
        self.kind = kind            # core | pack | node | no_node | no_pack | error
        self.name = name
        self.version = version      # (major, minor, patch) for core/pack
        self.node = node            # the node id a pack is found by
        self.input_name = input_name
        self.url = url
        self.note = note
        # which line of the rules text this is (an index into
        # splitlines()), so the table editor can put an edited rule back
        # where it came from, between the comments around it
        self.line = None
        # filled by check()
        self.ok = None
        self.unknown = False        # passed only because it could not be checked
        self.title = ""
        self.detail = ""
        self.fix = ""
        self.installed = ""         # what was found, short: "0.2.5", "not installed"

    def required(self):
        """What the rule asks for, short: the table's 'Required' column."""
        if self.kind in ("core", "pack") and self.version is not None:
            return ">= " + version_text(self.version)
        if self.kind == "node":
            return "with input " + self.input_name if self.input_name else "installed"
        if self.kind in ("no_node", "no_pack"):
            return "not installed"
        return ""

    def result(self):
        state = "fail" if not self.ok else "unknown" if self.unknown else "ok"
        return {"rule": self.text, "kind": self.kind, "ok": bool(self.ok),
                "state": state, "line": self.line,
                "title": self.title, "detail": self.detail, "fix": self.fix,
                "note": self.note, "url": self.url,
                # the line's parts, for the table that edits them
                "name": self.name,
                "version": version_text(self.version) if self.version else "",
                "node": self.node or "", "input_name": self.input_name or "",
                "required": self.required(), "installed": self.installed}

    def as_text(self):
        lines = ["%s: %s" % (self.title, self.detail)]
        if self.note:
            lines.append("  " + self.note)
        if self.fix:
            lines.append("  Fix: " + self.fix)
        if self.url:
            lines.append("  See: " + self.url)
        return "\n".join(lines)


# ----------------------------------------------------------------- parsing

def parse_version(text):
    """'0.2.3' -> (0, 2, 3); anything unreadable -> None."""
    found = _VERSION.match(str(text or "").strip())
    if not found:
        return None
    return tuple(int(part or 0) for part in found.groups())


def version_text(version):
    return ".".join(str(part) for part in version)


def _error(text, why):
    rule = Rule(text, "error", "")
    rule.ok = False
    rule.title = "This rule cannot be read"
    rule.detail = "%r %s" % (text, why)
    rule.fix = ("Write it as  comfyui >= 0.35.0,  pack >= 1.0 node: NodeId,  "
                "node NodeId,  node NodeId has input_name,  not node NodeId,  "
                "or  not pack FolderName  (a URL and a '# note' may follow).")
    return rule


def parse_rules(text):
    """The rules text as Rules, in order. A line that cannot be read
    becomes a failing rule rather than a refused text: the node's face
    then says which line, and the others are still checked."""
    raw = str(text or "")
    if len(raw.encode("utf-8", "replace")) > MAX_RULES_BYTES:
        raise ValueError("Compatibility Check: the rules are larger than %d KB."
                         % (MAX_RULES_BYTES // 1024))
    rules = []
    # by index into splitlines(): the same lines the route hands the
    # editor, blank and # lines included, so `rule.line` points into them
    for index, source in enumerate(raw.splitlines()):
        line = source.strip()
        if not line or line.startswith("#"):
            continue
        if len(rules) >= MAX_RULES:
            raise ValueError("Compatibility Check: more than %d rules." % MAX_RULES)
        rule = parse_rule(line)
        rule.line = index
        rules.append(rule)
    return rules


def parse_rule(line):
    text = line.strip()
    body, note = text, ""
    # the note comes off first, at the first ' #', so it may say anything
    at = re.search(r"\s#", body)
    if at:
        note = body[at.end():].strip()
        body = body[:at.start()].rstrip()
    urls = _URL.findall(body)
    url = urls[0] if urls else ""
    body = _URL.sub("", body).strip()
    if not body:
        return _error(text, "names nothing to check")
    words = body.split()
    if words[0].lower() == "not":
        # `not node NodeId` / `not pack FolderName`: must be absent
        what = words[1].lower() if len(words) > 1 else ""
        rest = body[len(words[0]):].strip()
        rest = rest[len(words[1]):].strip() if len(words) > 1 else ""
        if what not in ("node", "pack") or not rest:
            return _error(text, "must be  not node NodeId  or  not pack FolderName")
        return Rule(text, "no_" + what, rest, url=url, note=note)
    if words[0].lower() == "node":
        rest = body[len(words[0]):].strip()
        node, sep, input_name = (rest + " ").rpartition(" has ")
        if sep:
            node, input_name = node.strip(), input_name.strip()
            if not node or not input_name:
                return _error(text, "is missing the node or the input after 'has'")
            return Rule(text, "node", node, input_name=input_name, url=url, note=note)
        if not rest:
            return _error(text, "names no node after 'node'")
        return Rule(text, "node", rest.strip(), url=url, note=note)
    # `name >= version [node: NodeId]`
    shape = re.match(r"^(?P<name>\S+)\s*>=\s*(?P<ver>\S+)(?:\s+node\s*:\s*(?P<node>.+))?$", body)
    if not shape:
        return _error(text, "is not a rule this node knows")
    name = shape.group("name")
    version = parse_version(shape.group("ver"))
    if version is None:
        return _error(text, "has a version that is not written like 1.2.3")
    node = (shape.group("node") or "").strip()
    if name.lower() == "comfyui":
        return Rule(text, "core", "ComfyUI", version=version, url=url, note=note)
    if not node:
        return _error(text, "needs  node: <a node id the pack registers>  so the "
                      "installed pack can be found whatever its folder is called")
    return Rule(text, "pack", name, version=version, node=node, url=url, note=note)


# ---------------------------------------------------------------- the install

def _registry():
    """The node classes ComfyUI has loaded: a dict lookup, never an
    import of anything a workflow names."""
    try:
        from nodes import NODE_CLASS_MAPPINGS
    except Exception:
        return {}
    return NODE_CLASS_MAPPINGS


def pack_version(node_class):
    """The version in the pyproject.toml of the pack a node class came
    from, or None when there is none to read. Walks up from the class's
    file, but not past the folder under custom_nodes: above that is
    ComfyUI itself, whose own pyproject must not answer for a pack."""
    module = sys.modules.get(getattr(node_class, "__module__", ""))
    path = getattr(module, "__file__", None)
    if not path:
        return None
    folder = os.path.dirname(os.path.abspath(path))
    for _ in range(4):
        candidate = os.path.join(folder, "pyproject.toml")
        if os.path.isfile(candidate):
            try:
                with open(candidate, encoding="utf-8") as fh:
                    text = fh.read(64 * 1024)
            except OSError:
                return None
            found = re.search(r'^\s*version\s*=\s*"([^"]*)"', text, re.M)
            return parse_version(found.group(1)) if found else None
        parent = os.path.dirname(folder)
        if parent == folder or os.path.basename(parent) == "custom_nodes":
            break
        folder = parent
    return None


def declared_inputs(node_class):
    """The input names a node class declares, or None if it will not say.
    Both node APIs end up with an INPUT_TYPES classmethod (core builds
    one for V3 nodes). Installed classes are trusted code, as they are
    for /object_info; one that raises while describing itself is
    reported as unknown rather than as wrong."""
    try:
        spec = node_class.INPUT_TYPES()
    except Exception:
        return None
    names = set()
    for section in ("required", "optional"):
        part = spec.get(section) if isinstance(spec, dict) else None
        if isinstance(part, dict):
            names.update(str(k) for k in part)
    return names


def core_version():
    try:
        from comfyui_version import __version__
    except Exception:
        return None, ""
    return parse_version(__version__), str(__version__)


def _loaded_packs():
    """{folder name: path} of every custom node pack ComfyUI loaded --
    core keeps the list by the folder's basename, which is how a pack
    is named in a `not pack` rule and in the report."""
    try:
        from nodes import LOADED_MODULE_DIRS
    except Exception:
        return {}
    # core's own comfy_extras / comfy_api_nodes modules are in the same
    # dict, keyed by their full path: a pack is what sits under a
    # custom_nodes folder
    return {str(name): str(path) for name, path in LOADED_MODULE_DIRS.items()
            if os.path.basename(os.path.dirname(str(path))).lower() == "custom_nodes"}


def find_pack(name, packs=None):
    """(folder name, path) of the loaded pack called `name`, matched on
    the folder basename regardless of case (a registry install lowercases
    it, a git clone keeps the repo's case), or None."""
    packs = _loaded_packs() if packs is None else packs
    wanted = str(name or "").strip().lower()
    if not wanted:
        return None
    for folder, path in packs.items():
        if str(folder).lower() == wanted or os.path.basename(str(path)).lower() == wanted:
            return folder, path
    return None


def pack_version_at(folder):
    """The version in a pack folder's pyproject.toml, as text, or ''."""
    try:
        with open(os.path.join(folder, "pyproject.toml"), encoding="utf-8") as fh:
            text = fh.read(64 * 1024)
    except OSError:
        return ""
    found = re.search(r'^\s*version\s*=\s*"([^"]*)"', text, re.M)
    return found.group(1) if found else ""


def git_commit(folder):
    """The short commit a pack folder is checked out at, read from the
    .git files (no git process): '' when it is not a clone."""
    git = os.path.join(folder, ".git")
    if not os.path.isdir(git):
        return ""
    try:
        with open(os.path.join(git, "HEAD"), encoding="utf-8") as fh:
            head = fh.read(4096).strip()
        if not head.startswith("ref:"):
            return head[:9]
        ref = head[4:].strip()
        ref_file = os.path.join(git, *ref.split("/"))
        if os.path.isfile(ref_file):
            with open(ref_file, encoding="utf-8") as fh:
                return fh.read(4096).strip()[:9]
        with open(os.path.join(git, "packed-refs"), encoding="utf-8") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) == 2 and parts[1] == ref:
                    return parts[0][:9]
    except OSError:
        pass
    return ""


def install_report():
    """What the server knows about the install, for a bug report."""
    import platform
    _, comfy = core_version()
    try:
        import torch
        torch_text = str(torch.__version__)
    except Exception:
        torch_text = ""
    packs = []
    for folder, path in sorted(_loaded_packs().items(), key=lambda kv: str(kv[0]).lower()):
        packs.append({"name": str(folder), "version": pack_version_at(path),
                      "commit": git_commit(path)})
    return {
        "comfyui": comfy,
        "python": platform.python_version(),
        "torch": torch_text,
        "os": "%s %s" % (platform.system(), platform.release()),
        "packs": packs,
    }


# ---------------------------------------------------------------- checking

def check_rule(rule, registry=None):
    """Fill in ok/title/detail/fix from the install. Never raises."""
    if rule.kind == "error":
        return rule
    registry = _registry() if registry is None else registry
    try:
        if rule.kind == "core":
            _check_core(rule)
        elif rule.kind == "pack":
            _check_pack(rule, registry)
        elif rule.kind == "no_node":
            _check_no_node(rule, registry)
        elif rule.kind == "no_pack":
            _check_no_pack(rule)
        else:
            _check_node(rule, registry)
    except Exception:
        _LOG.exception("Compatibility Check: rule %r could not be checked", rule.text)
        rule.ok = True          # a broken check must not block a working install
        rule.unknown = True
        rule.title = "Could not check"
        rule.detail = rule.text
        rule.installed = "could not check"
    return rule


def _check_core(rule):
    have, text = core_version()
    if have is None:
        rule.ok = True
        rule.unknown = True
        rule.title = "ComfyUI version unknown"
        rule.detail = "This ComfyUI does not say its version; assumed new enough."
        rule.installed = "unknown"
        return
    rule.installed = text
    rule.ok = have >= rule.version
    if rule.ok:
        rule.title = "ComfyUI %s" % text
        rule.detail = "needs %s or newer" % version_text(rule.version)
    else:
        rule.title = "ComfyUI is too old"
        rule.detail = ("This is ComfyUI %s; the workflow needs %s or newer."
                       % (text, version_text(rule.version)))
        rule.fix = ("Update ComfyUI (the Manager's 'Update ComfyUI', update.bat "
                    "on the portable build, or git pull), then restart it.")


def _check_pack(rule, registry):
    node_class = registry.get(rule.node)
    if node_class is None:
        rule.ok = False
        rule.title = "%s is not installed" % rule.name
        rule.detail = ("The workflow needs it (its node %s is not registered)."
                       % rule.node)
        rule.fix = MANAGER_HELP + (" ComfyUI Manager's 'Install Missing Custom "
                                   "Nodes' finds it as well.")
        rule.installed = "not installed"
        return
    have = pack_version(node_class)
    if have is None:
        rule.ok = True
        rule.unknown = True
        rule.title = "%s (version unknown)" % rule.name
        rule.detail = ("installed, but its version cannot be read; needs %s "
                       "or newer" % version_text(rule.version))
        rule.installed = "version unknown"
        return
    rule.installed = version_text(have)
    rule.ok = have >= rule.version
    if rule.ok:
        rule.title = "%s %s" % (rule.name, version_text(have))
        rule.detail = "needs %s or newer" % version_text(rule.version)
    else:
        rule.title = "%s needs updating" % rule.name
        rule.detail = ("%s %s is installed; the workflow needs %s or newer."
                       % (rule.name, version_text(have), version_text(rule.version)))
        rule.fix = MANAGER_HELP + " Or, in its folder under custom_nodes: git pull."


def _check_node(rule, registry):
    node_class = registry.get(rule.name)
    if node_class is None:
        rule.ok = False
        rule.title = "Node %s is not installed" % rule.name
        rule.detail = "ComfyUI has no node of that name."
        rule.fix = ("Install the pack that provides it%s, then restart ComfyUI. "
                    "ComfyUI Manager's 'Install Missing Custom Nodes' may find it."
                    % (" (see the link)" if rule.url else ""))
        rule.installed = "not installed"
        return
    if rule.input_name is None:
        rule.ok = True
        rule.title = "Node %s" % rule.name
        rule.detail = "installed"
        rule.installed = "installed"
        return
    inputs = declared_inputs(node_class)
    if inputs is None:
        rule.ok = True
        rule.unknown = True
        rule.installed = "installed, inputs unknown"
        rule.title = "Node %s" % rule.name
        rule.detail = ("installed; it would not describe its inputs, so '%s' "
                       "could not be checked" % rule.input_name)
        return
    rule.ok = rule.input_name in inputs
    rule.installed = (("installed, with %s" if rule.ok else "installed, without %s")
                      % rule.input_name)
    if rule.ok:
        rule.title = "Node %s" % rule.name
        rule.detail = "installed, with %s" % rule.input_name
    else:
        rule.title = "The wrong %s is installed" % rule.name
        rule.detail = ("A node of that name is installed, but it has no '%s' "
                       "input -- a different pack or a fork registers the same "
                       "node name with different settings, and the workflow "
                       "loads it wrong." % rule.input_name)
        rule.fix = ("Uninstall the pack that provides the installed one, install "
                    "the one the workflow was built with%s, restart ComfyUI and "
                    "reload the workflow." % (" (see the link)" if rule.url else ""))


UNINSTALL_HELP = ("In ComfyUI Manager: Custom Nodes Manager, find the pack and "
                  "press Uninstall (or Disable), then restart ComfyUI. Or move "
                  "its folder out of custom_nodes.")


def _check_no_node(rule, registry):
    node_class = registry.get(rule.name)
    if node_class is None:
        rule.ok = True
        rule.title = "No node %s" % rule.name
        rule.detail = "not installed, as required"
        rule.installed = "not installed"
        return
    rule.ok = False
    rule.title = "Node %s must not be installed" % rule.name
    module = sys.modules.get(getattr(node_class, "__module__", ""))
    path = os.path.normcase(os.path.abspath(getattr(module, "__file__", "") or ""))
    where = ""
    rule.installed = "installed"
    for folder, root in _loaded_packs().items():
        if path.startswith(os.path.normcase(os.path.abspath(str(root))) + os.sep):
            where = " (from the pack in custom_nodes/%s)" % folder
            rule.installed = "installed, in custom_nodes/%s" % folder
            break
    rule.detail = ("A pack registering this node is installed%s, and it breaks "
                   "this workflow." % where)
    rule.fix = UNINSTALL_HELP


def _check_no_pack(rule):
    found = find_pack(rule.name)
    if found is None:
        rule.ok = True
        rule.title = "No pack %s" % rule.name
        rule.detail = "not installed, as required"
        rule.installed = "not installed"
        return
    folder, _ = found
    rule.ok = False
    rule.installed = "installed, as custom_nodes/%s" % folder
    rule.title = "%s must not be installed" % folder
    rule.detail = ("The pack in custom_nodes/%s is loaded, and it breaks this "
                   "workflow." % folder)
    rule.fix = UNINSTALL_HELP


def check(text, registry=None):
    """Every rule, checked, in order."""
    return [check_rule(rule, registry) for rule in parse_rules(text)]


def failures(rules):
    return [r for r in rules if not r.ok]


def refusal(failed):
    return ("Compatibility Check: this workflow cannot run on this install "
            "yet:\n\n" + "\n\n".join("%d. %s" % (i + 1, r.as_text())
                                     for i, r in enumerate(failed)))


# ------------------------------------------------------------------- node

class CompatibilityCheck:
    """No sockets. OUTPUT_NODE makes every run execute it, and an output
    node with no inputs is ready from the start, which the executor takes
    first (ux_friendly_pick_node prefers output nodes), so the refusal
    comes before any model loads without anything wired through it."""
    CATEGORY = "obvpm/gates"
    FUNCTION = "run"
    OUTPUT_NODE = True
    RETURN_TYPES = ()
    DESCRIPTION = (
        "What this workflow needs from the install, checked. Write one "
        "requirement per line -- 'comfyui >= 0.35.0', 'some-pack >= 1.2 "
        "node: ItsNodeId', 'node NodeId', 'node NodeId has input_name' "
        "(catches a fork registering the same node name), 'not node NodeId' "
        "or 'not pack FolderName' (a pack that breaks the workflow when "
        "installed) -- with a URL and a '# note' after it. The node says on "
        "its face whether the install can run the workflow; View Details "
        "shows every rule as tables and is where they are edited. A run "
        "stops here, before anything else runs, with what to fix while "
        "anything fails. 'Copy Report' copies the install (versions, every "
        "pack, node mode) for a bug report."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "rules": ("STRING", {
                    "default": DEFAULT_RULES, "multiline": True,
                    "tooltip": "One requirement per line: comfyui >= X, "
                               "pack >= X node: NodeId, node NodeId, node "
                               "NodeId has input_name, not node NodeId, or "
                               "not pack FolderName. A URL on the line is "
                               "shown as a link; text after ' #' with the "
                               "result. Lines starting with # are ignored.",
                }),
            },
        }

    def run(self, rules):
        failed = failures(check(rules))
        if failed:
            raise RuntimeError(refusal(failed))
        return ()


def register():
    """POST /obvpm/compat {rules} -> {results: [...]}. Guarded by the caller."""
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.post("/obvpm/compat")
    async def _compat(request):
        import asyncio
        try:
            data = await request.json()
            rules = str(data.get("rules", ""))
            # off the event loop: a node describing its inputs may scan a
            # models folder
            results = await asyncio.to_thread(check, rules)
            # the text's lines too: a result's `line` indexes them, which
            # is how the table editor keeps comments and order in place
            return web.json_response({"results": [r.result() for r in results],
                                      "lines": rules.splitlines()})
        except ValueError as why:
            return web.json_response({"error": str(why)}, status=200)
        except Exception as exc:
            _LOG.exception("Compatibility Check: route failed")
            return web.json_response({"error": str(exc)}, status=400)

    @PromptServer.instance.routes.get("/obvpm/compat/report")
    async def _report(request):
        import asyncio
        try:
            # file reads for every pack: off the event loop
            return web.json_response(await asyncio.to_thread(install_report))
        except Exception as exc:
            _LOG.exception("Compatibility Check: report failed")
            return web.json_response({"error": str(exc)}, status=400)
