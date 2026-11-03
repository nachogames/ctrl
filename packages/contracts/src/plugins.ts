/**
 * Local plugins: folders under `<T3 home>/plugins` that add UI to the app.
 *
 * Plugin code is trusted OS-user code. The host runs a plugin's `entry` in a
 * supervised child process, which keeps a crash out of the server but is not
 * a sandbox. Views run in a sandboxed, opaque-origin frame.
 *
 * Names and shapes follow the upstream plugin proposal (pingdotgg/t3code
 * #16047-#16065) where they overlap: the `t3-plugin.json` manifest, owner
 * qualified ids, `apiVersion`, status items and notification fields.
 *
 * Claude Code mods draw into the same surfaces: their `ui_status` lines,
 * `ui_toast` notices and `AbovePrompt` band arrive with a `claude-mod` source.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The one plugin API version this host implements. Other values do not load. */
export const PLUGIN_API_VERSION = 1;
export const PLUGIN_MANIFEST_FILE = "t3-plugin.json";
/** The folder under the T3 home that holds one subfolder per plugin. */
export const PLUGINS_DIR_NAME = "plugins";

/** Owner-qualified id such as `acme.notifier`: two or more lowercase dot segments. */
export const PluginId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/),
);
export type PluginId = typeof PluginId.Type;

/** Relative path inside the plugin folder with the given extension, without `..` segments. */
const pluginFilePath = (extension: string) =>
  Schema.String.check(
    Schema.isMaxLength(256),
    Schema.isPattern(
      new RegExp(`^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\\\:\\0]+\\.(?:${extension})$`),
    ),
  );

const PluginViewId = Schema.String.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^[a-z][a-z0-9-]*$/),
);

/** One entry of `views`: a page the right panel can show as a tab. */
export const PluginViewDeclaration = Schema.Struct({
  id: PluginViewId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  /** Only the right panel exists today; a host shows only placements it knows. */
  placement: Schema.Literal("side-panel").pipe(
    Schema.withDecodingDefault(Effect.succeed("side-panel" as const)),
  ),
  /** A self-contained HTML page. It runs with the app theme and the `t3` bridge. */
  html: pluginFilePath("html?"),
});
export type PluginViewDeclaration = typeof PluginViewDeclaration.Type;

export const PLUGIN_COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * One entry of `commands`: a `/name` in the composer menu. A command with a
 * `prompt` puts that text in the composer; one without calls the plugin's
 * `commands` handler with the rest of the line.
 */
export const PluginCommandDeclaration = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(32), Schema.isPattern(PLUGIN_COMMAND_NAME_PATTERN)),
  description: Schema.String.check(Schema.isMaxLength(200)),
  prompt: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8000))),
});
export type PluginCommandDeclaration = typeof PluginCommandDeclaration.Type;

export const PluginManifest = Schema.Struct({
  id: PluginId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  version: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  apiVersion: Schema.Int,
  /** Node module the host runs in a child process; it exports `activate(ctx)`. */
  entry: Schema.optionalKey(pluginFilePath("m?js")),
  views: Schema.Array(PluginViewDeclaration)
    .check(Schema.isMaxLength(8))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  commands: Schema.Array(PluginCommandDeclaration)
    .check(Schema.isMaxLength(16))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type PluginManifest = typeof PluginManifest.Type;

/**
 * `ready`: loaded with no code to run. `running`: its entry is up.
 * `starting` and `restarting` are on the way; `error` stopped after a bad
 * manifest or repeated crashes, and `disabled` is turned off.
 */
export const PluginState = Schema.Literals([
  "ready",
  "starting",
  "running",
  "restarting",
  "error",
  "disabled",
]);
export type PluginState = typeof PluginState.Type;

export const PluginSummary = Schema.Struct({
  /** The manifest id, or the folder name when the manifest could not be read. */
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  description: Schema.optionalKey(Schema.String),
  dir: Schema.String,
  enabled: Schema.Boolean,
  state: PluginState,
  /** Goes up each time the host reloads the plugin's files. */
  revision: Schema.Number,
  error: Schema.optionalKey(Schema.String),
  views: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
  commands: Schema.Array(PluginCommandDeclaration),
});
export type PluginSummary = typeof PluginSummary.Type;

// --- What plugins draw ---

export const PLUGIN_STATUS_TEXT_MAX_LENGTH = 80;
export const PLUGIN_STATUS_MAX_ITEMS_PER_SOURCE = 8;
export const PLUGIN_TOAST_MAX_RETAINED = 20;

export const PluginTone = Schema.Literals(["neutral", "info", "success", "warning", "error"]);
export type PluginTone = typeof PluginTone.Type;

/** Who drew something: a local plugin or a Claude Code mod in that thread's session. */
export const PluginUiSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("plugin"), pluginId: Schema.String, name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("claude-mod"), name: Schema.String }),
]);
export type PluginUiSource = typeof PluginUiSource.Type;

export const pluginUiSourceKey = (source: PluginUiSource): string =>
  source.kind === "plugin" ? `plugin:${source.pluginId}` : `claude-mod:${source.name}`;

/** Upstream's ContributionStatusItem: a short line keyed within its source. */
export const PluginStatusItem = Schema.Struct({
  key: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(PLUGIN_STATUS_TEXT_MAX_LENGTH)),
  tone: Schema.optionalKey(PluginTone),
  tooltip: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(240))),
});
export type PluginStatusItem = typeof PluginStatusItem.Type;

