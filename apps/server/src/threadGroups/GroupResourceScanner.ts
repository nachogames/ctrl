/**
 * The running resources of a chat group, computed live on each scan.
 *
 * A local server belongs to the group when the T3 terminal that started it
 * belongs to a member chat, or when its process's working directory is inside
 * the group's worktree. A container belongs to it when its compose
 * `working_dir` label is inside the worktree. A group without a worktree gets
 * terminal attribution only. Registered resources come from the group shell.
 * Servers a member terminal owns, and anything registered, are "known"; the
 * rest only run in the worktree and are "found".
 * Scanner failures degrade to fewer results, never an error.
 *
 * A chat outside any group is scanned as a group of one: its own terminals and
 * its own worktree, with nothing registered.
 *
 * `changes` streams a target's resources while someone watches it. Every
 * watcher of one target shares a single scan loop, so open panels never
 * multiply `lsof` or `docker` runs.
 */
import type {
  DiscoveredLocalServer,
  ProjectId,
  ProjectScript,
  TerminalSummary,
  ThreadGroupId,
  ThreadGroupManualResource,
  ThreadGroupResourcesTarget,
  ThreadGroupRunningResource,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectScripts, scriptIdFromTerminalId } from "@t3tools/shared/projectScripts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import { loopbackPort } from "@t3tools/shared/threadGroups";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as RcMap from "effect/RcMap";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ThreadGroupService from "../orchestration-v2/ThreadGroupService.ts";
import * as ThreadGroupStore from "../orchestration-v2/ThreadGroupStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as DockerScanner from "./DockerScanner.ts";
import * as ProcessCwd from "./processCwd.ts";

/** A group, or one chat outside any group. */
export type GroupResourceTarget = ThreadGroupResourcesTarget;

/** What a scan matches against: the group's chats and its resolved worktree. */
export interface GroupAttributionScope {
  readonly memberThreadIds: ReadonlySet<ThreadId>;
  /** Absolute, symlink-free worktree path; null when the group has none. */
  readonly worktreeRoot: string | null;
}

const ownedByMember = (listener: DiscoveredLocalServer, scope: GroupAttributionScope) =>
  listener.terminal !== null && scope.memberThreadIds.has(listener.terminal.threadId);

/**
 * Listeners whose working directory decides attribution. `serverPid` is the
 * T3 server's own process, which is never a group's server even when it runs
 * from the group's worktree.
 */
export const listenersNeedingCwd = (
  listeners: ReadonlyArray<DiscoveredLocalServer>,
  scope: GroupAttributionScope,
  serverPid: number,
): ReadonlyArray<number> =>
  scope.worktreeRoot === null
    ? []
    : listeners.flatMap((listener) =>
        listener.pid === null || listener.pid === serverPid || ownedByMember(listener, scope)
          ? []
          : [listener.pid],
      );

/** The group's servers among `listeners`, in listener order. */
export const attributeServers = (
  listeners: ReadonlyArray<DiscoveredLocalServer>,
  scope: GroupAttributionScope,
  cwdByPid: ReadonlyMap<number, string>,
): ReadonlyArray<ThreadGroupRunningResource> =>
  listeners.flatMap((listener): ReadonlyArray<ThreadGroupRunningResource> => {
    const cwd = listener.pid === null ? undefined : cwdByPid.get(listener.pid);
    const source = ownedByMember(listener, scope)
      ? "terminal"
      : scope.worktreeRoot !== null &&
          cwd !== undefined &&
          ProcessCwd.isPathInside(scope.worktreeRoot, cwd)
        ? "cwd"
        : null;
    if (source === null) return [];
    const terminal = source === "terminal" ? listener.terminal : null;
    return [
      {
        id: `server:${listener.port}`,
        kind: "server",
        name: listener.processName ?? "server",
        detail: `:${listener.port}`,
        url: `http://${listener.host}:${listener.port}`,
        source,
        tier: source === "terminal" ? "known" : "found",
        terminal,
        startedByThreadId: terminal?.threadId ?? null,
        scriptId: null,
        port: listener.port,
      },
    ];
  });

