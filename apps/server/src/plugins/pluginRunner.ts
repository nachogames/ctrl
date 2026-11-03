/**
 * The program a plugin's child process runs. It imports the plugin's `entry`,
 * calls its `activate(ctx)` and relays between `ctx` and the host over the
 * Node IPC channel. It ships as a string so the server needs no extra file at
 * runtime: the host starts `node -e <PLUGIN_RUNNER_SOURCE>`.
 *
 * The `ctx` a plugin gets:
 *
 *   ctx.plugin                      { id, name, version, dir }
 *   ctx.ui.setStatus(threadId, key, text, { tone, tooltip })   text "" clears
 *   ctx.ui.toast({ title, body, tone, threadId, timeoutMs })
 *   ctx.ui.setBand(threadId, tree | null)
 *   ctx.ui.h(type, props, ...children)   builds a band node; props.onPress is a function
 *   ctx.onEvent(fn)                 thread and run events, see PluginHostEvent
 *   ctx.handle(name, fn)            answers `t3.call(name, input)` from the plugin's views
 *   ctx.onCommand(name, fn)         runs `/name args` for commands without a prompt
 *   ctx.log(...args)                same as console.log; the host keeps recent lines
 *
 * activate may return a function; it runs before the process is stopped.
 */

/** Messages the host sends to the runner. */
export type HostToRunner =
  | { readonly t: "event"; readonly event: PluginHostEvent }
  | {
      readonly t: "call";
      readonly id: number;
      readonly handler: string;
      readonly input: unknown;
      readonly context: { readonly viewId: string; readonly threadId: string | null };
    }
  | {
      readonly t: "command";
      readonly id: number;
      readonly name: string;
      readonly threadId: string;
      readonly args: string;
    }
  | {
      readonly t: "press";
      readonly threadId: string;
      readonly handle: number;
      readonly key?: string;
    }
  | { readonly t: "stop" };

/** Messages the runner sends to the host. Decoded defensively: plugin code can send anything. */
export type RunnerToHost =
  | { readonly t: "ready" }
  | { readonly t: "fatal"; readonly error: string }
  | {
      readonly t: "status";
      readonly threadId: string;
      readonly key: string;
      readonly text: string;
      readonly tone?: string;
      readonly tooltip?: string;
    }
  | { readonly t: "band"; readonly threadId: string; readonly tree: unknown }
  | {
      readonly t: "toast";
      readonly title: string;
      readonly body?: string;
      readonly tone?: string;
      readonly threadId?: string;
      readonly timeoutMs?: number;
    }
  | { readonly t: "result"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly t: "result"; readonly id: number; readonly ok: false; readonly error: string };

/** What plugin code receives through `ctx.onEvent`. */
export type PluginHostEvent =
  | {
      readonly type: "run";
      readonly threadId: string;
      readonly runId: string;
      readonly status: string;
    }
  | {
      readonly type: "thread";
      readonly threadId: string;
      readonly change: "created" | "archived" | "deleted";
      readonly title: string | null;
    };

export const PLUGIN_RUNNER_ENTRY_ENV = "T3_PLUGIN_ENTRY";
export const PLUGIN_RUNNER_META_ENV = "T3_PLUGIN_META";

