import { OrchestratorMcpFailure, PLUGIN_API_VERSION, PluginSummary } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PluginHost from "../../../plugins/PluginHost.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** How to write a plugin, returned with every listing so an agent never needs another source. */
export const PLUGIN_AUTHORING_GUIDE = [
  "A plugin is a folder in pluginsDir holding t3-plugin.json. T3 watches the folder and loads, reloads and restarts plugins on save; no restart needed.",
  `t3-plugin.json: {"id": "owner.name" (lowercase, two or more dot segments), "name", "version", "description"?, "apiVersion": ${PLUGIN_API_VERSION}, "entry"?: "index.mjs", "views"?: [{"id", "title", "html": "view.html"}], "commands"?: [{"name", "description", "prompt"?}]}.`,
  "views: a self-contained HTML page shown as a tab in the right panel, in a sandboxed frame with the app's theme as CSS variables (--background, --foreground, --muted-foreground, --border, --primary, --font-sans, --font-mono). In the page, `await t3.call(name, input)` runs the entry's ctx.handle(name, fn) and returns its value; `t3.ready(({ threadId }) => ...)` gives the thread the panel belongs to.",
  "commands: a /name in the composer menu. With `prompt`, choosing it puts that text in the composer. Without, choosing it runs the entry's ctx.onCommand(name, ({ threadId, args }) => ...) right away; args is empty for now.",
  "entry: an ES or CommonJS module exporting activate(ctx); it runs in its own Node process with the user's access and may return a cleanup function. ctx.ui.setStatus(threadId, key, text, { tone, tooltip }) shows a short line on a thread (text '' clears it). ctx.ui.toast({ title, body, tone, threadId }) shows a toast. ctx.ui.setBand(threadId, tree) draws a band above that thread's composer (null clears it); build trees with ctx.ui.h(type, props, ...children) from Box (flex props), Text (color, bold, dimColor), Button ({ label, onPress }), Link ({ href, label }) and Code ({ source }). ctx.onEvent(fn) receives { type: 'run', threadId, runId, status } and { type: 'thread', threadId, change, title }. Tones: neutral, info, success, warning, error.",
  "A write inside the plugin's folder reloads the plugin, so keep files the plugin writes in ctx.plugin.dataDir.",
  "After writing files, call t3_plugin_reload and check the plugin's state, error and recentLogs. A thread id for testing is your own thread's id.",
].join("\n");

const PluginDetails = Schema.Struct({
  ...PluginSummary.fields,
  recentLogs: Schema.Array(Schema.String),
});

const PluginListing = Schema.Struct({
  pluginsDir: Schema.String,
  guide: Schema.String,
  plugins: Schema.Array(PluginDetails),
});

const shared = {
  success: PluginListing,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PluginHost.PluginHost,
  ],
};

const PluginListTool = Tool.make("t3_plugin_list", {
  ...shared,
  description:
    "List T3 plugins with their state, errors and recent log lines, plus the plugins folder and a guide to writing one. Plugins add UI to T3: right-panel views, thread status lines, toasts, a band above the composer, and / commands.",
  parameters: Tool.EmptyParams,
})
  .annotate(Tool.Title, "List plugins")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const PluginReloadTool = Tool.make("t3_plugin_reload", {
  ...shared,
  description:
    "Rescan the plugins folder now, restart plugins whose files changed, and return the same listing as t3_plugin_list. Use it after writing or editing a plugin to see whether it loaded.",
  parameters: Tool.EmptyParams,
})
  .annotate(Tool.Title, "Reload plugins")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const PluginToolkit = Toolkit.make(PluginListTool, PluginReloadTool);
