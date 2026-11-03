// @effect-diagnostics nodeBuiltinImport:off - plugins run as child processes over Node's IPC
// channel, which the Effect process service does not expose, and scans read small local files.
/**
 * PluginHost - loads local plugins from `<T3 home>/plugins` and runs them.
 *
 * Each subfolder with a `t3-plugin.json` is one plugin. The host watches the
 * folder, so a plugin an agent writes or edits loads without a restart. A
 * plugin with an `entry` runs in its own Node child process (see
 * pluginRunner.ts); a crash restarts it with backoff, and repeated crashes
 * stop it in the `error` state until its files change. Plugin code is
 * trusted OS-user code: the process boundary contains crashes, not access.
 *
 * Plugins load enabled. Turning one off is remembered in
 * `<stateDir>/plugins.json`.
 *
 * @module PluginHost
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  PLUGIN_API_VERSION,
  PLUGIN_MANIFEST_FILE,
  PLUGINS_DIR_NAME,
  PluginError,
  PluginManifest,
  type PluginBandPressInput,
  type PluginCommandRunInput,
  type PluginsSnapshot,
  type PluginSummary,
  type PluginTone,
  PluginTone as PluginToneSchema,
  type PluginUiElement,
  type PluginUiSource,
  type PluginViewCallInput,
  type PluginViewReadResult,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";
import { PLUGIN_VIEW_BRIDGE_SCRIPT } from "@t3tools/shared/pluginView";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ClaudeModUi from "./ClaudeModUi.ts";
import * as PluginUiStore from "./PluginUiStore.ts";
import {
  PLUGIN_RUNNER_ENTRY_ENV,
  PLUGIN_RUNNER_META_ENV,
  PLUGIN_RUNNER_SOURCE,
  type HostToRunner,
  type PluginHostEvent,
} from "./pluginRunner.ts";

const decodeManifest = Schema.decodeUnknownExit(Schema.fromJsonString(PluginManifest));
const EnabledStateJson = Schema.fromJsonString(
  Schema.Struct({ disabled: Schema.Array(Schema.String) }),
);
const decodeEnabledState = Schema.decodeUnknownExit(EnabledStateJson);
const encodeEnabledState = Schema.encodeSync(EnabledStateJson);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isTone = Schema.is(PluginToneSchema);
const isThreadId = Schema.is(ThreadId);

const MAX_PLUGINS = 64;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_VIEW_BYTES = 1024 * 1024;
/** Files a fingerprint looks at; enough to notice edits, bounded for a folder with a build tree. */
const MAX_FINGERPRINT_FILES = 400;
const RECENT_LOG_LINES = 40;
/** Crashes within the window before the host gives up until the files change. */
const MAX_CRASHES = 3;
const CRASH_WINDOW_MS = 60_000;
const CALL_TIMEOUT = Duration.seconds(30);
const STOP_GRACE_MS = 2_000;

export interface PluginDetails extends PluginSummary {
  /** The last lines the plugin wrote to stdout and stderr. */
  readonly recentLogs: ReadonlyArray<string>;
}

export interface PluginHostShape {
  readonly pluginsDir: string;
  readonly subscribe: Stream.Stream<PluginsSnapshot>;
  readonly subscribeBands: PluginUiStore.PluginUiStoreShape["subscribeBands"];
  /** Rescans the folder now and restarts plugins whose files changed. */
  readonly reload: Effect.Effect<ReadonlyArray<PluginDetails>>;
  readonly list: Effect.Effect<ReadonlyArray<PluginDetails>>;
  readonly setEnabled: (pluginId: string, enabled: boolean) => Effect.Effect<void, PluginError>;
  readonly readView: (
    pluginId: string,
    viewId: string,
  ) => Effect.Effect<PluginViewReadResult, PluginError>;
  readonly callView: (input: PluginViewCallInput) => Effect.Effect<unknown, PluginError>;
  readonly runCommand: (input: PluginCommandRunInput) => Effect.Effect<void, PluginError>;
  readonly press: (input: PluginBandPressInput) => Effect.Effect<void, PluginError>;
  /** Delivers an event to every running plugin. */
  readonly publishEvent: (event: PluginHostEvent) => Effect.Effect<void>;
}

