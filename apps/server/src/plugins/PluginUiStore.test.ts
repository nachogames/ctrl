import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ClaudeModUi from "./ClaudeModUi.ts";
import * as PluginUiStore from "./PluginUiStore.ts";

const threadId = ThreadId.make("thread-plugin-ui");
const plugin = { kind: "plugin", pluginId: "acme.deploys", name: "Deploys" } as const;
const band = { type: "Box", children: [{ type: "Text", children: ["5h 42%"] }] };

const firstBands = (
  store: PluginUiStore.PluginUiStoreShape,
  predicate: (count: number) => boolean,
) =>
  store.subscribeBands(threadId).pipe(
    Stream.filter((snapshot) => predicate(snapshot.bands.length)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

describe("PluginUiStore", () => {
  it.effect("keeps a source's status items sorted by key and removes one on empty text", () =>
    Effect.gen(function* () {
      const store = yield* PluginUiStore.make;
      yield* store.setStatus(threadId, plugin, {
        key: "b",
        text: "build \u001b[32mgreen\u001b[0m",
      });
      yield* store.setStatus(threadId, plugin, { key: "a", text: "deploy 3/5", tone: "info" });
      assert.deepStrictEqual(yield* store.statuses, [
        {
          threadId,
          source: plugin,
          items: [
            { key: "a", text: "deploy 3/5", tone: "info" },
            { key: "b", text: "build green" },
          ],
        },
      ]);

      yield* store.setStatus(threadId, plugin, { key: "a", text: "" });
      yield* store.setStatus(threadId, plugin, { key: "b", text: "" });
      assert.deepStrictEqual(yield* store.statuses, []);
    }),
  );

  it.effect("keeps the newest toasts with fresh ids", () =>
    Effect.gen(function* () {
      const store = yield* PluginUiStore.make;
      for (let index = 0; index < 25; index += 1) {
        yield* store.toast({ source: plugin, title: `Toast ${index}` });
      }
      const toasts = yield* store.toasts;
      assert.strictEqual(toasts.length, 20);
      assert.strictEqual(toasts[0]?.title, "Toast 5");
      assert.strictEqual(new Set(toasts.map((toast) => toast.id)).size, 20);
    }),
  );

  it.effect("clears a stopped source's statuses and bands", () =>
    Effect.gen(function* () {
      const store = yield* PluginUiStore.make;
      yield* store.setStatus(threadId, plugin, { key: "a", text: "running" });
      yield* store.setBand(threadId, plugin, band);
      assert.strictEqual(
        (yield* firstBands(store, (count) => count === 1)).bands[0]?.source,
        plugin,
      );

      yield* store.clearSource(plugin);
      assert.deepStrictEqual(yield* store.statuses, []);
      assert.deepStrictEqual((yield* firstBands(store, () => true)).bands, []);
    }),
  );
});

describe("ClaudeModUi", () => {
  const withStore = Effect.gen(function* () {
    const store = yield* PluginUiStore.make;
    const modUi = yield* ClaudeModUi.make.pipe(
      Effect.provideService(PluginUiStore.PluginUiStore, store),
    );
    return { store, modUi };
  });
  const noBand: ClaudeModUi.ClaudeControlRequest = async () => ({ response: { hooked: false } });

  it.effect("draws mod status lines and toasts as claude-mod sources", () =>
    Effect.gen(function* () {
      const { store, modUi } = yield* withStore;
      yield* modUi.attach(threadId, noBand);
      const message = (body: Record<string, unknown>) =>
        modUi.ingest(threadId, { type: "system", ...body }, noBand);

      yield* message({ subtype: "ui_status", plugin: "tier-badge", text: "T2 feature" });
      yield* message({
        subtype: "ui_toast",
        plugin: "blast-radius",
        text: "3 files",
        timeout_ms: 2500,
      });
      // A message from a query that is no longer attached draws nothing.
      yield* modUi.ingest(
        threadId,
        { type: "system", subtype: "ui_status", plugin: "stale", text: "old" },
        async () => null,
      );

      assert.deepStrictEqual(yield* store.statuses, [
        {
          threadId,
          source: { kind: "claude-mod", name: "tier-badge" },
          items: [{ key: "status", text: "T2 feature" }],
        },
      ]);
      const [toast] = yield* store.toasts;
      assert.strictEqual(toast?.title, "blast-radius");
      assert.strictEqual(toast?.body, "3 files");
      assert.strictEqual(toast?.timeoutMs, 2500);
    }),
  );

  it.effect("asks for the AbovePrompt band on attach and clears everything on detach", () =>
    Effect.gen(function* () {
      const { store, modUi } = yield* withStore;
      const requests: Array<Record<string, unknown>> = [];
      const request: ClaudeModUi.ClaudeControlRequest = async (body) => {
        requests.push(body);
        return { subtype: "success", response: { tree: band, hooked: true } };
      };

      yield* modUi.attach(threadId, request);
      const drawn = yield* firstBands(store, (count) => count === 1);
      assert.deepStrictEqual(drawn.bands[0]?.tree, band);
      assert.strictEqual(requests[0]?.component, "AbovePrompt");
      yield* modUi.ingest(
        threadId,
        { type: "system", subtype: "ui_status", plugin: "tier-badge", text: "T1" },
        request,
      );

      // Another query's close leaves this one's UI alone.
      yield* modUi.detach(threadId, noBand);
      assert.strictEqual((yield* store.statuses).length, 1);

      yield* modUi.detach(threadId, request);
      assert.deepStrictEqual(yield* store.statuses, []);
      assert.deepStrictEqual((yield* firstBands(store, (count) => count === 0)).bands, []);
    }),
  );

  it.effect("ignores the engine's placeholder tree", () =>
    Effect.sync(() => {
      assert.strictEqual(
        ClaudeModUi.bandFromRenderResponse({
          response: { tree: { type: "engine", ref: 0 }, hooked: true },
        }),
        null,
      );
      assert.deepStrictEqual(
        ClaudeModUi.bandFromRenderResponse({ response: { tree: band, hooked: true } }),
        band,
      );
    }),
  );
});
