import type {
  ProjectScript,
  ThreadGroupManualResource,
  ThreadGroupRunningResource,
  ThreadId,
} from "@t3tools/contracts";
import { projectScriptTerminalId } from "@t3tools/shared/projectScripts";
import { loopbackPort } from "@t3tools/shared/threadGroups";

import { isRunnableScript, webUrl } from "./GroupGlanceCards.logic";

type Resource = ThreadGroupRunningResource;

export const RUNNING_FOOTNOTE =
  "Anything started in this group's worktree or chats shows up here, however it was started.";

/** How long a known server stays listed, greyed, after the scan stops seeing it. */
export const STOPPED_ROW_MS = 30_000;

export interface StoppedRow {
  readonly resource: Resource;
  readonly stoppedAt: number;
}

export interface KnownRow {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  readonly port: number | null;
  readonly state: "running" | "registered" | "stopped";
  /** "started by …", "in this worktree", "registered" or "stopped 10s ago". */
  readonly note: string | null;
  readonly openUrl: string | null;
  /** The terminal Stop interrupts; set only for a running server a member terminal owns. */
  readonly stopTerminal: Resource["terminal"];
  /** Set for a stopped server a runnable script started from the panel. */
  readonly restart: { readonly scriptId: string; readonly threadId: ThreadId } | null;
  readonly canRename: boolean;
  /** The stored manual resource id, for rows that can be removed. */
  readonly manualId: string | null;
  /** The stored manual resource naming this server by its port, for "Remove name". */
  readonly nameId: string | null;
}

export interface FoundRow {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  readonly port: number | null;
  readonly openUrl: string | null;
  readonly canNameIt: boolean;
}

export interface StartRow {
  readonly scriptId: string;
  readonly name: string;
}

export interface RunningView {
  readonly known: ReadonlyArray<KnownRow>;
  readonly found: { readonly label: string; readonly rows: ReadonlyArray<FoundRow> } | null;
  readonly start: ReadonlyArray<StartRow>;
}

export function expireStoppedRows(
  stopped: ReadonlyArray<StoppedRow>,
  now: number,
): ReadonlyArray<StoppedRow> {
  return stopped.filter((row) => now - row.stoppedAt < STOPPED_ROW_MS);
}

/** Ports something actually listens on; a registered row only names a port, so it never counts. */
function runningPorts(resources: ReadonlyArray<Resource>): ReadonlySet<number> {
  return new Set(
    resources.flatMap((resource) =>
      resource.kind === "manual" || resource.port === null ? [] : [resource.port],
    ),
  );
}

/** True when `resource`, or anything running on its port, is in `resources` (registered rows aside). */
function isBackIn(resources: ReadonlyArray<Resource>) {
  const ids = new Set(
    resources.filter((resource) => resource.kind !== "manual").map((resource) => resource.id),
  );
  const ports = runningPorts(resources);
  return (resource: Resource) =>
    ids.has(resource.id) || (resource.port !== null && ports.has(resource.port));
}

/**
 * Known servers that left the scan since `previous`, kept until they expire or
 * anything on their id or port comes back, so a restart never shows twice.
 */
export function trackStoppedRows(input: {
  readonly previous: ReadonlyArray<Resource> | null;
  readonly next: ReadonlyArray<Resource>;
  readonly stopped: ReadonlyArray<StoppedRow>;
  readonly now: number;
}): ReadonlyArray<StoppedRow> {
  const back = isBackIn(input.next);
  const kept = expireStoppedRows(input.stopped, input.now).filter((row) => !back(row.resource));
  const keptIds = new Set(kept.map((row) => row.resource.id));
  const newly = (input.previous ?? [])
    .filter(
      (resource) =>
        resource.tier === "known" &&
        resource.kind === "server" &&
        !back(resource) &&
        !keptIds.has(resource.id),
    )
    .map((resource) => ({ resource, stoppedAt: input.now }));
  return [...kept, ...newly];
}

export interface StoppedTracking {
  /** The last scan, which the next one is diffed against. */
  readonly previous: ReadonlyArray<Resource> | null;
  readonly stopped: ReadonlyArray<StoppedRow>;
}

export const NO_STOPPED_TRACKING: StoppedTracking = { previous: null, stopped: [] };

/**
 * Folds one scan into the tracking state. The previous scan lives in the same
 * state rather than a ref: a state updater runs later, during render, so a ref
 * written beside it already holds `next` and nothing would ever look stopped.
 */
export function observeScan(
  state: StoppedTracking,
  next: ReadonlyArray<Resource>,
  now: number,
): StoppedTracking {
  return {
    previous: next,
    stopped: trackStoppedRows({ previous: state.previous, next, stopped: state.stopped, now }),
  };
}

export function stoppedLabel(stoppedAt: number, now: number): string {
  const seconds = Math.floor((now - stoppedAt) / 1000);
  return seconds < 5 ? "stopped just now" : `stopped ${seconds - (seconds % 5)}s ago`;
}

const MANUAL_ID_PREFIX = "manual:";

function manualIdOf(resource: Resource): string | null {
  return resource.kind === "manual" && resource.id.startsWith(MANUAL_ID_PREFIX)
    ? resource.id.slice(MANUAL_ID_PREFIX.length)
    : null;
}

/** The registered resource that names whatever runs on `port`: the first one on that port. */
export function manualNameIdFor(
  manual: ReadonlyArray<ThreadGroupManualResource>,
  port: number | null,
): string | null {
  if (port === null) return null;
  return (
    manual.find((resource) => resource.url !== null && loopbackPort(resource.url) === port)?.id ??
    null
  );
}