export class PluginHost extends Context.Service<PluginHost, PluginHostShape>()(
  "t3/plugins/PluginHost",
) {}

interface ScannedPlugin {
  readonly dir: string;
  readonly folder: string;
  readonly fingerprint: string;
  readonly manifest: PluginManifest | null;
  readonly error: string | null;
}

interface RunningChild {
  readonly process: NodeChildProcess.ChildProcess;
  readonly pending: Map<number, Deferred.Deferred<unknown, PluginError>>;
  stopping: boolean;
}

interface PluginRecord {
  scanned: ScannedPlugin;
  revision: number;
  state: PluginSummary["state"];
  error: string | null;
  child: RunningChild | null;
  crashes: number[];
  logs: string[];
  restartFiber: Fiber.Fiber<void> | null;
}

/** A small regular file read through one descriptor, or null. */
const readSmallFile = (filePath: string, maxBytes: number): string | null => {
  try {
    const info = NodeFS.statSync(filePath);
    if (!info.isFile() || info.size > maxBytes) return null;
    return NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
};

/** Sizes and mtimes of the plugin's files, skipping dependencies and dotfiles. */
const fingerprintOf = (dir: string): string => {
  const parts: string[] = [];
  const walk = (current: string, depth: number) => {
    if (depth > 4 || parts.length >= MAX_FINGERPRINT_FILES) return;
    let entries: NodeFS.Dirent[];
    try {
      entries = NodeFS.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = NodePath.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) {
        try {
          const info = NodeFS.statSync(full);
          parts.push(`${NodePath.relative(dir, full)}:${info.size}:${info.mtimeMs}`);
        } catch {
          // Removed mid-scan; the next event rescans.
        }
      }
      if (parts.length >= MAX_FINGERPRINT_FILES) return;
    }
  };
  walk(dir, 0);
  return parts.join("|");
};

/** Inside the plugin folder, following symlinks: a manifest path cannot point outside it. */
const resolveInside = (dir: string, relative: string): string | null => {
  try {
    const root = NodeFS.realpathSync(dir);
    const target = NodeFS.realpathSync(NodePath.join(dir, relative));
    return target === root || target.startsWith(root + NodePath.sep) ? target : null;
  } catch {
    return null;
  }
};

export const scanPluginFolder = (dir: string, folder: string): ScannedPlugin => {
  const base = { dir, folder, fingerprint: fingerprintOf(dir) };
  const raw = readSmallFile(NodePath.join(dir, PLUGIN_MANIFEST_FILE), MAX_MANIFEST_BYTES);
  if (raw === null) {
    return {
      ...base,
      manifest: null,
      error: `${PLUGIN_MANIFEST_FILE} is missing or larger than ${MAX_MANIFEST_BYTES} bytes.`,
    };
  }
  const decoded = decodeManifest(raw);
  if (decoded._tag === "Failure") {
    return {
      ...base,
      manifest: null,
      error: `${PLUGIN_MANIFEST_FILE} is invalid: ${Cause.pretty(decoded.cause)}`,
    };
  }
  const manifest = decoded.value;
  const fail = (error: string): ScannedPlugin => ({ ...base, manifest, error });
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    return fail(`apiVersion ${manifest.apiVersion} is not supported; use ${PLUGIN_API_VERSION}.`);
  }
  if (manifest.entry !== undefined && resolveInside(dir, manifest.entry) === null) {
    return fail(`entry ${manifest.entry} does not exist inside the plugin folder.`);
  }
  for (const view of manifest.views) {
    if (resolveInside(dir, view.html) === null) {
      return fail(`view ${view.id}: ${view.html} does not exist inside the plugin folder.`);
    }
  }
  const viewIds = new Set(manifest.views.map((view) => view.id));
  if (viewIds.size !== manifest.views.length) return fail("Two views share an id.");
  const commandNames = new Set(manifest.commands.map((command) => command.name));
  if (commandNames.size !== manifest.commands.length) return fail("Two commands share a name.");
  return { ...base, manifest, error: null };
};