/**
 * The group's containers among `containers`. Their `workingDir` must already
 * be resolved the same way as the worktree root.
 */
export const attributeContainers = (
  containers: ReadonlyArray<DockerScanner.DockerContainer>,
  worktreeRoot: string | null,
): ReadonlyArray<ThreadGroupRunningResource> =>
  worktreeRoot === null
    ? []
    : containers.flatMap((container): ReadonlyArray<ThreadGroupRunningResource> => {
        if (container.workingDir === null) return [];
        if (!ProcessCwd.isPathInside(worktreeRoot, container.workingDir)) return [];
        const port = container.publishedPorts[0];
        return [
          {
            id: `container:${container.id}`,
            kind: "container",
            name: container.service ?? container.name,
            detail: "docker",
            url: port === undefined ? null : `http://localhost:${port}`,
            source: "docker",
            tier: "found",
            terminal: null,
            startedByThreadId: null,
            scriptId: null,
            port: port ?? null,
          },
        ];
      });

export type TerminalCommand = Pick<TerminalSummary, "label" | "hasRunningSubprocess">;

export const terminalKey = (terminal: { readonly threadId: string; readonly terminalId: string }) =>
  `${terminal.threadId}\u0000${terminal.terminalId}`;

const JS_RUNTIMES = new Set(["node", "bun", "deno"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const JS_LAUNCHERS = new Set(["npm", "pnpm", "yarn", "npx", "bunx", "vp", "bun", "deno", "node"]);

/**
 * The program a terminal runs, or null when it is idle or unknown. With no
 * child label the summary falls back to the terminal's own label, which names
 * no program.
 */
const terminalProgram = (terminalId: string, terminal: TerminalCommand | undefined) => {
  if (terminal === undefined || !terminal.hasRunningSubprocess) return null;
  const label = terminal.label.trim();
  return label.length === 0 || label === getTerminalLabel(terminalId) ? null : label;
};

/**
 * Whether a script terminal still runs its script: its program is unknown, is
 * one of the command's words, or is a JS runtime under a launcher such as
 * `npm` or `vp` (they are node scripts, so `ps` shows `node`). A reused
 * terminal keeps its id after the script stops, so the id alone would name a
 * stranger.
 */
const stillRunsScript = (command: string, program: string | null) => {
  if (program === null) return true;
  const programOf = (word: string) => word.split("/").at(-1);
  if (command.split(/\s+/).some((word) => programOf(word) === program)) return true;
  return (
    JS_RUNTIMES.has(program) &&
    command.split(/&&|\|\||;/).some((segment) => {
      // `PORT=3000 vp dev` sets variables before the launcher.
      const first = segment
        .trim()
        .split(/\s+/)
        .find((word) => !ENV_ASSIGNMENT.test(word));
      return first !== undefined && JS_LAUNCHERS.has(programOf(first) ?? "");
    })
  );
};

/**
 * Servers, then containers, then registered resources. A server is named by a
 * registered resource on its port (which also makes it known and drops that
 * row), else its script, else its terminal's program, else its process.
 */
export const mergeGroupResources = (input: {
  readonly servers: ReadonlyArray<ThreadGroupRunningResource>;
  readonly containers: ReadonlyArray<ThreadGroupRunningResource>;
  readonly manual: ReadonlyArray<ThreadGroupManualResource>;
  readonly scripts?: ReadonlyArray<ProjectScript>;
  /** Keyed by `terminalKey`. */
  readonly terminals?: ReadonlyMap<string, TerminalCommand>;
}): ReadonlyArray<ThreadGroupRunningResource> => {
  const scripts = new Map((input.scripts ?? []).map((script) => [script.id, script]));
  const manualByPort = new Map<number, ThreadGroupManualResource>();
  for (const resource of input.manual) {
    const port = resource.url === null ? null : loopbackPort(resource.url);
    if (port !== null && !manualByPort.has(port)) manualByPort.set(port, resource);
  }
  const naming = new Set<string>();
  const servers = input.servers.map((server): ThreadGroupRunningResource => {
    const named = server.port === null ? undefined : manualByPort.get(server.port);
    if (named !== undefined) naming.add(named.id);
    const terminal =
      server.terminal === null ? undefined : input.terminals?.get(terminalKey(server.terminal));
    const candidate =
      server.terminal === null ? null : scriptIdFromTerminalId(server.terminal.terminalId);
    const candidateScript = candidate === null ? undefined : scripts.get(candidate);
    const program =
      server.terminal === null ? null : terminalProgram(server.terminal.terminalId, terminal);
    const script =
      candidateScript !== undefined && stillRunsScript(candidateScript.command, program)
        ? candidateScript
        : undefined;
    return {
      ...server,
      name: named?.name ?? script?.name ?? program ?? server.name,
      scriptId: script?.id ?? null,
      tier: named !== undefined ? "known" : server.tier,
    };
  });
  return [
    ...servers,
    ...input.containers,
    ...input.manual.flatMap((resource): ReadonlyArray<ThreadGroupRunningResource> =>
      naming.has(resource.id)
        ? []
        : [
            {
              id: `manual:${resource.id}`,
              kind: "manual",
              name: resource.name,
              detail: resource.url ?? "registered",
              url: resource.url,
              source: "registered",
              tier: "known",
              terminal: null,
              startedByThreadId: null,
              scriptId: null,
              port: resource.url === null ? null : loopbackPort(resource.url),
            },
          ],
    ),
  ];
};

/** How often a watched group rescans. Docker has no events, so this is its poll. */
export const RESOURCE_RESCAN_INTERVAL = Duration.seconds(5);

const resourceKey = (resource: ThreadGroupRunningResource) =>
  JSON.stringify([
    resource.id,
    resource.kind,
    resource.name,
    resource.detail,
    resource.url,
    resource.source,
    resource.tier,
    resource.terminal?.threadId ?? null,
    resource.terminal?.terminalId ?? null,
    resource.startedByThreadId,
    resource.scriptId,
    resource.port,
  ]);

/** Same resources, in any order: a reordered scan is not a change. */
const resourcesEqual = (
  left: ReadonlyArray<ThreadGroupRunningResource>,
  right: ReadonlyArray<ThreadGroupRunningResource>,
) => {
  if (left.length !== right.length) return false;
  const leftKeys = left.map(resourceKey).toSorted();
  const rightKeys = right.map(resourceKey).toSorted();
  return leftKeys.every((key, index) => key === rightKeys[index]);
};

/**
 * One scan loop per watched target, shared by all of its watchers and stopped
 * when the last one leaves. The loop scans, then waits for `interval` or a
 * wake from `watch`, whichever comes first. A watcher sees the current list,
 * then each changed list. A scan that returns null or dies keeps the previous list,
 * or yields an empty one when there is none yet.
 */
export const makeResourceFeed = Effect.fn("GroupResourceScanner.makeResourceFeed")(
  function* (options: {
    readonly scan: (
      target: GroupResourceTarget,
    ) => Effect.Effect<ReadonlyArray<ThreadGroupRunningResource> | null>;
    /** Held while a target is watched; runs `wake` to rescan before the next tick. */
    readonly watch: (wake: Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>;
    readonly interval: Duration.Input;
  }) {
    // Targets are plain objects, which RcMap matches structurally.
    const feeds = yield* RcMap.make({
      lookup: (target: GroupResourceTarget) =>
        Effect.gen(function* () {
          const latest =
            yield* SubscriptionRef.make<ReadonlyArray<ThreadGroupRunningResource> | null>(null);
          const wake = yield* Queue.sliding<void>(1);
          const rescan = Effect.gen(function* () {
            // A defect must not end the loop every watcher of this group shares.
            const next = yield* options.scan(target).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("group resource scan died; keeping the last list", {
                  target,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(null)),
              ),
            );
            const current = yield* SubscriptionRef.get(latest);
            if (current !== null && (next === null || resourcesEqual(current, next))) return;
            yield* SubscriptionRef.set(latest, next ?? []);
          });
          yield* options.watch(Queue.offer(wake, undefined).pipe(Effect.asVoid));
          yield* Effect.forkScoped(
            rescan.pipe(
              Effect.andThen(Effect.race(Effect.sleep(options.interval), Queue.take(wake))),
              Effect.forever,
            ),
          );
          return latest;
        }),
    });
    const changes = (target: GroupResourceTarget) =>
      Stream.unwrap(
        RcMap.get(feeds, target).pipe(
          Effect.map((latest) =>
            SubscriptionRef.changes(latest).pipe(
              Stream.filter(
                (resources): resources is ReadonlyArray<ThreadGroupRunningResource> =>
                  resources !== null,
              ),
            ),
          ),
        ),
      );
    return { changes };
  },
);

export type GroupResourceScanError =
  | ThreadGroupService.ThreadGroupNotFoundError
  | ThreadGroupService.ThreadGroupThreadNotFoundError
  | ThreadGroupService.ThreadGroupOperationError;

export class GroupResourceScanner extends Context.Service<
  GroupResourceScanner,
  {
    /** The target's running resources right now. */
    readonly scan: (
      target: GroupResourceTarget,
    ) => Effect.Effect<ReadonlyArray<ThreadGroupRunningResource>, GroupResourceScanError>;
    /**
     * The target's resources now, then each time they change, rescanning every
     * few seconds and whenever the preview scanner sees new servers. A deleted
     * group or chat streams an empty list; a failed scan keeps the last list.
     */
    readonly changes: (
      target: GroupResourceTarget,
    ) => Stream.Stream<ReadonlyArray<ThreadGroupRunningResource>>;
  }
>()("t3/threadGroups/GroupResourceScanner") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const ports = yield* PortScanner.PortDiscovery;
  const docker = yield* DockerScanner.DockerScanner;
  const fileSystem = yield* FileSystem.FileSystem;
  const cwds = yield* ProcessCwd.makeProcessCwdLookup;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;

  const scanServers = Effect.fn("GroupResourceScanner.scanServers")(function* (
    scope: GroupAttributionScope,
  ) {
    const listeners = yield* ports.listListeners;
    const pids = listenersNeedingCwd(listeners, scope, process.pid);
    const cwdByPid = pids.length === 0 ? new Map<number, string>() : yield* cwds.lookup(pids);
    return attributeServers(listeners, scope, cwdByPid);
  });

  const scanContainers = Effect.fn("GroupResourceScanner.scanContainers")(function* (
    worktreeRoot: string | null,
  ) {
    if (worktreeRoot === null) return [];
    const containers = yield* docker.listContainers;
    const resolved = yield* Effect.forEach(
      containers,
      (container) =>
        container.workingDir === null
          ? Effect.succeed(container)
          : ProcessCwd.resolveRealPath(fileSystem, container.workingDir).pipe(
              Effect.map((workingDir) => ({ ...container, workingDir })),
            ),
      { concurrency: 16 },
    );
    return attributeContainers(resolved, worktreeRoot);
  });

  // Read only when a member terminal owns a listener, so most scans touch neither.
  const describeTerminals = Effect.fn("GroupResourceScanner.describeTerminals")(function* (
    projectId: ProjectId,
    servers: ReadonlyArray<ThreadGroupRunningResource>,
  ) {
    const owned = servers.flatMap((server) => (server.terminal === null ? [] : [server.terminal]));
    if (owned.length === 0) return { scripts: [], terminals: new Map<string, TerminalCommand>() };
    const summaries = yield* Effect.forEach(
      owned,
      (terminal) =>
        terminalManager
          .readMetadata(terminal)
          .pipe(Effect.map((summary) => [terminalKey(terminal), summary] as const)),
      { concurrency: "unbounded" },
    );
    const scripts = yield* Effect.all([projects.getById(projectId), settings.getSettings]).pipe(
      Effect.map(([project, current]) =>
        Option.isNone(project) ? [] : resolveProjectScripts(current, project.value),
      ),
      Effect.catch((cause) =>
        Effect.logDebug("group resource scan could not read project scripts", {
          projectId,
          cause,
        }).pipe(Effect.as([])),
      ),
    );
    return {
      scripts,
      terminals: new Map(
        summaries.flatMap(([key, summary]) => (summary === null ? [] : [[key, summary] as const])),
      ),
    };
  });

  const resolveWorktree = (worktreePath: string | null) =>
    worktreePath === null
      ? Effect.succeed(null)
      : ProcessCwd.resolveRealPath(fileSystem, worktreePath);

  const scanScope = Effect.fn("GroupResourceScanner.scanScope")(function* (
    projectId: ProjectId,
    scope: GroupAttributionScope,
    manual: ReadonlyArray<ThreadGroupManualResource>,
  ) {
    const [servers, containers] = yield* Effect.all(
      [scanServers(scope), scanContainers(scope.worktreeRoot)],
      { concurrency: "unbounded" },
    );
    const named = yield* describeTerminals(projectId, servers);
    return mergeGroupResources({ servers, containers, manual, ...named });
  });

  const scanThread = Effect.fn("GroupResourceScanner.scanThread")(function* (threadId: ThreadId) {
    const thread = yield* threads.getThreadShell(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadGroupService.ThreadGroupOperationError({
            operation: "read-threads",
            threadId,
            cause,
          }),
      ),
    );
    if (thread === null || thread.deletedAt != null) {
      return yield* new ThreadGroupService.ThreadGroupThreadNotFoundError({ threadId });
    }
    return yield* scanScope(
      thread.projectId,
      {
        memberThreadIds: new Set([threadId]),
        worktreeRoot: yield* resolveWorktree(thread.worktreePath),
      },
      [],
    );
  });

  const scanGroup = Effect.fn("GroupResourceScanner.scanGroup")(function* (groupId: ThreadGroupId) {
    const shell = yield* groups.getShell(groupId).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadGroupService.ThreadGroupOperationError({
            operation: "read-group",
            groupId,
            cause,
          }),
      ),
    );
    if (Option.isNone(shell)) {
      return yield* new ThreadGroupService.ThreadGroupNotFoundError({ groupId });
    }
    const group = shell.value;
    // Archived chats have no live terminals; their servers still match by cwd.
    const projectThreads = yield* threads
      .listProjectThreads({ projectId: group.projectId, includeSubagents: false })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadGroupService.ThreadGroupOperationError({
              operation: "read-threads",
              groupId,
              cause,
            }),
        ),
      );
    const scope: GroupAttributionScope = {
      memberThreadIds: new Set(
        projectThreads.flatMap((thread) => (thread.groupId === groupId ? [thread.id] : [])),
      ),
      worktreeRoot: yield* resolveWorktree(group.worktreePath),
    };
    return yield* scanScope(group.projectId, scope, group.manualResources);
  });

  const scan = Effect.fn("GroupResourceScanner.scan")(function* (target: GroupResourceTarget) {
    return "groupId" in target
      ? yield* scanGroup(target.groupId)
      : yield* scanThread(target.threadId);
  });

  const feed = yield* makeResourceFeed({
    scan: (target) =>
      scan(target).pipe(
        Effect.catchTags({
          ThreadGroupNotFoundError: () => Effect.succeed([]),
          ThreadGroupThreadNotFoundError: () => Effect.succeed([]),
          ThreadGroupOperationError: (error) =>
            Effect.logDebug("group resource scan failed; keeping the last list", {
              cause: error,
              target,
            }).pipe(Effect.as(null)),
        }),
      ),
    // Shares the preview scanner's retain, so its poll keeps the listener rows
    // fresh, and rescans as soon as it sees a server come or go.
    watch: (wake) =>
      Effect.gen(function* () {
        yield* ports.retain;
        yield* ports.subscribe({ configuredUrls: [], initialSnapshot: [] }, () => wake);
      }),
    interval: RESOURCE_RESCAN_INTERVAL,
  });

  return GroupResourceScanner.of({ scan, changes: feed.changes });
});

export const layer = Layer.effect(GroupResourceScanner, make);
