// @effect-diagnostics nodeBuiltinImport:off - the test writes plugin folders the way an agent would.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { type PluginsSnapshot, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ClaudeModUi from "./ClaudeModUi.ts";
import * as PluginHost from "./PluginHost.ts";

const threadId = ThreadId.make("thread-plugin-host");

const writePlugin = (pluginsDir: string, folder: string, files: Record<string, string>) => {
  const dir = NodePath.join(pluginsDir, folder);
  NodeFS.mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    NodeFS.writeFileSync(NodePath.join(dir, name), contents);
  }
};

const HELLO_ENTRY = `
export function activate(ctx) {
  ctx.ui.setStatus(${JSON.stringify(threadId)}, "build", "green", { tone: "success" });
  ctx.handle("greet", (input, context) => ({ hello: input.name, view: context.viewId }));
}
`;

const manifest = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, name: id, version: "1.0.0", apiVersion: 1, ...extra });

/** The first snapshot, current or upcoming, that satisfies `predicate`. */
const awaitSnapshot = (predicate: (snapshot: PluginsSnapshot) => boolean) =>
  Effect.gen(function* () {
    const host = yield* PluginHost.PluginHost;
    return yield* host.subscribe.pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
      Effect.timeout("20 seconds"),
    );
  });

const pluginIn = (snapshot: PluginsSnapshot, id: string) =>
  snapshot.plugins.find((plugin) => plugin.id === id);

describe("PluginHost", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-plugins-"));
  const pluginsDir = NodePath.join(baseDir, "plugins");
  writePlugin(pluginsDir, "hello", {
    "t3-plugin.json": manifest("acme.hello", {
      entry: "index.mjs",
      views: [{ id: "main", title: "Hello", html: "view.html" }],
      commands: [{ name: "hello", description: "Say hello", prompt: "Say hello" }],
    }),
    "index.mjs": HELLO_ENTRY,
    "view.html": "<!doctype html><html><head></head><body><p id=greeting>Hi</p></body></html>",
  });
  writePlugin(pluginsDir, "broken", {
    "t3-plugin.json": manifest("acme.broken", { apiVersion: 9 }),
  });

  const layer = PluginHost.layer.pipe(
    Layer.provideMerge(ClaudeModUi.layerWithStore),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );

  // Live services: the folder watcher debounces on the real clock.
  it.layer(layer, { excludeTestServices: true })((it) => {
    it.effect("runs a plugin's entry, which draws a status and answers its view", () =>
      Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const running = yield* awaitSnapshot(
          (snapshot) =>
            pluginIn(snapshot, "acme.hello")?.state === "running" && snapshot.statuses.length > 0,
        );
        assert.deepStrictEqual(running.statuses, [
          {
            threadId,
            source: { kind: "plugin", pluginId: "acme.hello", name: "acme.hello" },
            items: [{ key: "build", text: "green", tone: "success" }],
          },
        ]);
        assert.deepStrictEqual(pluginIn(running, "acme.hello")?.views, [
          { id: "main", title: "Hello" },
        ]);

        const value = yield* host.callView({
          pluginId: "acme.hello",
          viewId: "main",
          threadId,
          handler: "greet",
          input: { name: "Neil" },
        });
        assert.deepStrictEqual(value, { hello: "Neil", view: "main" });

        const view = yield* host.readView("acme.hello", "main");
        assert.include(view.html, "<p id=greeting>Hi</p>");
        assert.include(view.html, "window.t3=");
      }),
    );

    it.effect("reports a manifest it cannot load", () =>
      Effect.gen(function* () {
        const snapshot = yield* awaitSnapshot(
          (next) => pluginIn(next, "acme.broken") !== undefined,
        );
        const broken = pluginIn(snapshot, "acme.broken");
        assert.strictEqual(broken?.state, "error");
        assert.include(broken?.error ?? "", "apiVersion 9");
      }),
    );

    it.effect("stops a disabled plugin and clears what it drew", () =>
      Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* awaitSnapshot((snapshot) => pluginIn(snapshot, "acme.hello")?.state === "running");
        yield* host.setEnabled("acme.hello", false);
        const stopped = yield* awaitSnapshot(
          (snapshot) => pluginIn(snapshot, "acme.hello")?.state === "disabled",
        );
        assert.deepStrictEqual(stopped.statuses, []);
        yield* host.setEnabled("acme.hello", true);
        yield* awaitSnapshot((snapshot) => pluginIn(snapshot, "acme.hello")?.state === "running");
      }),
    );

    it.effect("loads a plugin written while the server runs", () =>
      Effect.gen(function* () {
        writePlugin(pluginsDir, "later", {
          "t3-plugin.json": manifest("acme.later", {
            views: [{ id: "panel", title: "Later", html: "panel.html" }],
          }),
          "panel.html": "<p>later</p>",
        });
        const snapshot = yield* awaitSnapshot(
          (next) => pluginIn(next, "acme.later")?.state === "ready",
        );
        assert.deepStrictEqual(pluginIn(snapshot, "acme.later")?.views, [
          { id: "panel", title: "Later" },
        ]);
      }),
    );
  });
});

describe("decodeBandTree", () => {
  it("keeps element types, props and press handles, stamped with the plugin's id", () => {
    assert.deepStrictEqual(
      PluginHost.decodeBandTree(
        {
          type: "Box",
          props: { gap: 1 },
          children: [
            "Deploy",
            { type: "Button", props: { label: "Run" }, press: { plugin: "other", handle: 3 } },
            { notAnElement: true },
          ],
        },
        "acme.deploys",
      ),
      {
        type: "Box",
        props: { gap: 1 },
        children: [
          "Deploy",
          { type: "Button", props: { label: "Run" }, press: { plugin: "acme.deploys", handle: 3 } },
        ],
      },
    );
  });
});