const toneOf = (value: unknown): PluginTone | undefined => (isTone(value) ? value : undefined);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A band tree from plugin code: elements with a string `type`, bounded in size. */
export const decodeBandTree = (value: unknown, pluginId: string): PluginUiElement | null => {
  let nodes = 0;
  const visit = (node: unknown, depth: number): PluginUiElement | string | null => {
    if (++nodes > 2000 || depth > 32) return null;
    if (typeof node === "string") return node.slice(0, 4000);
    if (!isRecord(node) || typeof node.type !== "string") return null;
    const press =
      isRecord(node.press) && typeof node.press.handle === "number"
        ? { plugin: pluginId, handle: node.press.handle }
        : undefined;
    const children = Array.isArray(node.children)
      ? node.children.map((child) => visit(child, depth + 1)).filter((child) => child !== null)
      : [];
    return {
      type: node.type,
      ...(isRecord(node.props) ? { props: node.props } : {}),
      ...(press === undefined ? {} : { press }),
      ...(children.length === 0 ? {} : { children }),
    };
  };
  const tree = visit(value, 0);
  return tree === null || typeof tree === "string" ? null : tree;
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const store = yield* PluginUiStore.PluginUiStore;
  const claudeModUi = yield* ClaudeModUi.ClaudeModUi;
  const pluginsDir = NodePath.join(config.baseDir, PLUGINS_DIR_NAME);
  const enabledStatePath = NodePath.join(config.stateDir, "plugins.json");
  const services = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(services);

  const records = new Map<string, PluginRecord>();
  const savedState = decodeEnabledState(readSmallFile(enabledStatePath, MAX_MANIFEST_BYTES) ?? "");
  const disabled = new Set<string>(savedState._tag === "Success" ? savedState.value.disabled : []);
  const catalogSignals = new Set<Queue.Queue<void>>();
  const notifyCatalog = Effect.forEach(catalogSignals, (signal) => Queue.offer(signal, undefined), {
    discard: true,
  });
  const reconcileLock = yield* Semaphore.make(1);
  let nextCallId = 1;
  let shuttingDown = false;

  const idOf = (record: PluginRecord) => record.scanned.manifest?.id ?? record.scanned.folder;
  const sourceOf = (record: PluginRecord): PluginUiSource => ({
    kind: "plugin",
    pluginId: idOf(record),
    name: record.scanned.manifest?.name ?? record.scanned.folder,
  });

  const summarize = (record: PluginRecord): PluginDetails => {
    const manifest = record.scanned.manifest;
    return {
      id: idOf(record),
      name: manifest?.name ?? record.scanned.folder,
      version: manifest?.version ?? "",
      ...(manifest?.description === undefined ? {} : { description: manifest.description }),
      dir: record.scanned.dir,
      enabled: !disabled.has(idOf(record)),
      state: record.state,
      revision: record.revision,
      ...(record.error === null ? {} : { error: record.error }),
      views: (manifest?.views ?? []).map((view) => ({ id: view.id, title: view.title })),
      commands: manifest?.commands ?? [],
      recentLogs: [...record.logs],
    };
  };

  const list = Effect.sync(() =>
    [...records.values()]
      .map(summarize)
      .toSorted((left, right) => left.name.localeCompare(right.name)),
  );

  const appendLog = (record: PluginRecord, chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      record.logs.push(line.slice(0, 1000));
    }
    if (record.logs.length > RECENT_LOG_LINES)
      record.logs.splice(0, record.logs.length - RECENT_LOG_LINES);
  };

  const setState = (record: PluginRecord, state: PluginSummary["state"], error: string | null) =>
    Effect.suspend(() => {
      if (record.state === state && record.error === error) return Effect.void;
      record.state = state;
      record.error = error;
      return notifyCatalog;
    });

  /** Applies one message from a plugin process; anything malformed is dropped. */
  const onRunnerMessage = (record: PluginRecord, child: RunningChild, message: unknown) => {
    if (!isRecord(message) || records.get(idOf(record)) !== record || record.child !== child) {
      return Effect.void;
    }
    const source = sourceOf(record);
    switch (message.t) {
      case "ready":
        record.crashes = [];
        return setState(record, "running", null);
      case "fatal":
        appendLog(record, String(message.error));
        return Effect.void;
      case "status":
        if (!isThreadId(message.threadId) || typeof message.key !== "string") return Effect.void;
        {
          const tone = toneOf(message.tone);
          return store.setStatus(message.threadId, source, {
            key: message.key,
            text: typeof message.text === "string" ? message.text : "",
            ...(tone === undefined ? {} : { tone }),
            ...(typeof message.tooltip === "string" ? { tooltip: message.tooltip } : {}),
          });
        }
      case "band":
        if (!isThreadId(message.threadId)) return Effect.void;
        return store.setBand(
          message.threadId,
          source,
          message.tree === null ? null : decodeBandTree(message.tree, idOf(record)),
        );
      case "toast":
        if (typeof message.title !== "string") return Effect.void;
        return store.toast({
          source,
          title: message.title,
          body: typeof message.body === "string" ? message.body : undefined,
          tone: toneOf(message.tone),
          threadId: isThreadId(message.threadId) ? message.threadId : undefined,
          timeoutMs:
            typeof message.timeoutMs === "number" && message.timeoutMs > 0
              ? Math.min(message.timeoutMs, 60_000)
              : undefined,
        });
      case "result": {
        const pending = typeof message.id === "number" ? child.pending.get(message.id) : undefined;
        if (pending === undefined) return Effect.void;
        child.pending.delete(message.id as number);
        return message.ok === true
          ? Deferred.succeed(pending, message.value)
          : Deferred.fail(
              pending,
              new PluginError({ message: String(message.error ?? "The plugin call failed.") }),
            );
      }
      default:
        return Effect.void;
    }
  };

  const failPending = (child: RunningChild, message: string) =>
    Effect.forEach(
      [...child.pending.values()],
      (pending) => Deferred.fail(pending, new PluginError({ message })),
      { discard: true },
    ).pipe(Effect.andThen(Effect.sync(() => child.pending.clear())));

  const stopChild = (record: PluginRecord) =>
    Effect.suspend(() => {
      const restart = record.restartFiber;
      record.restartFiber = null;
      const cancelRestart = restart === null ? Effect.void : Fiber.interrupt(restart);
      const child = record.child;
      record.child = null;
      if (child === null)
        return cancelRestart.pipe(Effect.andThen(store.clearSource(sourceOf(record))));
      child.stopping = true;
      const stop: HostToRunner = { t: "stop" };
      try {
        if (child.process.connected) child.process.send(stop);
      } catch {
        // Already gone.
      }
      // A plugin that ignores the stop request is killed after a grace period.
      const kill = runFork(
        Effect.sleep(Duration.millis(STOP_GRACE_MS)).pipe(
          Effect.andThen(Effect.sync(() => child.process.kill("SIGKILL"))),
        ),
      );
      child.process.once("exit", () => {
        runFork(Fiber.interrupt(kill));
      });
      return cancelRestart.pipe(
        Effect.andThen(failPending(child, "The plugin stopped.")),
        Effect.andThen(store.clearSource(sourceOf(record))),
      );
    });

  const startChild = (record: PluginRecord): Effect.Effect<void> =>
    Effect.suspend(() => {
      const manifest = record.scanned.manifest;
      if (shuttingDown || manifest === null || manifest.entry === undefined) return Effect.void;
      const entryPath = resolveInside(record.scanned.dir, manifest.entry);
      if (entryPath === null)
        return setState(record, "error", `entry ${manifest.entry} is missing.`);
      let processHandle: NodeChildProcess.ChildProcess;
      try {
        processHandle = NodeChildProcess.spawn(process.execPath, ["-e", PLUGIN_RUNNER_SOURCE], {
          cwd: record.scanned.dir,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          env: {
            ...process.env,
            // Desktop runs the server inside Electron; this makes its binary act as Node.
            ELECTRON_RUN_AS_NODE: "1",
            [PLUGIN_RUNNER_ENTRY_ENV]: entryPath,
            [PLUGIN_RUNNER_META_ENV]: encodeJson({
              id: manifest.id,
              name: manifest.name,
              version: manifest.version,
              dir: record.scanned.dir,
            }),
          },
        });
      } catch (cause) {
        return setState(record, "error", `Could not start the plugin: ${String(cause)}`);
      }
      const child: RunningChild = { process: processHandle, pending: new Map(), stopping: false };
      record.child = child;
      processHandle.stdout
        ?.setEncoding("utf8")
        .on("data", (chunk: string) => appendLog(record, chunk));
      processHandle.stderr
        ?.setEncoding("utf8")
        .on("data", (chunk: string) => appendLog(record, chunk));
      processHandle.on("message", (message) => {
        runFork(onRunnerMessage(record, child, message));
      });
      processHandle.on("error", (error) => appendLog(record, `Process error: ${error.message}`));
      processHandle.on("exit", (code, signal) => {
        runFork(onChildExit(record, child, code, signal));
      });
      return setState(record, record.state === "restarting" ? "restarting" : "starting", null);
    });

  const onChildExit = (
    record: PluginRecord,
    child: RunningChild,
    code: number | null,
    signal: NodeJS.Signals | null,
  ) =>
    Effect.gen(function* () {
      yield* failPending(child, "The plugin process exited.");
      if (child.stopping || record.child !== child || records.get(idOf(record)) !== record) return;
      record.child = null;
      yield* store.clearSource(sourceOf(record));
      const now = yield* Clock.currentTimeMillis;
      record.crashes = [...record.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
      const reason = `The plugin exited (${signal ?? `code ${code}`}).`;
      appendLog(record, reason);
      if (record.crashes.length >= MAX_CRASHES) {
        const last = record.logs.slice(-5).join("\n");
        yield* setState(
          record,
          "error",
          `${reason} It crashed ${MAX_CRASHES} times, so it stays stopped until its files change.\n${last}`,
        );
        return;
      }
      yield* setState(record, "restarting", reason);
      const delay = 1000 * 2 ** (record.crashes.length - 1);
      record.restartFiber = runFork(
        Effect.sleep(Duration.millis(delay)).pipe(
          Effect.andThen(
            reconcileLock.withPermits(1)(
              Effect.suspend(() => {
                if (records.get(idOf(record)) !== record || disabled.has(idOf(record))) {
                  return Effect.void;
                }
                record.restartFiber = null;
                return startChild(record);
              }),
            ),
          ),
        ),
      );
    });

  /** Starts or stops one plugin to match its manifest and enabled flag. */
  const activate = (record: PluginRecord) =>
    Effect.gen(function* () {
      if (record.scanned.error !== null) {
        yield* setState(record, "error", record.scanned.error);
        return;
      }
      if (disabled.has(idOf(record))) {
        yield* setState(record, "disabled", null);
        return;
      }
      if (record.scanned.manifest?.entry === undefined) {
        yield* setState(record, "ready", null);
        return;
      }
      yield* startChild(record);
    });

  const writeEnabledState = Effect.sync(() => {
    try {
      NodeFS.mkdirSync(NodePath.dirname(enabledStatePath), { recursive: true });
      NodeFS.writeFileSync(
        enabledStatePath,
        `${encodeEnabledState({ disabled: [...disabled].toSorted() })}\n`,
      );
    } catch {
      // A failed write only loses the setting across restarts.
    }
  });

  const scanAll = Effect.sync((): ScannedPlugin[] => {
    let folders: NodeFS.Dirent[];
    try {
      folders = NodeFS.readdirSync(pluginsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return folders
      .filter(
        (entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()),
      )
      .map((entry) => entry.name)
      .toSorted()
      .slice(0, MAX_PLUGINS)
      .map((folder) => scanPluginFolder(NodePath.join(pluginsDir, folder), folder))
      .filter((scanned) => {
        try {
          return NodeFS.statSync(scanned.dir).isDirectory();
        } catch {
          return false;
        }
      });
  });

  /** Brings the running set in line with the folder. */
  const reconcile = reconcileLock.withPermits(1)(
    Effect.gen(function* () {
      const scanned = yield* scanAll;
      const seen = new Set<string>();
      let changed = false;
      for (const next of scanned) {
        const baseId = next.manifest?.id ?? next.folder;
        const duplicate = seen.has(baseId);
        const id = duplicate ? `${baseId} (${next.folder})` : baseId;
        seen.add(id);
        const scannedPlugin = duplicate
          ? {
              ...next,
              manifest: null,
              error: `Another plugin folder already uses the id ${baseId}.`,
            }
          : next;
        const existing = records.get(id);
        if (existing !== undefined && existing.scanned.fingerprint === scannedPlugin.fingerprint) {
          continue;
        }
        changed = true;
        if (existing !== undefined) yield* stopChild(existing);
        const record: PluginRecord = {
          scanned: scannedPlugin,
          revision: (existing?.revision ?? 0) + 1,
          state: "starting",
          error: null,
          child: null,
          crashes: [],
          logs: existing?.logs ?? [],
          restartFiber: null,
        };
        records.set(id, record);
        yield* activate(record);
      }
      for (const [id, record] of records) {
        if (seen.has(id)) continue;
        changed = true;
        records.delete(id);
        yield* stopChild(record);
      }
      if (changed) yield* notifyCatalog;
    }),
  );

  yield* fs.makeDirectory(pluginsDir, { recursive: true }).pipe(Effect.ignoreCause({ log: true }));
  yield* reconcile;

  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      shuttingDown = true;
      yield* Scope.close(watcherScope, Exit.void);
      for (const record of records.values()) yield* stopChild(record);
    }),
  );
  // An editor save emits several events and may fire before the content is
  // flushed, so a burst settles into one rescan.
  yield* fs.watch(pluginsDir, { recursive: true }).pipe(
    Stream.debounce(Duration.millis(250)),
    Stream.runForEach(() => reconcile),
    Effect.ignoreCause({ log: true }),
    Effect.forkIn(watcherScope),
  );

  const recordFor = (pluginId: string) =>
    Effect.suspend(() => {
      const record = records.get(pluginId);
      return record === undefined
        ? Effect.fail(new PluginError({ message: `No plugin named ${pluginId} is loaded.` }))
        : Effect.succeed(record);
    });

  /** Sends a request to a running plugin and waits for its answer. */
  const request = (
    record: PluginRecord,
    build: (id: number) => HostToRunner,
  ): Effect.Effect<unknown, PluginError> =>
    Effect.gen(function* () {
      const child = record.child;
      if (child === null || record.state !== "running") {
        return yield* new PluginError({
          message: `${idOf(record)} is not running (${record.state}).`,
        });
      }
      const id = nextCallId++;
      const deferred = yield* Deferred.make<unknown, PluginError>();
      child.pending.set(id, deferred);
      try {
        child.process.send(build(id));
      } catch {
        child.pending.delete(id);
        return yield* new PluginError({ message: `${idOf(record)} could not be reached.` });
      }
      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutOrElse({
          duration: CALL_TIMEOUT,
          orElse: () => {
            child.pending.delete(id);
            return Effect.fail(
              new PluginError({ message: `${idOf(record)} did not answer in time.` }),
            );
          },
        }),
      );
    });

  const subscribe: Stream.Stream<PluginsSnapshot> = Stream.unwrap(
    Effect.gen(function* () {
      const signal = yield* Queue.sliding<void>(1);
      catalogSignals.add(signal);
      yield* Effect.addFinalizer(() => Effect.sync(() => catalogSignals.delete(signal)));
      const read = Effect.gen(function* () {
        const plugins = yield* list;
        return {
          pluginsDir,
          plugins: plugins.map(({ recentLogs: _logs, ...summary }) => summary),
          statuses: yield* store.statuses,
          toasts: yield* store.toasts,
        } satisfies PluginsSnapshot;
      });
      // Store changes and catalog changes share one sliding signal, so a burst sends one frame.
      yield* store.changes.pipe(
        Stream.runForEach(() => Queue.offer(signal, undefined)),
        Effect.forkScoped,
      );
      return Stream.concat(
        Stream.fromEffect(read),
        Stream.fromQueue(signal).pipe(Stream.mapEffect(() => read)),
      );
    }),
  );

  return PluginHost.of({
    pluginsDir,
    subscribe,
    subscribeBands: store.subscribeBands,
    reload: reconcile.pipe(Effect.andThen(list)),
    list,
    setEnabled: (pluginId, enabled) =>
      reconcileLock.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* recordFor(pluginId);
          if (enabled === !disabled.has(pluginId)) return;
          if (enabled) disabled.delete(pluginId);
          else disabled.add(pluginId);
          yield* writeEnabledState;
          yield* stopChild(record);
          record.crashes = [];
          yield* activate(record);
          yield* notifyCatalog;
        }),
      ),
    readView: (pluginId, viewId) =>
      Effect.gen(function* () {
        const record = yield* recordFor(pluginId);
        const view = record.scanned.manifest?.views.find((candidate) => candidate.id === viewId);
        if (view === undefined || disabled.has(pluginId) || record.scanned.error !== null) {
          return yield* new PluginError({ message: `${pluginId} has no view ${viewId}.` });
        }
        const path = resolveInside(record.scanned.dir, view.html);
        const html = path === null ? null : readSmallFile(path, MAX_VIEW_BYTES);
        if (html === null) {
          return yield* new PluginError({
            message: `${view.html} is missing or larger than ${MAX_VIEW_BYTES} bytes.`,
          });
        }
        return {
          title: view.title,
          html: injectHtmlRenderBootstrap(html, PLUGIN_VIEW_BRIDGE_SCRIPT),
        };
      }),
    callView: (input) =>
      Effect.gen(function* () {
        const record = yield* recordFor(input.pluginId);
        return yield* request(record, (id) => ({
          t: "call",
          id,
          handler: input.handler,
          input: input.input,
          context: { viewId: input.viewId, threadId: input.threadId ?? null },
        }));
      }),
    runCommand: (input) =>
      Effect.gen(function* () {
        const record = yield* recordFor(input.pluginId);
        yield* request(record, (id) => ({
          t: "command",
          id,
          name: input.command,
          threadId: input.threadId,
          args: input.args,
        }));
      }),
    press: (input) =>
      input.source.kind === "claude-mod"
        ? claudeModUi.press({
            threadId: input.threadId,
            plugin: input.target.plugin,
            handle: input.target.handle,
            key: input.key,
          })
        : Effect.gen(function* () {
            const record = yield* recordFor(input.target.plugin);
            const message: HostToRunner = {
              t: "press",
              threadId: input.threadId,
              handle: input.target.handle,
              ...(input.key === undefined ? {} : { key: input.key }),
            };
            try {
              record.child?.process.send(message);
            } catch {
              // A stopped plugin's band is already gone.
            }
          }),
    publishEvent: (event) =>
      Effect.sync(() => {
        const message: HostToRunner = { t: "event", event };
        for (const record of records.values()) {
          if (record.state !== "running" || record.child === null) continue;
          try {
            record.child.process.send(message);
          } catch {
            // It is exiting; the exit handler takes over.
          }
        }
      }),
  });
});

export const layer = Layer.effect(PluginHost, make);

/** A domain event as plugins see it, or null for the many they do not. */
export const pluginEventOf = (event: OrchestrationV2DomainEvent): PluginHostEvent | null => {
  switch (event.type) {
    case "run.created":
    case "run.updated":
      return {
        type: "run",
        threadId: event.threadId,
        runId: event.payload.id,
        status: event.payload.status,
      };
    case "thread.created":
    case "thread.archived":
    case "thread.deleted":
      return {
        type: "thread",
        threadId: event.threadId,
        change:
          event.type === "thread.created"
            ? "created"
            : event.type === "thread.archived"
              ? "archived"
              : "deleted",
        title: event.payload.title,
      };
    default:
      return null;
  }
};

/** Feeds thread and run events to running plugins. */
export const layerEvents = Layer.effectDiscard(
  Effect.gen(function* () {
    const host = yield* PluginHost;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event) => {
        const pluginEvent = pluginEventOf(event);
        return pluginEvent === null ? Effect.void : host.publishEvent(pluginEvent);
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("Plugin events stopped", { cause }))),
    );
  }),
);
