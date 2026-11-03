import { describe, expect, it } from "vite-plus/test";

import {
  PLUGIN_VIEW_BRIDGE_SCRIPT,
  pluginViewInitMessage,
  pluginViewResultMessage,
  readPluginViewMessage,
} from "./pluginView.ts";

/** Runs the bridge in a fake framed window and returns what it posted and its `t3`. */
function loadBridge() {
  const posted: unknown[] = [];
  const listeners: Array<(event: { source: unknown; data: unknown }) => void> = [];
  const parent = { postMessage: (message: unknown) => posted.push(message) };
  const window: Record<string, unknown> = {
    parent,
    addEventListener: (_type: string, listener: (typeof listeners)[number]) =>
      listeners.push(listener),
  };
  new Function("window", PLUGIN_VIEW_BRIDGE_SCRIPT)(window);
  const deliver = (data: unknown) =>
    listeners.forEach((listener) => listener({ source: parent, data }));
  return {
    posted,
    deliver,
    t3: window.t3 as {
      call: (h: string, i: unknown) => Promise<unknown>;
      ready: (fn: (c: unknown) => void) => void;
    },
  };
}

describe("plugin view bridge", () => {
  it("announces itself, then round-trips a call through the client", async () => {
    const { posted, deliver, t3 } = loadBridge();
    expect(readPluginViewMessage(posted[0])).toEqual({ type: "ready" });

    let context: unknown;
    t3.ready((value) => {
      context = value;
    });
    deliver(pluginViewInitMessage({ pluginId: "acme.hello", viewId: "main", threadId: "t1" }));
    expect(context).toEqual({ pluginId: "acme.hello", viewId: "main", threadId: "t1" });

    const answer = t3.call("greet", { name: "Neil" });
    const call = readPluginViewMessage(posted[1]);
    expect(call).toMatchObject({ type: "call", handler: "greet", input: { name: "Neil" } });
    if (call?.type !== "call") throw new Error("expected a call");
    deliver(pluginViewResultMessage(call.id, { hello: "Neil" }));
    await expect(answer).resolves.toEqual({ hello: "Neil" });
  });

  it("ignores messages that are not bridge messages", () => {
    expect(readPluginViewMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed" })).toBe(
      undefined,
    );
    expect(
      readPluginViewMessage({
        jsonrpc: "2.0",
        id: 4,
        method: "t3/plugin.call",
        params: { handler: "x" },
      }),
    ).toBe(undefined);
    expect(readPluginViewMessage("hello")).toBe(undefined);
  });
});
