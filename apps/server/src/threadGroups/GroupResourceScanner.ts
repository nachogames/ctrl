/**
 * The running resources of a chat group, computed live on each scan.
 *
 * A local server belongs to the group when the T3 terminal that started it
 * belongs to a member chat, or when its process's working directory is inside
 * the group's worktree. A container belongs to it when its compose
 * `working_dir` label is inside the worktree. A group without a worktree gets
 * terminal attribution only. Registered resources come from the group shell.
 * Scanner failures degrade to fewer results, never an error.
 */
import type {
  DiscoveredLocalServer,
  ThreadGroupId,
  ThreadGroupManualResource,
  ThreadGroupRunningResource,
  ThreadId,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

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

/** Listeners whose working directory decides attribution. */
export const listenersNeedingCwd = (
  listeners: ReadonlyArray<DiscoveredLocalServer>,
  scope: GroupAttributionScope,
): ReadonlyArray<number> =>
  scope.worktreeRoot === null
    ? []
    : listeners.flatMap((listener) =>
        listener.pid === null || ownedByMember(listener, scope) ? [] : [listener.pid],
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
        name: `${listener.processName ?? "server"} ${detail}`,
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
    const pids = listenersNeedingCwd(listeners, scope);
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

  return GroupResourceScanner.of({ scan });
});

export const layer = Layer.effect(GroupResourceScanner, make);
