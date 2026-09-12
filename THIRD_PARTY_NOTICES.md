# Third-party notices

This pack's own code is licensed under **GPL-3.0** (see `LICENSE`).
No third-party code is vendored; the acknowledgments below credit
projects whose published designs informed nodes in this pack.

## ComfyUI-Image-Saver (MIT)

Copyright (c) 2023 Girish Gopaul, maintained by alexopus
https://github.com/alexopus/ComfyUI-Image-Saver

`Sampler Name` and `Scheduler Name` do what that pack's `Sampler
Selector` and `Scheduler Selector` do, and were written after reading
them: put the sampler and scheduler lists on an OUTPUT, typed to the
live list so the value still plugs into a combo input, with the plain
string alongside. No code is vendored; the shape of the interface is
the part that is owed.

## ComfyUI-Easy-Use (GPL-3.0)

Copyright (c) yolain
https://github.com/yolain/ComfyUI-Easy-Use

`Lora Name` and `Clean VRAM` replace `easy loraNames` and
`easy cleanGpuUsed`. Same idea in both cases -- a LoRA filename as a
wire rather than a widget, and unload-plus-empty-cache as a passthrough
so it can be placed in execution order. Written independently against
the behaviour, not copied; the cleanup sequence
(`gc.collect` / `unload_all_models` / `soft_empty_cache`) is
ComfyUI's own API used the obvious way.
