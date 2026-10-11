/**
 * The running resources of a chat group, computed live on each scan.
 *
 * A local server belongs to the group when the T3 terminal that started it
 * belongs to a member chat, or when its process's working directory is inside
 * the group's worktree. A group without a worktree gets terminal attribution
 * only. Scanner failures degrade to fewer results, never an error.
 */
import type {
  DiscoveredLocalServer,
  ThreadGroupId,
  ThreadGroupRunningResource,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadGroupService from "../orchestration-v2/ThreadGroupService.ts";
import * as ThreadGroupStore from "../orchestration-v2/ThreadGroupStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PortScanner from "../preview/PortScanner.ts";
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
  const fileSystem = yield* FileSystem.FileSystem;
  const cwds = yield* ProcessCwd.makeProcessCwdLookup;

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
    const listeners = yield* ports.listListeners;
    const pids = listenersNeedingCwd(listeners, scope);
    const cwdByPid = pids.length === 0 ? new Map<number, string>() : yield* cwds.lookup(pids);
    return attributeServers(listeners, scope, cwdByPid);
  });

  return GroupResourceScanner.of({ scan });
});

export const layer = Layer.effect(GroupResourceScanner, make);