function startedBy(
  resource: Resource,
  chatTitles: ReadonlyMap<ThreadId, string>,
  currentThreadId: ThreadId,
): string | null {
  if (resource.kind === "manual") return "registered";
  if (resource.startedByThreadId === null) {
    return resource.source === "cwd" ? "in this worktree" : null;
  }
  if (resource.startedByThreadId === currentThreadId) return "started by this chat";
  const title = chatTitles.get(resource.startedByThreadId);
  return title === undefined ? null : `started by ${title}`;
}

/** Restart only re-runs a runnable script the panel started in its `script-<id>` terminal. */
function restartOf(resource: Resource, runnable: ReadonlySet<string>): KnownRow["restart"] {
  const { scriptId, terminal } = resource;
  return scriptId !== null &&
    runnable.has(scriptId) &&
    terminal !== null &&
    terminal.terminalId === projectScriptTerminalId(scriptId)
    ? { scriptId, threadId: terminal.threadId }
    : null;
}

export function runningView(input: {
  readonly resources: ReadonlyArray<Resource>;
  readonly stopped: ReadonlyArray<StoppedRow>;
  readonly scripts: ReadonlyArray<ProjectScript>;
  /** The group's registered resources, which name servers on their ports. */
  readonly manual: ReadonlyArray<ThreadGroupManualResource>;
  readonly chatTitles: ReadonlyMap<ThreadId, string>;
  readonly currentThreadId: ThreadId;
  readonly now: number;
}): RunningView {
  const manualResources = input.manual;
  const runnable = input.scripts.filter(isRunnableScript);
  const runnableIds = new Set(runnable.map((script) => script.id));
  const live: Array<KnownRow> = input.resources
    .filter((resource) => resource.tier === "known")
    .map((resource) => {
      const manual = resource.kind === "manual";
      return {
        id: resource.id,
        name: resource.name,
        detail: resource.detail,
        port: resource.port,
        state: manual ? "registered" : "running",
        note: startedBy(resource, input.chatTitles, input.currentThreadId),
        openUrl: webUrl(resource.url),
        stopTerminal: manual ? null : resource.terminal,
        restart: null,
        canRename: resource.port !== null,
        manualId: manualIdOf(resource),
        nameId: manual ? null : manualNameIdFor(manualResources, resource.port),
      };
    });
  // Also drop stopped rows already back in this scan, so a restart never shows twice
  // even before the caller's tracked state catches up.
  const back = isBackIn(input.resources);
  const stopped: Array<KnownRow> = expireStoppedRows(input.stopped, input.now)
    .filter((row) => !back(row.resource))
    .map(({ resource, stoppedAt }) => ({
      id: resource.id,
      name: resource.name,
      detail: resource.detail,
      port: resource.port,
      state: "stopped",
      note: stoppedLabel(stoppedAt, input.now),
      openUrl: null,
      stopTerminal: null,
      restart: restartOf(resource, runnableIds),
      canRename: false,
      manualId: null,
      nameId: manualNameIdFor(manualResources, resource.port),
    }));
  const stoppedPorts = new Set(stopped.flatMap((row) => (row.port === null ? [] : [row.port])));
  const foundResources = input.resources.filter((resource) => resource.tier === "found");
  const names = [...new Set(foundResources.map((resource) => resource.name))];
  const count = foundResources.length;
  const scriptIds = new Set(
    input.resources.flatMap((resource) => (resource.scriptId === null ? [] : [resource.scriptId])),
  );
  const ports = runningPorts(input.resources);
  const restarting = new Set(
    stopped.flatMap((row) => (row.restart === null ? [] : [row.restart.scriptId])),
  );
  return {
    // While a server's stopped row shows, the registered row naming its port would repeat it.
    known: [
      ...live.filter(
        (row) => row.state !== "registered" || row.port === null || !stoppedPorts.has(row.port),
      ),
      ...stopped,
    ],
    found:
      count === 0
        ? null
        : {
            label: `${count} other ${count === 1 ? "process" : "processes"} in this worktree · ${names.slice(0, 3).join(", ")}`,
            rows: foundResources.map((resource) => ({
              id: resource.id,
              name: resource.name,
              detail: resource.detail,
              port: resource.port,
              openUrl: webUrl(resource.url),
              canNameIt: resource.kind === "server" && resource.port !== null,
            })),
          },
    start: runnable
      .filter((script) => {
        if (scriptIds.has(script.id) || restarting.has(script.id)) return false;
        const port = script.previewUrl === undefined ? null : loopbackPort(script.previewUrl);
        return port === null || !ports.has(port);
      })
      .map((script) => ({ scriptId: script.id, name: script.name })),
  };
}

/** Rename the registered resource on `port`, or register one for it. */
export function renameManualResources(
  manual: ReadonlyArray<ThreadGroupManualResource>,
  input: { readonly port: number; readonly name: string },
): ReadonlyArray<ThreadGroupManualResource> {
  const index = manual.findIndex(
    (resource) => resource.url !== null && loopbackPort(resource.url) === input.port,
  );
  if (index >= 0) {
    return manual.map((resource, at) =>
      at === index ? { ...resource, name: input.name } : resource,
    );
  }
  const ids = new Set(manual.map((resource) => resource.id));
  let id = `port-${input.port}`;
  for (let suffix = 2; ids.has(id); suffix += 1) id = `port-${input.port}-${suffix}`;
  return [
    ...manual,
    { id, name: input.name, url: `http://localhost:${input.port}`, kind: "server" },
  ];
}
