/**
 * The running resources of a chat group, computed live on each scan.
 *
 * A local server belongs to the group when the T3 terminal that started it
 * belongs to a member chat, or when its process's working directory is inside
 * the group's worktree. A container belongs to it when its compose
 * `working_dir` label is inside the worktree. A group without a worktree gets
 * terminal attribution only. Registered resources come from the group shell.
 * Scanner failures degrade to fewer results, never an error.
 *
 * `changes` streams a group's resources while someone watches it. Every
 * watcher of one group shares a single scan loop, so open panels never
 * multiply `lsof` or `docker` runs.
 */
import type {
  DiscoveredLocalServer,
  ThreadGroupId,
  ThreadGroupManualResource,
  ThreadGroupRunningResource,
  ThreadId,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
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
import * as DockerScanner from "./DockerScanner.ts";
import * as ProcessCwd from "./processCwd.ts";

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
    const detail = `:${listener.port}`;
    return [
      {
        id: `server:${listener.port}`,
        kind: "server",
        name: listener.processName ?? "server",
        detail,
        url: `http://${listener.host}:${listener.port}`,
        source,
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
          },
        ];
      });

/** The loopback port a registered URL points at, or null when it points elsewhere. */
const loopbackPort = (raw: string): number | null => {
  try {
    const url = new URL(raw);
    if (!isLoopbackHost(url.hostname) && url.hostname !== "0.0.0.0") return null;
    if (url.port.length > 0) return Number.parseInt(url.port, 10);
    return url.protocol === "http:" ? 80 : url.protocol === "https:" ? 443 : null;
  } catch {
    return null;
  }
};

/**
 * Servers, then containers, then registered resources. A registered resource
 * whose URL is the local port of one of the group's scanned servers is
 * dropped, so the same thing never shows twice.
 */
export const mergeGroupResources = (input: {
  readonly servers: ReadonlyArray<ThreadGroupRunningResource>;
  readonly containers: ReadonlyArray<ThreadGroupRunningResource>;
  readonly manual: ReadonlyArray<ThreadGroupManualResource>;
}): ReadonlyArray<ThreadGroupRunningResource> => {
  const serverPorts = new Set(
    input.servers.flatMap((server) => {
      const port = server.url === null ? null : loopbackPort(server.url);
      return port === null ? [] : [port];
    }),
  );
  return [
    ...input.servers,
    ...input.containers,
    ...input.manual.flatMap((resource): ReadonlyArray<ThreadGroupRunningResource> => {
      const port = resource.url === null ? null : loopbackPort(resource.url);
      if (port !== null && serverPorts.has(port)) return [];
      return [
        {
          id: `manual:${resource.id}`,
          kind: "manual",
          name: resource.name,
          detail: resource.url ?? "registered",
          url: resource.url,
          source: "registered",
        },
      ];
    }),
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
 * One scan loop per watched group, shared by all of its watchers and stopped
 * when the last one leaves. The loop scans, then waits for `interval` or a
 * wake from `watch`, whichever comes first. A watcher sees the current list,
 * then each changed list. A scan that returns null or dies keeps the previous list,
 * or yields an empty one when there is none yet.
 */
export const makeResourceFeed = Effect.fn("GroupResourceScanner.makeResourceFeed")(
  function* (options: {
    readonly scan: (
      groupId: ThreadGroupId,
    ) => Effect.Effect<ReadonlyArray<ThreadGroupRunningResource> | null>;
    /** Held while a group is watched; runs `wake` to rescan before the next tick. */
    readonly watch: (wake: Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>;
    readonly interval: Duration.Input;
  }) {
    const feeds = yield* RcMap.make({
      lookup: (groupId: ThreadGroupId) =>
        Effect.gen(function* () {
          const latest =
            yield* SubscriptionRef.make<ReadonlyArray<ThreadGroupRunningResource> | null>(null);
          const wake = yield* Queue.sliding<void>(1);
          const rescan = Effect.gen(function* () {
            // A defect must not end the loop every watcher of this group shares.
            const next = yield* options.scan(groupId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("group resource scan died; keeping the last list", {
                  groupId,
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
    const changes = (groupId: ThreadGroupId) =>
      Stream.unwrap(
        RcMap.get(feeds, groupId).pipe(
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
  | ThreadGroupService.ThreadGroupOperationError;

export class GroupResourceScanner extends Context.Service<
  GroupResourceScanner,
  {
    /** The group's running resources right now. */
    readonly scan: (
      groupId: ThreadGroupId,
    ) => Effect.Effect<ReadonlyArray<ThreadGroupRunningResource>, GroupResourceScanError>;
    /**
     * The group's resources now, then each time they change, rescanning every
     * few seconds and whenever the preview scanner sees new servers. A deleted
     * group streams an empty list; a failed scan keeps the last list.
     */
    readonly changes: (
      groupId: ThreadGroupId,
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

  const scan = Effect.fn("GroupResourceScanner.scan")(function* (groupId: ThreadGroupId) {
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
      worktreeRoot:
        group.worktreePath === null
          ? null
          : yield* ProcessCwd.resolveRealPath(fileSystem, group.worktreePath),
    };
    const [servers, containers] = yield* Effect.all(
      [scanServers(scope), scanContainers(scope.worktreeRoot)],
      { concurrency: "unbounded" },
    );
    return mergeGroupResources({
      servers,
      containers,
      manual: group.manualResources,
    });
  });

  const feed = yield* makeResourceFeed({
    scan: (groupId) =>
      scan(groupId).pipe(
        Effect.catchTags({
          ThreadGroupNotFoundError: () => Effect.succeed([]),
          ThreadGroupOperationError: (error) =>
            Effect.logDebug("group resource scan failed; keeping the last list", {
              cause: error,
              groupId,
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
