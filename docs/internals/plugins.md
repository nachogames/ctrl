# Plugins

Local plugins live in `<T3 home>/plugins` and are served by
[`PluginHost`](../../apps/server/src/plugins/PluginHost.ts). What they draw lives in memory in
[`PluginUiStore`](../../apps/server/src/plugins/PluginUiStore.ts) and disappears with its producer.

## Decisions

- **Trusted code, supervised process.** A plugin's `entry` runs in a Node child process started
  with `node -e` and the runner in
  [`pluginRunner.ts`](../../apps/server/src/plugins/pluginRunner.ts), so no extra file has to ship.
  The process boundary keeps a crash or a hung plugin out of the server. It is not a sandbox. Desktop
  runs the server inside Electron, so the child gets `ELECTRON_RUN_AS_NODE=1`.
- **Loaded by default.** Agents write plugins and expect to see them work, so a new folder loads
  without consent. Turning a plugin off is the escape hatch, saved in `<stateDir>/plugins.json`.
- **One set of surfaces for plugins and Claude Code mods.** Mod `ui_status`, `ui_toast` and the
  `AbovePrompt` band (from pingdotgg/t3code#15827) arrive with a `claude-mod` source. Plugin bands
  use the mod element table, so one renderer draws both. A press names its source, and the host
  routes it to the Claude query or the plugin process.
- **Views reuse the html_render frame.** Views are HTML pages in the same sandboxed, opaque-origin,
  themed frame as agent HTML renders. The client reads the page over RPC and loads it from a blob
  URL, so views work over every connection mode without an asset route.
  [`pluginView.ts`](../../packages/shared/src/pluginView.ts) defines the `t3` bridge.

## Upstream

Upstream has a much larger plugin proposal (pingdotgg/t3code #16047–#16065): consent, npm installs,
settings, secrets, transforms and approvals. Maintainers closed its base PR and said they will
design plugins themselves. Ctrl keeps upstream's manifest file name, id rule, `apiVersion`, and the
field names of status items and notifications. If upstream ships its own system, migrating stays
mechanical.