// Plain CommonJS so `node -e` runs it as is; `import()` loads ESM and CJS entries alike.
export const PLUGIN_RUNNER_SOURCE = String.raw`
"use strict";
const { pathToFileURL } = require("node:url");
const send = (message) => { try { if (process.connected) process.send(message); } catch {} };
const meta = JSON.parse(process.env.${PLUGIN_RUNNER_META_ENV} || "{}");
const entry = process.env.${PLUGIN_RUNNER_ENTRY_ENV};
const text = (value) => (value instanceof Error ? (value.stack || value.message) : String(value));
const eventHandlers = new Set();
const callHandlers = new Map();
const commandHandlers = new Map();
// threadId -> handle -> function, replaced with each band the plugin draws.
const pressHandlers = new Map();
let nextHandle = 1;
let dispose = null;

function serialize(node, threadId, handles) {
  if (node === null || node === undefined || node === false) return null;
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node !== "object" || typeof node.type !== "string") return null;
  const props = {};
  let press;
  for (const [key, value] of Object.entries(node.props || {})) {
    if (key === "onPress" && typeof value === "function") {
      const handle = nextHandle++;
      handles.set(handle, value);
      press = { plugin: meta.id, handle };
    } else if (typeof value !== "function") {
      props[key] = value;
    }
  }
  const children = (node.children || [])
    .flat(Infinity)
    .map((child) => serialize(child, threadId, handles))
    .filter((child) => child !== null);
  return { type: node.type, props, ...(press ? { press } : {}), children };
}

const ctx = {
  plugin: meta,
  ui: {
    setStatus(threadId, key, value, options = {}) {
      send({ t: "status", threadId: String(threadId), key: String(key), text: value == null ? "" : String(value), tone: options.tone, tooltip: options.tooltip });
    },
    toast(input) {
      const toast = typeof input === "string" ? { title: input } : input || {};
      send({ t: "toast", title: String(toast.title ?? ""), body: toast.body == null ? undefined : String(toast.body), tone: toast.tone, threadId: toast.threadId, timeoutMs: toast.timeoutMs });
    },
    setBand(threadId, tree) {
      const handles = new Map();
      const serialized = tree == null ? null : serialize(tree, threadId, handles);
      pressHandlers.set(String(threadId), handles);
      send({ t: "band", threadId: String(threadId), tree: serialized });
    },
    h(type, props, ...children) {
      return { type, props: props || {}, children };
    },
  },
  onEvent(fn) { eventHandlers.add(fn); return () => eventHandlers.delete(fn); },
  handle(name, fn) { callHandlers.set(String(name), fn); },
  onCommand(name, fn) { commandHandlers.set(String(name), fn); },
  log: (...args) => console.log(...args),
};

async function answer(id, run) {
  try {
    const value = await run();
    send({ t: "result", id, ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) });
  } catch (error) {
    send({ t: "result", id, ok: false, error: text(error) });
  }
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  switch (message.t) {
    case "event":
      for (const fn of eventHandlers) {
        Promise.resolve().then(() => fn(message.event)).catch((error) => console.error(text(error)));
      }
      return;
    case "call": {
      const fn = callHandlers.get(message.handler);
      return answer(message.id, () => {
        if (!fn) throw new Error("No handler named " + message.handler + "; register one with ctx.handle().");
        return fn(message.input, message.context);
      });
    }
    case "command": {
      const fn = commandHandlers.get(message.name);
      return answer(message.id, () => {
        if (!fn) throw new Error("No command handler for /" + message.name + "; register one with ctx.onCommand().");
        return fn({ threadId: message.threadId, args: message.args });
      });
    }
    case "press": {
      const fn = pressHandlers.get(message.threadId)?.get(message.handle);
      if (fn) Promise.resolve().then(() => fn({ threadId: message.threadId, key: message.key })).catch((error) => console.error(text(error)));
      return;
    }
    case "stop":
      Promise.resolve()
        .then(() => (typeof dispose === "function" ? dispose() : undefined))
        .catch((error) => console.error(text(error)))
        .finally(() => process.exit(0));
      return;
  }
});
process.on("disconnect", () => process.exit(0));
process.on("unhandledRejection", (error) => console.error("Unhandled rejection:", text(error)));

(async () => {
  try {
    const mod = await import(pathToFileURL(entry).href);
    const activate = mod.activate || (mod.default && (mod.default.activate || mod.default));
    if (typeof activate !== "function") throw new Error("The entry must export an activate(ctx) function.");
    dispose = await activate(ctx);
    send({ t: "ready" });
  } catch (error) {
    send({ t: "fatal", error: text(error) });
    setTimeout(() => process.exit(1), 50);
  }
})();
`;
