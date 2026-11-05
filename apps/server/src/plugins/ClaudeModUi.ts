/**
 * Draws Claude Code mods' `ui_status` lines, `ui_toast` notices and `AbovePrompt` band in a
 * headless session. A band arrives only when asked with a `ui_render` control request, so this
 * asks on attach and on each `ui_invalidate`.
 */
import {
  PLUGIN_BAND_COLUMNS,
  type PluginUiElement,
  type PluginUiSource,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as PluginUiStore from "./PluginUiStore.ts";

/** Sends one control request on the thread's live Claude query. */
export type ClaudeControlRequest = (request: Record<string, unknown>) => Promise<unknown>;

class ClaudeModUiRequestError extends Schema.TaggedError<ClaudeModUiRequestError>()(
  "ClaudeModUiRequestError",
  { subtype: Schema.String, cause: Schema.Defect() },
) {}

const BAND_INSTANCE_ID = "above-prompt";
const BAND_MAX_ROWS = 12;
const DEFAULT_TOAST_TIMEOUT_MS = 4000;

/** The mods' combined AbovePrompt band is one tree, drawn under one source. */
const CLAUDE_MOD_BAND_SOURCE: PluginUiSource = { kind: "claude-mod", name: "Claude Code" };

interface ThreadEntry {
  request: ClaudeControlRequest | undefined;
  rendering: boolean;
  renderAgain: boolean;
  /** Mods with a status line on this thread, cleared when the query closes. */
  statusMods: Set<string>;
}

export interface ClaudeModUiShape {
  readonly attach: (threadId: ThreadId, request: ClaudeControlRequest) => Effect.Effect<void>;
  readonly detach: (threadId: ThreadId, request: ClaudeControlRequest) => Effect.Effect<void>;
  /** `from` is the sending query's sender; messages from a replaced query are dropped. */
  readonly ingest: (
    threadId: ThreadId,
    message: unknown,
    from: ClaudeControlRequest | undefined,
  ) => Effect.Effect<void>;
  /** Forwards a band Button press to the thread's live query. */
  readonly press: (input: {
    readonly threadId: ThreadId;
    readonly plugin: string;
    readonly handle: number;
    readonly key?: string | undefined;
  }) => Effect.Effect<void>;
}

/** Draws nothing; the query runner uses it wherever the server graph supplies no ClaudeModUi. */
const noopClaudeModUi: ClaudeModUiShape = {
  attach: () => Effect.void,
  detach: () => Effect.void,
  ingest: () => Effect.void,
  press: () => Effect.void,
};

/**
 * A reference, not a required service, so provider layers and their tests
 * build without it; the server provides the real one below its providers.
 */
export class ClaudeModUi extends Context.Reference<ClaudeModUiShape>("t3/plugins/ClaudeModUi", {
  defaultValue: () => noopClaudeModUi,
}) {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A band tree worth drawing: an element the mods drew, not the engine's own
 * placeholder. The SDK resolves a control request with the whole
 * `{ subtype, request_id, response }` envelope.
 */
export const bandFromRenderResponse = (envelope: unknown): PluginUiElement | null => {
  const response = isRecord(envelope) ? envelope.response : undefined;
  if (!isRecord(response) || response.hooked !== true) return null;
  const tree = response.tree;
  if (!isRecord(tree) || typeof tree.type !== "string" || tree.type === "engine") return null;
  return tree as unknown as PluginUiElement;
};

export const make = Effect.gen(function* () {
  const store = yield* PluginUiStore.PluginUiStore;
  const threads = new Map<ThreadId, ThreadEntry>();

  const entryFor = (threadId: ThreadId): ThreadEntry => {
    let entry = threads.get(threadId);
    if (entry === undefined) {
      entry = { request: undefined, rendering: false, renderAgain: false, statusMods: new Set() };
      threads.set(threadId, entry);
    }
    return entry;
  };

  const removeIfIdle = (threadId: ThreadId, entry: ThreadEntry) =>
    Effect.sync(() => {
      if (!entry.rendering && entry.request === undefined && threads.get(threadId) === entry) {
        threads.delete(threadId);
      }
    });

  /** Asks the CLI to draw the AbovePrompt band and stores it if this query is still current. */
  const renderBand = (threadId: ThreadId, request: ClaudeControlRequest) =>
    Effect.tryPromise({
      try: () =>
        request({
          subtype: "ui_render",
          surface: "desktop",
          component: "AbovePrompt",
          instance_id: BAND_INSTANCE_ID,
          props: {
            hasSurvey: false,
            isWorking: false,
            maxRows: BAND_MAX_ROWS,
            bodyColumns: PLUGIN_BAND_COLUMNS,
            scroll: { offset: 0, bodyRows: BAND_MAX_ROWS },
          },
        }),
      catch: (cause) => new ClaudeModUiRequestError({ subtype: "ui_render", cause }),
    }).pipe(
      Effect.flatMap((response) =>
        threads.get(threadId)?.request === request
          ? store.setBand(threadId, CLAUDE_MOD_BAND_SOURCE, bandFromRenderResponse(response))
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logDebug("claude-mod-ui.render-failed", { threadId, cause }),
      ),
    );

  /** Asks for the band, folding invalidates that land mid-render into one more render. */
  const requestRender = (threadId: ThreadId) =>
    Effect.suspend(() => {
      const entry = entryFor(threadId);
      if (entry.request === undefined) return Effect.void;
      if (entry.rendering) {
        entry.renderAgain = true;
        return Effect.void;
      }
      entry.rendering = true;
      const loop: Effect.Effect<void> = Effect.suspend(() => {
        const request = entry.request;
        entry.renderAgain = false;
        if (request === undefined) return Effect.void;
        return renderBand(threadId, request).pipe(
          Effect.andThen(Effect.suspend(() => (entry.renderAgain ? loop : Effect.void))),
        );
      });
      return loop.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            entry.rendering = false;
          }).pipe(Effect.andThen(removeIfIdle(threadId, entry))),
        ),
        Effect.forkDetach,
        Effect.asVoid,
      );
    });

  const clearThread = Effect.fn("ClaudeModUi.clearThread")(function* (
    threadId: ThreadId,
    entry: ThreadEntry,
  ) {
    yield* store.setBand(threadId, CLAUDE_MOD_BAND_SOURCE, null);
    for (const name of entry.statusMods) {
      yield* store.clearSource({ kind: "claude-mod", name }, threadId);
    }
    entry.statusMods.clear();
  });

  const attach: ClaudeModUiShape["attach"] = (threadId, request) =>
    Effect.suspend(() => {
      entryFor(threadId).request = request;
      return requestRender(threadId);
    });

  const detach: ClaudeModUiShape["detach"] = (threadId, request) =>
    Effect.suspend(() => {
      const entry = threads.get(threadId);
      // A replacement query may already have attached; only its own close clears it.
      if (entry === undefined || entry.request !== request) return Effect.void;
      entry.request = undefined;
      return clearThread(threadId, entry).pipe(Effect.andThen(removeIfIdle(threadId, entry)));
    });

  const ingest: ClaudeModUiShape["ingest"] = (threadId, message, from) => {
    if (!isRecord(message) || message.type !== "system") return Effect.void;
    const entry = threads.get(threadId);
    if (entry === undefined || entry.request !== from) return Effect.void;
    switch (message.subtype) {
      case "ui_status": {
        if (typeof message.plugin !== "string") return Effect.void;
        const text = typeof message.text === "string" ? message.text : "";
        entry.statusMods.add(message.plugin);
        return store.setStatus(
          threadId,
          { kind: "claude-mod", name: message.plugin },
          {
            key: "status",
            text,
          },
        );
      }
      case "ui_toast": {
        if (typeof message.plugin !== "string" || typeof message.text !== "string") {
          return Effect.void;
        }
        return store.toast({
          source: { kind: "claude-mod", name: message.plugin },
          title: message.plugin,
          body: message.text,
          threadId,
          timeoutMs:
            typeof message.timeout_ms === "number" ? message.timeout_ms : DEFAULT_TOAST_TIMEOUT_MS,
        });
      }
      case "ui_invalidate":
        return requestRender(threadId);
      default:
        return Effect.void;
    }
  };

  const press: ClaudeModUiShape["press"] = (input) =>
    Effect.suspend(() => {
      const request = threads.get(input.threadId)?.request;
      if (request === undefined) return Effect.void;
      return Effect.tryPromise({
        try: () =>
          request({
            subtype: "ui_press",
            plugin: input.plugin,
            handle: input.handle,
            surface: "desktop",
            ...(input.key === undefined ? {} : { key: input.key }),
          }),
        catch: (cause) => new ClaudeModUiRequestError({ subtype: "ui_press", cause }),
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("claude-mod-ui.press-failed", { threadId: input.threadId, cause }),
        ),
        Effect.asVoid,
      );
    });

  return { attach, detach, ingest, press } satisfies ClaudeModUiShape;
});

const layer = Layer.effect(ClaudeModUi, make);

/** The store and the Claude mod bridge that writes into it, shared by the whole server. */
export const layerWithStore = layer.pipe(Layer.provideMerge(PluginUiStore.layer));
