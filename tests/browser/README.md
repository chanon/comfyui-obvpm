# Browser checks (manual, not part of the unit suites)

Real frontend, real renderer, headless Edge via puppeteer-core -- the unit
tests run on litegraph doubles and cannot see frontend behaviour.

Setup once: `npm i puppeteer-core` in this folder (or anywhere on NODE_PATH).
Run a throwaway ComfyUI on another port so the main one is untouched, e.g.
`python_embeded\python.exe -s ComfyUI\main.py --cpu --port 8189
--front-end-version Comfy-Org/ComfyUI_frontend@v1.53.6` (or `--front-end-root`
pointing at an unpacked comfyui-frontend-package wheel's `static` dir).

- `load_workflow.mjs <url> <file.json|.mp4> [--vue] [--dump out.json] ["Type=>Renamed"]`
  loads a workflow through `app.handleFile` and reports errors, node count,
  slot classes; `--vue` turns Nodes 2.0 on for the run (and off after).
- `widget_sizing.mjs <url> [--vue] [--node=<NodeId>]` creates a node, fills
  it with long content, and prints: the card's min-content height (Nodes
  2.0's floor for the node), the node after `setSize` to 160 tall and
  +200 wide, and the panel's clientHeight vs scrollHeight. The numbers to
  expect are in obvpm_ui.js `addPanelWidget` (the DOM-panel recipe).

- `reload_size.mjs <url> [--vue] [--node=<NodeId>] [--drag=H]` creates a
  node, optionally drags it to H px tall, then saves and loads the workflow
  five times; exits 1 if the size ever changes. A node the user sized must
  come back that size, and an untouched one must not creep (the
  Compatibility Check grew 20-40 px per load until fitToContent). Run it
  for every node that has a custom widget, with and without `--drag`, in
  both renderers. It writes nothing: the settings are rewritten in flight
  for this tab only, so it is safe against the everyday instance.

The first two scripts write `Comfy.VueNodes.Enabled` through the settings API
of the instance they talk to, which is the user's shared settings file, and
restore it afterwards.