export const PluginStatusEntry = Schema.Struct({
  threadId: ThreadId,
  source: PluginUiSource,
  items: Schema.Array(PluginStatusItem),
});
export type PluginStatusEntry = typeof PluginStatusEntry.Type;

export const PluginToast = Schema.Struct({
  /** Unique within the server's lifetime; clients show each id once. */
  id: Schema.String,
  source: PluginUiSource,
  title: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(80)),
  body: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(240))),
  tone: Schema.optionalKey(PluginTone),
  threadId: Schema.optionalKey(ThreadId),
  timeoutMs: Schema.optionalKey(Schema.Number),
  createdAt: IsoDateTime,
});
export type PluginToast = typeof PluginToast.Type;

/** Where a band element's press goes: the CLI stamps Claude mod trees, the plugin runner stamps plugin trees. */
export const PluginUiPressTarget = Schema.Struct({
  plugin: Schema.String,
  handle: Schema.Number,
});
export type PluginUiPressTarget = typeof PluginUiPressTarget.Type;

export interface PluginUiElement {
  readonly type: string;
  readonly props?: { readonly [key: string]: unknown };
  readonly press?: PluginUiPressTarget;
  readonly children?: ReadonlyArray<PluginUiChild>;
}
export type PluginUiChild = string | PluginUiElement;

/**
 * One node of a band tree, in the Claude Code mod element table (Box, Text,
 * Button, Link, Code, Markdown, div, span, b). Kept loose: clients draw the
 * types they know and skip the rest.
 */
export const PluginUiElement: Schema.Codec<PluginUiElement> = Schema.Struct({
  type: Schema.String,
  props: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  press: Schema.optionalKey(PluginUiPressTarget),
  children: Schema.optionalKey(
    Schema.Array(
      Schema.Union([
        Schema.String,
        Schema.suspend((): Schema.Codec<PluginUiElement> => PluginUiElement),
      ]),
    ),
  ),
});

/**
 * Terminal columns a band is laid out for. Claude mods are asked to fit this
 * width; clients scale the font so it fits theirs.
 */
export const PLUGIN_BAND_COLUMNS = 100;

export const PluginBandEntry = Schema.Struct({
  threadId: ThreadId,
  source: PluginUiSource,
  tree: PluginUiElement,
});
export type PluginBandEntry = typeof PluginBandEntry.Type;

/** Every plugin and what they show across threads; each frame replaces the last. */
export const PluginsSnapshot = Schema.Struct({
  pluginsDir: Schema.String,
  plugins: Schema.Array(PluginSummary),
  statuses: Schema.Array(PluginStatusEntry),
  /** Oldest first, at most PLUGIN_TOAST_MAX_RETAINED. */
  toasts: Schema.Array(PluginToast),
});
export type PluginsSnapshot = typeof PluginsSnapshot.Type;

export const PluginBandsSnapshot = Schema.Struct({
  bands: Schema.Array(PluginBandEntry),
});
export type PluginBandsSnapshot = typeof PluginBandsSnapshot.Type;

// --- RPC inputs ---

export const PluginsSubscribeInput = Schema.Struct({});
export const PluginBandsSubscribeInput = Schema.Struct({ threadId: ThreadId });

export const PluginBandPressInput = Schema.Struct({
  threadId: ThreadId,
  source: PluginUiSource,
  target: PluginUiPressTarget,
  key: Schema.optionalKey(Schema.String),
});
export type PluginBandPressInput = typeof PluginBandPressInput.Type;

export const PluginViewReadInput = Schema.Struct({
  pluginId: Schema.String,
  viewId: Schema.String,
  /** The plugin's revision the client saw; a new one reads the page afresh. */
  revision: Schema.optionalKey(Schema.Number),
});
export const PluginViewReadResult = Schema.Struct({
  title: Schema.String,
  /** The page with the theme bootstrap and the `t3` bridge already injected. */
  html: Schema.String,
});
export type PluginViewReadResult = typeof PluginViewReadResult.Type;

export const PLUGIN_VIEW_HANDLER_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;

export const PluginViewCallInput = Schema.Struct({
  pluginId: Schema.String,
  viewId: Schema.String,
  /** The thread whose right panel shows the view. */
  threadId: Schema.optionalKey(ThreadId),
  handler: Schema.String.check(
    Schema.isMaxLength(64),
    Schema.isPattern(PLUGIN_VIEW_HANDLER_PATTERN),
  ),
  input: Schema.Unknown,
});
export type PluginViewCallInput = typeof PluginViewCallInput.Type;
export const PluginViewCallResult = Schema.Struct({ value: Schema.Unknown });

export const PluginCommandRunInput = Schema.Struct({
  pluginId: Schema.String,
  command: Schema.String,
  threadId: ThreadId,
  args: Schema.String.check(Schema.isMaxLength(8000)),
});
export type PluginCommandRunInput = typeof PluginCommandRunInput.Type;

export const PluginSetEnabledInput = Schema.Struct({
  pluginId: Schema.String,
  enabled: Schema.Boolean,
});
export type PluginSetEnabledInput = typeof PluginSetEnabledInput.Type;

export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  message: Schema.String,
}) {}
