"""Node ids: the namespaced ids this pack registers, and the bare ids it
used before 0.2.0.

A node's class id is the one name that has to be unique across every
pack a user has installed: it is the key in ComfyUI's global registry
and the `type` written into every saved workflow. Up to 0.1.x this pack
registered bare ids ("Bundle", "Dropdown", ...), and "Bundle" collided
with another pack's node of the same id. Since 0.2.0 every id carries
the " (obvpm)" suffix.

Old workflows keep loading through two mechanisms that both read
RENAMED:

* the frontend (web/obvpm_migrate.js) rewrites a workflow's node types
  before the graph is configured, so the old ids never reach the
  missing-node check -- the JS carries its own copy of this table,
  which tests/test_ids.py keeps identical to RENAMED;
* `register_replacements` hands the same map to ComfyUI's node
  replacement registry, so an API-format prompt that still names an
  old id is rewritten server-side, and the missing-node dialog on a
  frontend without our JS offers the one-click replacement.
"""

import logging

_LOG = logging.getLogger("obvpm")

# old id -> new id. The values are the keys of NODE_CLASS_MAPPINGS.
RENAMED = {
    "ImageOptionalGate": "ImageOptionalGate (obvpm)",
    "VideoOptionalGate": "VideoOptionalGate (obvpm)",
    "AudioOptionalGate": "AudioOptionalGate (obvpm)",
    "ModelOptionalGate": "ModelOptionalGate (obvpm)",
    "LatentOptionalGate": "LatentOptionalGate (obvpm)",
    "AnyOptionalGate": "AnyOptionalGate (obvpm)",
    "MuteGate": "MuteGate (obvpm)",
    "LazySwitch": "LazySwitch (obvpm)",
    "LazySwitch2": "LazySwitch2 (obvpm)",
    "LazySwitch3": "LazySwitch3 (obvpm)",
    "LazyCaseSwitch": "LazyCaseSwitch (obvpm)",
    "LazyCaseSwitchAuto": "LazyCaseSwitchAuto (obvpm)",
    "DownscaleImageToMegapixels": "DownscaleImageToMegapixels (obvpm)",
    "FirstFloat": "FirstFloat (obvpm)",
    "FirstInt": "FirstInt (obvpm)",
    "Dropdown": "Dropdown (obvpm)",
    "Bundle": "Bundle (obvpm)",
    "UnbundleAuto": "Unbundle (obvpm)",
    "BundlePeek": "PeekBundle (obvpm)",
    "ValuePresets": "ValuePresets (obvpm)",
    "LoadImageCrop": "LoadImageCrop (obvpm)",
    "LoadImagesCompose": "LoadImagesCompose (obvpm)",
    "LoraName": "LoraName (obvpm)",
    "SamplerName": "SamplerName (obvpm)",
    "SchedulerName": "SchedulerName (obvpm)",
    "CleanVRAM": "CleanVRAM (obvpm)",
}

_WIDGET_TYPES = ("STRING", "INT", "FLOAT", "BOOLEAN", "COMBO")


def _inputs_of(cls):
    """(name, is_widget) for every declared input, in declaration order."""
    try:
        spec = cls.INPUT_TYPES()
    except Exception:
        return []
    out = []
    for section in ("required", "optional"):
        for name, decl in (spec.get(section) or {}).items():
            kind = decl[0] if isinstance(decl, (tuple, list)) and decl else None
            opts = decl[1] if isinstance(decl, (tuple, list)) and len(decl) > 1 \
                and isinstance(decl[1], dict) else {}
            widget = (isinstance(kind, list)
                      or kind in _WIDGET_TYPES) and not opts.get("forceInput")
            out.append((name, widget))
    return out


def replacements(mappings):
    """One NodeReplace-shaped dict per renamed id, inputs mapped by name.

    Pure, so it is testable without a server: the caller wraps each in
    the real io.NodeReplace. Inputs keep their names across the rename,
    so every mapping is an identity; outputs keep their positions.
    """
    out = []
    for old, new in RENAMED.items():
        cls = mappings.get(new)
        if cls is None:
            continue
        inputs = _inputs_of(cls)
        out.append({
            "new_node_id": new,
            "old_node_id": old,
            "old_widget_ids": [n for n, w in inputs if w],
            "input_mapping": [{"new_id": n, "old_id": n} for n, _ in inputs],
            "output_mapping": [{"new_idx": i, "old_idx": i}
                               for i in range(len(getattr(cls, "RETURN_TYPES", ())))],
        })
    return out


def register_replacements(mappings):
    """Tell ComfyUI's node replacement registry about the rename.

    Silently a no-op on a core too old to have the registry (it arrived
    mid-2026): those installs still get the frontend migration.
    """
    try:
        from comfy_api.latest import io
        from server import PromptServer
        manager = PromptServer.instance.node_replace_manager
    except Exception:
        _LOG.info("obvpm: node replacement registry not available; "
                  "old ids are migrated by the frontend only")
        return 0
    count = 0
    for spec in replacements(mappings):
        try:
            manager.register(io.NodeReplace(**spec))
            count += 1
        except Exception:
            _LOG.warning("obvpm: could not register replacement %s -> %s",
                         spec["old_node_id"], spec["new_node_id"], exc_info=True)
    return count
