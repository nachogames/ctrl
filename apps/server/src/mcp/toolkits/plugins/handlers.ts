import * as Effect from "effect/Effect";

import * as PluginHost from "../../../plugins/PluginHost.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { PLUGIN_AUTHORING_GUIDE, PluginToolkit } from "./tools.ts";

const listing = Effect.fn("PluginToolkit.listing")(function* (reload: boolean) {
  const host = yield* PluginHost.PluginHost;
  const plugins = yield* reload ? host.reload : host.list;
  return { pluginsDir: host.pluginsDir, guide: PLUGIN_AUTHORING_GUIDE, plugins };
});

export const layer = McpToolAccess.toLayer(PluginToolkit, {
  t3_plugin_list: McpToolAccess.reads(() => listing(false)),
  // Reloading runs the plugins' code, so read-only clients cannot ask for it.
  t3_plugin_reload: McpToolAccess.writesWithCapability(() => listing(true)),
});
