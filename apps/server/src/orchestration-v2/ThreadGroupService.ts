import {
  CommandId,
  type OrchestrationThreadGroupShell,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadGroupId,
  type ThreadGroupLink,
  type ThreadGroupManualResource,
  type ThreadGroupMutation,
  type ThreadGroupMutationFailureReason,
  type ThreadGroupUpdatePayload,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import type { GroupOrderItem } from "@t3tools/shared/groupOrder";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectStore from "./ProjectStore.ts";
import {
  decodeThreadGroupCommandRejection,
  defaultThreadGroupTitle,
  encodeThreadGroupCommandRejection,
  planThreadGroupCommand,
  type ThreadGroupCommand,
} from "./ThreadGroupCommands.ts";
import { planGroupInsertAbove, planGroupJoin } from "./threadGroupOrder.ts";
import * as ThreadGroupStore from "./ThreadGroupStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export class ThreadGroupNotFoundError extends Schema.TaggedError<ThreadGroupNotFoundError>()(
  "ThreadGroupNotFoundError",
  { groupId: ThreadGroupId },
) {
  override get message(): string {
    return `Thread group ${this.groupId} was not found.`;
  }
}

export class ThreadGroupThreadNotFoundError extends Schema.TaggedError<ThreadGroupThreadNotFoundError>()(
  "ThreadGroupThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class ThreadGroupProjectMismatchError extends Schema.TaggedError<ThreadGroupProjectMismatchError>()(
  "ThreadGroupProjectMismatchError",
  { threadId: ThreadId, threadProjectId: ProjectId, groupProjectId: ProjectId },
) {
  override get message(): string {
    return `Thread ${this.threadId} is in project ${this.threadProjectId}, not the group's project ${this.groupProjectId}.`;
  }
}

export class ThreadGroupSubagentError extends Schema.TaggedError<ThreadGroupSubagentError>()(
  "ThreadGroupSubagentError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} is a subagent; subagents belong to their parent thread, not to a group.`;
  }
}

/** The UI turns this into a confirm that retries with `adoptGroupWorkspace`. */
export class ThreadGroupWorkspaceMismatchError extends Schema.TaggedError<ThreadGroupWorkspaceMismatchError>()(
  "ThreadGroupWorkspaceMismatchError",
  { threadId: ThreadId, groupId: ThreadGroupId },
) {
  override get message(): string {
    return `Thread ${this.threadId} works in a different workspace than group ${this.groupId}; move it into the group's workspace to join.`;
  }
}

export class ThreadGroupThreadBusyError extends Schema.TaggedError<ThreadGroupThreadBusyError>()(
  "ThreadGroupThreadBusyError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} is running. Stop the chat first, then move it into the group's workspace.`;
  }
}

export class ThreadGroupWorkspaceDirtyError extends Schema.TaggedError<ThreadGroupWorkspaceDirtyError>()(
  "ThreadGroupWorkspaceDirtyError",
  { threadId: ThreadId, worktreePath: Schema.String },
) {
  override get message(): string {
    return `“${this.worktreePath}” has uncommitted changes. Commit or stash them before moving this chat to the group's workspace.`;
  }
}

export class ThreadGroupWorktreeMissingError extends Schema.TaggedError<ThreadGroupWorktreeMissingError>()(
  "ThreadGroupWorktreeMissingError",
  { groupId: ThreadGroupId, worktreePath: Schema.String },
) {
  override get message(): string {
    return `The group's worktree ${this.worktreePath} no longer exists. Recreate it first.`;
  }
}

export class ThreadGroupOperationError extends Schema.TaggedError<ThreadGroupOperationError>()(
  "ThreadGroupOperationError",
  {
    operation: Schema.Literals([
      "read-group",
      "read-threads",
      "commit-group-command",
      "update-thread",
      "recreate-worktree",
      "read-worktree-status",
    ]),
    groupId: Schema.optional(ThreadGroupId),
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread group operation '${this.operation}' failed.`;
  }
}

export type ThreadGroupServiceError =
  | ThreadGroupNotFoundError
  | ThreadGroupThreadNotFoundError
  | ThreadGroupProjectMismatchError
  | ThreadGroupSubagentError
  | ThreadGroupWorkspaceMismatchError
  | ThreadGroupThreadBusyError
  | ThreadGroupWorkspaceDirtyError
  | ThreadGroupWorktreeMissingError
  | ThreadGroupOperationError;

export interface ThreadGroupCreateInput {
  readonly commandId: CommandId;
  readonly groupId: ThreadGroupId;
  readonly projectId: ProjectId;
  /**
   * The first thread supplies the default branch, worktree, pull request and
   * title. With a goal and no title, the title is generated from the goal later.
   */
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly title?: string;
  readonly goal?: string | null;
  /**
   * Explicit grouping may mix workspaces: by default each chat keeps its own.
   * When true, every other chat moves onto the first chat's worktree and branch,
   * with the same checks as `moveThread`.
   */
  readonly adoptGroupWorkspace?: boolean;
}

export interface ThreadGroupUpdateInput {
  readonly commandId: CommandId;
  readonly groupId: ThreadGroupId;
  readonly patch: ThreadGroupUpdatePayload;
}

export interface ThreadGroupDeleteInput {
  readonly commandId: CommandId;
  readonly groupId: ThreadGroupId;
}

export interface ThreadGroupMoveThreadInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  /** Null detaches the thread; it keeps its branch and worktree. */
  readonly groupId: ThreadGroupId | null;
  /** Switch the thread to the group's branch and worktree when its own differ. */
  readonly adoptGroupWorkspace?: boolean;
}

export interface ThreadGroupSetHandoffLinksInput {
  /** Each link commits under an id derived from this one, so a retry replays. */
  readonly commandId: CommandId;
  readonly fromThreadId: ThreadId;
  readonly toThreadId: ThreadId;
}

export class ThreadGroupService extends Context.Service<
  ThreadGroupService,
  {
    readonly create: (
      input: ThreadGroupCreateInput,
    ) => Effect.Effect<OrchestrationThreadGroupShell, ThreadGroupServiceError>;
    readonly update: (
      input: ThreadGroupUpdateInput,
    ) => Effect.Effect<OrchestrationThreadGroupShell, ThreadGroupServiceError>;
    /** Ungroup: members keep their workspace and become ungrouped, then the group is deleted. */
    readonly delete: (
      input: ThreadGroupDeleteInput,
    ) => Effect.Effect<void, ThreadGroupServiceError>;
    /** Returns the target group, or null when detaching. Empties the previous group's last seat. */
    readonly moveThread: (
      input: ThreadGroupMoveThreadInput,
    ) => Effect.Effect<OrchestrationThreadGroupShell | null, ThreadGroupServiceError>;
    /**
     * Recreate the group's worktree at its path on its branch when the
     * directory is gone. A no-op when it exists or the group has no worktree,
     * so a retry needs no command receipt.
     */
    readonly recreateWorktree: (
      groupId: ThreadGroupId,
    ) => Effect.Effect<OrchestrationThreadGroupShell, ThreadGroupServiceError>;
    /** Links a handoff: `handedOffFrom` on the new chat, `handedOffTo` on the source. */
    readonly setHandoffLinks: (
      input: ThreadGroupSetHandoffLinksInput,
    ) => Effect.Effect<void, ThreadGroupOperationError>;
    /**
     * Delete the group when no live thread is left in it, and clear the pin,
     * snooze and settle of a group down to one live chat. With `unarchived`, a
     * chat just came back from the archive: a group it grew from one live chat
     * to two starts Active, dropping state set while it was hidden.
     */
    readonly pruneIfEmpty: (
      groupId: ThreadGroupId,
      options?: { readonly unarchived?: boolean },
    ) => Effect.Effect<void, ThreadGroupServiceError>;
    /** Prune every live group; a restart uses it to catch deletes it missed. */
    readonly pruneEmptyGroups: Effect.Effect<void, ThreadGroupServiceError>;
    /**
     * Run a launch that puts a thread into the group while holding the group's
     * lock, so an ungroup or prune cannot delete the group under it. A reused
     * thread's previous group is pruned afterwards when the launch emptied it.
     * It does not check the group: `launch` does, so a retry can replay.
     * `launch` must not call a locked method of this service for the same group.
     */
    readonly withGroupLaunch: <A, E, R>(
      groupId: ThreadGroupId,
      launch: Effect.Effect<A, E, R>,
      options?: { readonly reusedThreadId?: ThreadId },
    ) => Effect.Effect<A, E | ThreadGroupServiceError, R>;
    /**
     * Read-modify-write of the group's registered resources under its lock,
     * so two concurrent changes cannot lose one. `change` returns the new list,
     * or null to leave it as it is.
     */
    readonly updateManualResources: <E>(
      groupId: ThreadGroupId,
      commandId: CommandId,
      change: (
        current: ReadonlyArray<ThreadGroupManualResource>,
      ) => Effect.Effect<ReadonlyArray<ThreadGroupManualResource> | null, E>,
    ) => Effect.Effect<OrchestrationThreadGroupShell, E | ThreadGroupServiceError>;
    /** Read-modify-write of the group's links under its lock, like `updateManualResources`. */
    readonly updateLinks: <E>(
      groupId: ThreadGroupId,
      commandId: CommandId,
      change: (
        current: ReadonlyArray<ThreadGroupLink>,
      ) => Effect.Effect<ReadonlyArray<ThreadGroupLink> | null, E>,
    ) => Effect.Effect<OrchestrationThreadGroupShell, E | ThreadGroupServiceError>;
  }
>()("t3/orchestration-v2/ThreadGroupService") {}

export const make = Effect.gen(function* () {
  const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const git = yield* GitWorkflow.GitWorkflowService;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  // Best-effort background work (goal titles) ends with the service.
  const backgroundScope = yield* Effect.scope;
  // Commands for one group run in order. Membership changes that must see the
  // group's current members (join, prune, ungroup) hold the same lock.
  const groupLocks = yield* KeyedLock.make<ThreadGroupId>();

  const readGroup = (groupId: ThreadGroupId, options?: { readonly includeDeleted?: boolean }) =>
    groups
      .get(groupId, options)
      .pipe(
        Effect.mapError(
          (cause) => new ThreadGroupOperationError({ operation: "read-group", groupId, cause }),
        ),
      );

  const readShell = Effect.fn("ThreadGroupService.readShell")(function* (groupId: ThreadGroupId) {
    const shell = yield* groups
      .getShell(groupId)
      .pipe(
        Effect.mapError(
          (cause) => new ThreadGroupOperationError({ operation: "read-group", groupId, cause }),
        ),
      );
    if (Option.isNone(shell)) return yield* new ThreadGroupNotFoundError({ groupId });
    return shell.value;
  });

  const readThread = Effect.fn("ThreadGroupService.readThread")(function* (threadId: ThreadId) {
    const shell = yield* threads
      .getThreadShell(threadId)
      .pipe(
        Effect.mapError(
          (cause) => new ThreadGroupOperationError({ operation: "read-threads", threadId, cause }),
        ),
      );
    if (shell === null || shell.deletedAt !== null) {
      return yield* new ThreadGroupThreadNotFoundError({ threadId });
    }
    return shell;
  });

  const readThreadsError = (groupId?: ThreadGroupId) => (cause: unknown) =>
    new ThreadGroupOperationError({
      operation: "read-threads",
      ...(groupId === undefined ? {} : { groupId }),
      cause,
    });

  // Subagents belong to their parent thread, never to a group, so membership,
  // emptiness and ungroup reads skip them.
  const isSubagent = (thread: OrchestrationV2ThreadShell) =>
    thread.lineage.relationshipToParent === "subagent";

  /** Not archived, not deleted, non-subagent threads of the project. */
  const listActive = (projectId: ProjectId, groupId?: ThreadGroupId) =>
    threads
      .listProjectThreads({ projectId, includeSubagents: false })
      .pipe(Effect.mapError(readThreadsError(groupId)));

  /** Archived, not deleted, non-subagent threads of the project. Loads the whole archive, so read it last. */
  const listArchived = (projectId: ProjectId, groupId?: ThreadGroupId) =>
    threads.getShellSnapshot({ location: "archive" }).pipe(
      Effect.map((snapshot) =>
        snapshot.archivedThreads.filter(
          (thread) =>
            thread.projectId === projectId && thread.deletedAt === null && !isSubagent(thread),
        ),
      ),
      Effect.mapError(readThreadsError(groupId)),
    );

  /** The group's live (not archived) members. */
  const liveMembers = (projectId: ProjectId, groupId: ThreadGroupId) =>
    listActive(projectId, groupId).pipe(
      Effect.map((list) => list.filter((thread) => thread.groupId === groupId)),
    );

  /** Every non-deleted thread in the group, archived or not. */
  const members = Effect.fn("ThreadGroupService.members")(function* (
    projectId: ProjectId,
    groupId: ThreadGroupId,
  ) {
    const active = yield* listActive(projectId, groupId);
    const archived = yield* listArchived(projectId, groupId);
    const byId = new Map<ThreadId, OrchestrationV2ThreadShell>();
    for (const thread of [...active, ...archived]) {
      if (thread.groupId === groupId && thread.deletedAt === null && !byId.has(thread.id)) {
        byId.set(thread.id, thread);
      }
    }
    return [...byId.values()];
  });

  // An unreadable path counts as missing: neither a move nor a recreate should
  // trust a workspace it cannot see. (Turn start assumes present instead, so it
  // never recreates over a worktree it merely failed to stat.)
  const pathExists = (path: string) =>
    fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));

  // Same set as the client's threadRuntimeIsActive.
  const isBusy = (thread: OrchestrationV2ThreadShell) =>
    thread.status === "preparing" ||
    thread.status === "queued" ||
    thread.status === "starting" ||
    thread.status === "running" ||
    thread.status === "waiting";

  const toOrderItem = (thread: OrchestrationV2ThreadShell) => ({
    id: thread.id,
    createdAtMs: DateTime.toEpochMillis(thread.createdAt),
    handedOffFrom: thread.handedOffFrom,
    groupOrderKey: thread.groupOrderKey,
  });

  /** Sent with a join; a keyless join needs no field, since changing groups clears the key. */
  const orderKeyField = (groupOrderKey: string | null) =>
    groupOrderKey === null ? {} : { groupOrderKey };

  const setThreadGroup = (
    commandId: CommandId,
    threadId: ThreadId,
    groupId: ThreadGroupId | null,
    groupOrderKey: string | null = null,
  ) =>
    threads
      .dispatch({
        type: "thread.metadata.update",
        commandId,
        threadId,
        groupId,
        ...orderKeyField(groupOrderKey),
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) => new ThreadGroupOperationError({ operation: "update-thread", threadId, cause }),
        ),
      );

  const dispatchThreadUpdate = (
    update: { readonly commandId: CommandId; readonly threadId: ThreadId } & Partial<{
      readonly handedOffFrom: ThreadId;
      readonly handedOffTo: ThreadId;
      readonly groupOrderKey: string;
    }>,
  ) =>
    threads.dispatch({ type: "thread.metadata.update", ...update }).pipe(
      Effect.asVoid,
      Effect.mapError(
        (cause) =>
          new ThreadGroupOperationError({
            operation: "update-thread",
            threadId: update.threadId,
            cause,
          }),
      ),
    );

  /** Re-key a chat already in the group; arranging a group is not activity on the chat. */
  const reorderMember = (commandId: CommandId, threadId: ThreadId, orderKey: string) =>
    threads.dispatch({ type: "thread.group.reorder", commandId, threadId, orderKey }).pipe(
      Effect.asVoid,
      Effect.mapError(
        (cause) => new ThreadGroupOperationError({ operation: "update-thread", threadId, cause }),
      ),
    );

  /**
   * Plan a chat's join so it shows first in the group. Returns the writes that
   * re-key other members bottom-up (run them before the join) and the joiner's
   * own key. Each re-key's command id names its key: a retry after a partial
   * write re-plans from the keys that landed, and must not replay a receipt
   * holding a key from the earlier plan.
   * `seated` is the group's order and is updated, so the next joiner sees it.
   */
  const placeJoiner = (
    commandId: CommandId,
    seated: Array<GroupOrderItem<ThreadId>>,
    joiner: OrchestrationV2ThreadShell,
  ) => {
    const keys = new Map(
      planGroupJoin(seated, toOrderItem(joiner)).map((entry) => [entry.threadId, entry.key]),
    );
    seated.forEach((item, index) => {
      const key = keys.get(item.id);
      if (key !== undefined) seated[index] = { ...item, groupOrderKey: key };
    });
    seated.push({ ...toOrderItem(joiner), groupOrderKey: keys.get(joiner.id) ?? null });
    const others = [...keys].filter(([threadId]) => threadId !== joiner.id);
    return {
      reorder: Effect.forEach(
        others,
        ([threadId, key]) =>
          reorderMember(CommandId.make(`${commandId}:order:${threadId}:${key}`), threadId, key),
        { concurrency: 1, discard: true },
      ),
      key: keys.get(joiner.id) ?? null,
    };
  };

  /**
   * The checks before a chat switches to a group's workspace: it is idle, the
   * group's worktree exists, and its own worktree has no uncommitted work.
   */
  const checkAdoptable = Effect.fn("ThreadGroupService.checkAdoptable")(function* (
    thread: OrchestrationV2ThreadShell,
    groupId: ThreadGroupId,
    worktreePath: string | null,
  ) {
    if (isBusy(thread)) return yield* new ThreadGroupThreadBusyError({ threadId: thread.id });
    if (worktreePath !== null && !(yield* pathExists(worktreePath))) {
      return yield* new ThreadGroupWorktreeMissingError({ groupId, worktreePath });
    }
    // Re-pointing leaves the old worktree behind, so uncommitted work there
    // would drop out of the chat's sight.
    const current = thread.worktreePath;
    if (current !== null && (yield* pathExists(current))) {
      const status = yield* git.localStatus({ cwd: current }).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadGroupOperationError({
              operation: "read-worktree-status",
              threadId: thread.id,
              cause,
            }),
        ),
      );
      if (status.hasWorkingTreeChanges) {
        return yield* new ThreadGroupWorkspaceDirtyError({
          threadId: thread.id,
          worktreePath: current,
        });
      }
    }
  });

  /**
   * Join the group and switch to its workspace in one update, so a failed check
   * or a raced worktree change leaves the chat where it was. Run `checkAdoptable` first.
   */
  const adoptWorkspace = (
    commandId: CommandId,
    thread: OrchestrationV2ThreadShell,
    groupId: ThreadGroupId,
    workspace: { readonly branch: string | null; readonly worktreePath: string | null },
    groupOrderKey: string | null,
  ) =>
    threads
      .dispatch({
        type: "thread.metadata.update",
        commandId,
        threadId: thread.id,
        groupId,
        ...orderKeyField(groupOrderKey),
        branch: workspace.branch,
        worktreePath: workspace.worktreePath,
        expectedWorktreePath: thread.worktreePath,
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new ThreadGroupOperationError({
              operation: "update-thread",
              threadId: thread.id,
              cause,
            }),
        ),
      );

  /** Plan and commit one group command. The caller holds the group's lock. */
  const commitLocked = Effect.fn("ThreadGroupService.commitLocked")(function* (
    command: ThreadGroupCommand,
  ) {
    const { groupId } = command;
    const commitError = (cause: unknown) =>
      new ThreadGroupOperationError({ operation: "commit-group-command", groupId, cause });
    const group = Option.getOrUndefined(yield* readGroup(groupId, { includeDeleted: true }));
    const now = yield* DateTime.now;
    const eventId = yield* idAllocator.allocate
      .event({ commandId: command.commandId })
      .pipe(Effect.mapError(commitError));
    const planned = planThreadGroupCommand({ command, state: { group }, eventId, now });
    let receipt: CommandReceiptStore.ThreadGroupCommandReceiptV2;
    if (Result.isSuccess(planned)) {
      const committed = yield* eventSink
        .commitThreadGroupCommand({
          commandId: command.commandId,
          groupId,
          commandType: command.type,
          acceptedAt: now,
          event: planned.success,
        })
        .pipe(Effect.mapError(commitError));
      receipt = committed.receipt;
    } else {
      receipt = yield* eventSink
        .commitRejectedThreadGroupCommand({
          commandId: command.commandId,
          groupId,
          commandType: command.type,
          rejectedAt: now,
          error: encodeThreadGroupCommandRejection(planned.failure),
        })
        .pipe(Effect.mapError(commitError));
    }
    if (receipt.groupId !== groupId || receipt.commandType !== command.type) {
      return yield* commitError(
        `Command ${command.commandId} was already used by ${receipt.commandType} for ${receipt.groupId}.`,
      );
    }
    // A retried command id re-plans against the state it produced, so its first receipt decides.
    if (receipt.status === "accepted") return;
    const rejection = Option.getOrUndefined(decodeThreadGroupCommandRejection(receipt.error));
    if (rejection?._tag === "ThreadGroupCommandMissingGroupError") {
      return yield* new ThreadGroupNotFoundError({ groupId });
    }
    return yield* commitError(rejection ?? receipt.error ?? "The command was previously rejected.");
  });

  const commit = (command: ThreadGroupCommand) =>
    groupLocks.withLock(command.groupId, commitLocked(command));

  /**
   * Clear a group's pin, snooze and settle. The id is derived from the group's
   * `updatedAt`, so a retry replays and a later change gets a fresh one.
   */
  const clearStateLocked = (
    groupId: ThreadGroupId,
    group: Pick<
      OrchestrationThreadGroupShell,
      "pinnedAt" | "snoozedUntil" | "settledAt" | "updatedAt"
    >,
    reason: "solo" | "active",
  ) =>
    group.pinnedAt === null && group.snoozedUntil === null && group.settledAt === null
      ? Effect.void
      : commitLocked({
          type: "thread-group.meta.update",
          commandId: CommandId.make(`server:thread-group-${reason}:${groupId}:${group.updatedAt}`),
          groupId,
          patch: { pinnedAt: null, snoozedUntil: null, settledAt: null },
        });

  /**
   * A group that grows from one live chat to two starts Active, dropping a
   * state it held while hidden (an agent's pin, or a one-member group from
   * before). The caller holds the lock and passes the live count before the join.
   */
  const startActiveIfGrownLocked = Effect.fn("ThreadGroupService.startActiveIfGrownLocked")(
    function* (groupId: ThreadGroupId, liveBefore: number) {
      if (liveBefore >= 2) return;
      const found = yield* readGroup(groupId);
      if (Option.isNone(found)) return;
      if ((yield* liveMembers(found.value.projectId, groupId)).length < 2) return;
      yield* clearStateLocked(groupId, found.value, "active");
    },
  );

  /**
   * The groups that `movers` leave without a live chat, in the movers' order.
   * The prune after the join deletes them, so their data is carried first.
   */
  const groupsEmptiedBy = Effect.fn("ThreadGroupService.groupsEmptiedBy")(function* (
    movers: ReadonlyArray<OrchestrationV2ThreadShell>,
    destination: ThreadGroupId,
  ) {
    const leaving = new Set(movers.map((mover) => mover.id));
    const previous = new Set(
      movers.flatMap((mover) =>
        mover.groupId == null || mover.groupId === destination ? [] : [mover.groupId],
      ),
    );
    const emptied = yield* Effect.forEach(
      previous,
      (groupId) =>
        Effect.gen(function* () {
          const found = yield* groups
            .getShell(groupId)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ThreadGroupOperationError({ operation: "read-group", groupId, cause }),
              ),
            );
          if (Option.isNone(found)) return [];
          const live = yield* liveMembers(found.value.projectId, groupId);
          return live.every((thread) => leaving.has(thread.id)) ? [found.value] : [];
        }),
      { concurrency: 1 },
    );
    return emptied.flat();
  });

  /** Merge the data of groups a join empties into the destination. The caller holds its lock. */
  const carryLocked = Effect.fn("ThreadGroupService.carryLocked")(function* (
    commandId: CommandId,
    destination: ThreadGroupId,
    sources: ReadonlyArray<OrchestrationThreadGroupShell>,
  ) {
    if (sources.length === 0) return;
    const patch = carriedGroupData(yield* readShell(destination), sources);
    if (patch === null) return;
    yield* commitLocked({
      type: "thread-group.meta.update",
      commandId: CommandId.make(`${commandId}:carry`),
      groupId: destination,
      patch,
    });
  });

  const pruneLocked = Effect.fn("ThreadGroupService.pruneLocked")(function* (
    groupId: ThreadGroupId,
    unarchived = false,
  ) {
    const found = yield* readGroup(groupId);
    if (Option.isNone(found)) return;
    const group = found.value;
    const live = yield* liveMembers(group.projectId, groupId);
    // A group of one is hidden; its state must not come back when it grows.
    if (live.length === 1) return yield* clearStateLocked(groupId, group, "solo");
    // Two live chats right after an unarchive means it grew from a hidden group of one.
    if (unarchived && live.length === 2) {
      return yield* clearStateLocked(groupId, group, "active");
    }
    if (live.length > 0) return;
    // Archived threads keep their group; only deleting or moving them empties it.
    const archived = yield* listArchived(group.projectId, groupId);
    if (archived.some((thread) => thread.groupId === groupId)) return;
    yield* commitLocked({
      type: "thread-group.delete",
      // A group is deleted at most once, so one id per group replays on retry.
      commandId: CommandId.make(`server:thread-group-prune:${groupId}`),
      groupId,
    }).pipe(Effect.catchTags({ ThreadGroupNotFoundError: () => Effect.void }));
  });

  const pruneIfEmpty: ThreadGroupService["Service"]["pruneIfEmpty"] = (groupId, options) =>
    groupLocks.withLock(groupId, pruneLocked(groupId, options?.unarchived === true));

  /**
   * Name a group created for a goal from that goal, with the project's text
   * generation model. Best effort: the title changes only while it is still
   * the chat title the group started with, and a failure keeps that title.
   */
  const titleFromGoal = (input: ThreadGroupCreateInput, fallback: string) =>
    Effect.gen(function* () {
      const goal = input.goal?.trim();
      if (!goal) return;
      const project = yield* projects.get(input.projectId);
      if (Option.isNone(project)) return;
      const group = yield* readGroup(input.groupId);
      if (Option.isNone(group)) return;
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        input.projectId,
      ).settings;
      const generated = yield* textGeneration.generateThreadTitle({
        cwd: group.value.worktreePath ?? project.value.workspaceRoot,
        message: goal,
        modelSelection: settings.textGenerationModelSelection,
      });
      const title = generated.title.trim();
      if (title.length === 0 || title === "New thread" || title === fallback) return;
      yield* groupLocks.withLock(
        input.groupId,
        Effect.gen(function* () {
          const current = yield* readGroup(input.groupId);
          if (Option.isNone(current) || current.value.title !== fallback) return;
          yield* commitLocked({
            type: "thread-group.meta.update",
            commandId: CommandId.make(`${input.commandId}:goal-title`),
            groupId: input.groupId,
            patch: { title },
          });
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("orchestration-v2.thread-group.goal-title-failed", {
              groupId: input.groupId,
              cause,
            }),
      ),
      Effect.withSpan("ThreadGroupService.titleFromGoal"),
    );

  const create: ThreadGroupService["Service"]["create"] = Effect.fn("ThreadGroupService.create")(
    function* (input) {
      const members = yield* Effect.forEach([...new Set(input.threadIds)], readThread, {
        concurrency: 4,
      });
      const first = members[0];
      if (first === undefined) {
        return yield* new ThreadGroupOperationError({
          operation: "commit-group-command",
          groupId: input.groupId,
          cause: "A thread group needs at least one thread.",
        });
      }
      for (const member of members) {
        if (isSubagent(member)) return yield* new ThreadGroupSubagentError({ threadId: member.id });
        if (member.projectId !== input.projectId) {
          return yield* new ThreadGroupProjectMismatchError({
            threadId: member.id,
            threadProjectId: member.projectId,
            groupProjectId: input.projectId,
          });
        }
      }
      const workspace = { branch: first.branch, worktreePath: first.worktreePath };
      const adopters =
        input.adoptGroupWorkspace === true
          ? members.filter(
              (member) =>
                member.groupId !== input.groupId && member.worktreePath !== workspace.worktreePath,
            )
          : [];
      // Check every chat before the group exists, so one busy or dirty chat fails the whole create.
      yield* Effect.forEach(
        adopters,
        (member) => checkAdoptable(member, input.groupId, workspace.worktreePath),
        { concurrency: 1, discard: true },
      );
      const adopting = new Set(adopters.map((member) => member.id));
      const pullRequest = resolveThreadCurrentPullRequestLink(first.pullRequests ?? []);
      const title =
        input.title ?? defaultThreadGroupTitle({ branch: first.branch, fallback: first.title });
      const previousGroups = new Set<ThreadGroupId>();
      const emptied = yield* groupsEmptiedBy(members, input.groupId);
      // Commit and join under one lock, so a prune cannot delete the group between them.
      yield* groupLocks.withLock(
        input.groupId,
        Effect.gen(function* () {
          yield* commitLocked({
            type: "thread-group.create",
            commandId: input.commandId,
            groupId: input.groupId,
            projectId: input.projectId,
            title,
            goal: input.goal ?? null,
            ...workspace,
            pullRequest,
          });
          // A retried create replays as accepted even after the group was pruned or deleted.
          const group = yield* readGroup(input.groupId);
          if (Option.isNone(group) || group.value.deletedAt !== null) {
            return yield* new ThreadGroupNotFoundError({ groupId: input.groupId });
          }
          // Chats leaving groups of one bring their goal, tickets and resources.
          yield* carryLocked(input.commandId, input.groupId, emptied);
          const seated = (yield* liveMembers(input.projectId, input.groupId)).map(toOrderItem);
          const liveBefore = seated.length;
          // The chats of a new group keep their natural order; only chats
          // joining members already seated (a retried create) are placed on top.
          const placing = seated.length > 0;
          yield* Effect.forEach(
            members,
            (member) => {
              if (member.groupId === input.groupId) return Effect.void;
              if (member.groupId != null) previousGroups.add(member.groupId);
              const joinCommandId = CommandId.make(`${input.commandId}:join:${member.id}`);
              const { reorder, key } = placing
                ? placeJoiner(joinCommandId, seated, member)
                : { reorder: Effect.void, key: null };
              return reorder.pipe(
                Effect.andThen(
                  adopting.has(member.id)
                    ? adoptWorkspace(joinCommandId, member, input.groupId, workspace, key)
                    : setThreadGroup(joinCommandId, member.id, input.groupId, key),
                ),
              );
            },
            { concurrency: 1, discard: true },
          );
          yield* startActiveIfGrownLocked(input.groupId, liveBefore);
        }),
      );
      yield* Effect.forEach(previousGroups, (previous) => pruneIfEmpty(previous), {
        concurrency: 1,
        discard: true,
      });
      if (input.title === undefined && input.goal != null) {
        yield* titleFromGoal(input, title).pipe(Effect.forkIn(backgroundScope));
      }
      return yield* readShell(input.groupId);
    },
  );

  const update: ThreadGroupService["Service"]["update"] = Effect.fn("ThreadGroupService.update")(
    function* (input) {
      yield* commit({
        type: "thread-group.meta.update",
        commandId: input.commandId,
        groupId: input.groupId,
        patch: input.patch,
      });
      return yield* readShell(input.groupId);
    },
  );

  /** Change one list field of a group under its lock; `change` returns null to leave it. */
  const updateListLocked = <T, E>(
    groupId: ThreadGroupId,
    commandId: CommandId,
    read: (group: OrchestrationThreadGroupShell) => ReadonlyArray<T>,
    toPatch: (next: ReadonlyArray<T>) => ThreadGroupUpdatePayload,
    change: (current: ReadonlyArray<T>) => Effect.Effect<ReadonlyArray<T> | null, E>,
  ) =>
    Effect.gen(function* () {
      yield* groupLocks.withLock(
        groupId,
        Effect.gen(function* () {
          const next = yield* change(read(yield* readShell(groupId)));
          if (next === null) return;
          yield* commitLocked({
            type: "thread-group.meta.update",
            commandId,
            groupId,
            patch: toPatch(next),
          });
        }),
      );
      return yield* readShell(groupId);
    });

  const updateManualResources: ThreadGroupService["Service"]["updateManualResources"] = (
    groupId,
    commandId,
    change,
  ) =>
    updateListLocked(
      groupId,
      commandId,
      (group) => group.manualResources,
      (manualResources) => ({ manualResources }),
      change,
    ).pipe(Effect.withSpan("ThreadGroupService.updateManualResources"));

  const updateLinks: ThreadGroupService["Service"]["updateLinks"] = (groupId, commandId, change) =>
    updateListLocked(
      groupId,
      commandId,
      (group) => group.links,
      (links) => ({ links }),
      change,
    ).pipe(Effect.withSpan("ThreadGroupService.updateLinks"));

  const deleteGroup: ThreadGroupService["Service"]["delete"] = Effect.fn(
    "ThreadGroupService.delete",
  )(function* (input) {
    yield* groupLocks.withLock(
      input.groupId,
      Effect.gen(function* () {
        const group = yield* readGroup(input.groupId, { includeDeleted: true });
        if (Option.isNone(group)) {
          return yield* new ThreadGroupNotFoundError({ groupId: input.groupId });
        }
        if (group.value.deletedAt === null) {
          // Detach members before the group goes, so a failed ungroup can be retried.
          yield* Effect.forEach(
            yield* members(group.value.projectId, input.groupId),
            (member) =>
              setThreadGroup(
                CommandId.make(`${input.commandId}:leave:${member.id}`),
                member.id,
                null,
              ),
            { concurrency: 1, discard: true },
          );
        }
        yield* commitLocked({
          type: "thread-group.delete",
          commandId: input.commandId,
          groupId: input.groupId,
        });
      }),
    );
  });

  const moveThread: ThreadGroupService["Service"]["moveThread"] = Effect.fn(
    "ThreadGroupService.moveThread",
  )(function* (input) {
    const thread = yield* readThread(input.threadId);
    if (isSubagent(thread)) return yield* new ThreadGroupSubagentError({ threadId: thread.id });
    const previous = thread.groupId ?? null;
    if (previous === input.groupId) {
      return input.groupId === null ? null : yield* readShell(input.groupId);
    }
    const setCommandId = CommandId.make(`${input.commandId}:set:${input.threadId}`);
    const target = input.groupId;
    if (target === null) {
      yield* setThreadGroup(setCommandId, thread.id, null);
    } else {
      yield* groupLocks.withLock(
        target,
        Effect.gen(function* () {
          const group = yield* readGroup(target);
          if (Option.isNone(group)) return yield* new ThreadGroupNotFoundError({ groupId: target });
          if (group.value.projectId !== thread.projectId) {
            return yield* new ThreadGroupProjectMismatchError({
              threadId: thread.id,
              threadProjectId: thread.projectId,
              groupProjectId: group.value.projectId,
            });
          }
          // The workspace is the worktree path; a branch label alone does not
          // move the chat anywhere.
          const { branch, worktreePath } = group.value;
          const adopting = thread.worktreePath !== worktreePath;
          if (adopting) {
            if (input.adoptGroupWorkspace !== true) {
              return yield* new ThreadGroupWorkspaceMismatchError({
                threadId: thread.id,
                groupId: target,
              });
            }
            yield* checkAdoptable(thread, target, worktreePath);
          }
          // A chat leaving its group of one brings that group's goal, tickets and resources.
          yield* carryLocked(setCommandId, target, yield* groupsEmptiedBy([thread], target));
          const seated = (yield* liveMembers(thread.projectId, target)).map(toOrderItem);
          const liveBefore = seated.length;
          const { reorder, key } = placeJoiner(setCommandId, seated, thread);
          yield* reorder;
          yield* adopting
            ? adoptWorkspace(setCommandId, thread, target, { branch, worktreePath }, key)
            : setThreadGroup(setCommandId, thread.id, target, key);
          yield* startActiveIfGrownLocked(target, liveBefore);
        }),
      );
    }
    if (previous !== null) yield* pruneIfEmpty(previous);
    return target === null ? null : yield* readShell(target);
  });

  const pruneEmptyGroups: ThreadGroupService["Service"]["pruneEmptyGroups"] = Effect.gen(
    function* () {
      const live = yield* groups
        .list()
        .pipe(
          Effect.mapError(
            (cause) => new ThreadGroupOperationError({ operation: "read-group", cause }),
          ),
        );
      const projectIds = [...new Set(live.map((group) => group.projectId))];
      yield* Effect.forEach(
        projectIds,
        (projectId) =>
          Effect.gen(function* () {
            const usedBy = (list: ReadonlyArray<OrchestrationV2ThreadShell>) =>
              new Set(list.flatMap((thread) => (thread.groupId == null ? [] : [thread.groupId])));
            const activeUsed = usedBy(yield* listActive(projectId));
            let candidates = live.filter(
              (group) => group.projectId === projectId && !activeUsed.has(group.groupId),
            );
            if (candidates.length === 0) return;
            const archivedUsed = usedBy(yield* listArchived(projectId));
            candidates = candidates.filter((group) => !archivedUsed.has(group.groupId));
            // pruneIfEmpty re-reads membership under the group's lock before deleting.
            yield* Effect.forEach(candidates, (group) => pruneIfEmpty(group.groupId), {
              concurrency: 1,
              discard: true,
            });
          }),
        { concurrency: 1, discard: true },
      );
    },
  ).pipe(Effect.withSpan("ThreadGroupService.pruneEmptyGroups"));

  const recreateWorktree: ThreadGroupService["Service"]["recreateWorktree"] = Effect.fn(
    "ThreadGroupService.recreateWorktree",
  )(function* (groupId) {
    // Under the group's lock, so two clicks cannot both run `git worktree add`.
    yield* groupLocks.withLock(
      groupId,
      Effect.gen(function* () {
        const group = yield* readShell(groupId);
        const { branch, worktreePath } = group;
        if (worktreePath === null || (yield* pathExists(worktreePath))) return;
        const recreateError = (cause: unknown) =>
          new ThreadGroupOperationError({ operation: "recreate-worktree", groupId, cause });
        if (branch === null) {
          return yield* recreateError("The group has no branch to recreate its worktree on.");
        }
        const project = yield* projects.get(group.projectId).pipe(Effect.mapError(recreateError));
        if (Option.isNone(project)) {
          return yield* recreateError(`Project ${group.projectId} was not found.`);
        }
        const cwd = project.value.workspaceRoot;
        // A folder deleted outside T3 stays registered in git, and
        // `git worktree add` refuses a registered path until it is pruned.
        yield* git
          .pruneWorktrees({ cwd })
          .pipe(
            Effect.andThen(git.createWorktree({ cwd, refName: branch, path: worktreePath })),
            Effect.mapError(recreateError),
          );
      }),
    );
    return yield* readShell(groupId);
  });

  const setHandoffLinks: ThreadGroupService["Service"]["setHandoffLinks"] = Effect.fn(
    "ThreadGroupService.setHandoffLinks",
  )(function* (input) {
    yield* Effect.forEach(
      [
        {
          commandId: CommandId.make(`${input.commandId}:link-from`),
          threadId: input.toThreadId,
          handedOffFrom: input.fromThreadId,
        },
        {
          commandId: CommandId.make(`${input.commandId}:link-to`),
          threadId: input.fromThreadId,
          handedOffTo: input.toThreadId,
        },
      ],
      dispatchThreadUpdate,
      { concurrency: 1, discard: true },
    );
    // In an ordered group the new chat needs a key to sit directly above its source.
    const launched = yield* threads
      .getThreadShell(input.toThreadId)
      .pipe(Effect.mapError(readThreadsError()));
    const groupId = launched?.groupId;
    if (launched == null || groupId == null) return;
    yield* groupLocks.withLock(
      groupId,
      Effect.gen(function* () {
        const members = yield* liveMembers(launched.projectId, groupId);
        const plan = planGroupInsertAbove(
          members.map(toOrderItem),
          input.fromThreadId,
          input.toThreadId,
        );
        // The plan runs bottom-up and ends with the new chat's key. A retry after
        // a partial write re-plans from what landed; ids name the key so it never
        // replays a receipt from the earlier plan.
        yield* Effect.forEach(
          plan,
          (entry) => {
            const commandId = CommandId.make(
              `${input.commandId}:order:${entry.threadId}:${entry.key}`,
            );
            return entry.threadId === input.toThreadId
              ? dispatchThreadUpdate({
                  commandId,
                  threadId: entry.threadId,
                  groupOrderKey: entry.key,
                })
              : reorderMember(commandId, entry.threadId, entry.key);
          },
          { concurrency: 1, discard: true },
        );
      }),
    );
  });

  const withGroupLaunch: ThreadGroupService["Service"]["withGroupLaunch"] = (
    groupId,
    launch,
    options,
  ) =>
    Effect.gen(function* () {
      const reusedThreadId = options?.reusedThreadId;
      // A missing reused thread is the launch's error to report, not the group's.
      const previous =
        reusedThreadId === undefined
          ? null
          : yield* readThread(reusedThreadId).pipe(
              Effect.map((thread) => thread.groupId ?? null),
              Effect.catchTags({ ThreadGroupThreadNotFoundError: () => Effect.succeed(null) }),
            );
      // The launch checks the group itself, after its receipt, so a retried
      // launch replays even when the group has gone since.
      const launchLocked = groupLocks.withLock(
        groupId,
        Effect.gen(function* () {
          const found = yield* readGroup(groupId);
          const liveBefore = Option.isNone(found)
            ? 0
            : (yield* liveMembers(found.value.projectId, groupId)).length;
          const launched = yield* launch;
          yield* startActiveIfGrownLocked(groupId, liveBefore);
          return launched;
        }),
      );
      if (previous === null || previous === groupId) return yield* launchLocked;
      // A reuse launch can move the thread and then fail, so prune on every
      // exit. A prune failure must not fail a launch that already committed;
      // the restart sweep catches what it misses.
      return yield* launchLocked.pipe(
        Effect.ensuring(
          pruneIfEmpty(previous).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.thread-group.launch-prune-failed", {
                groupId: previous,
                cause,
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.withSpan("ThreadGroupService.withGroupLaunch"));

  return ThreadGroupService.of({
    create,
    update,
    delete: deleteGroup,
    moveThread,
    recreateWorktree,
    setHandoffLinks,
    pruneIfEmpty,
    pruneEmptyGroups,
    withGroupLaunch,
    updateManualResources,
    updateLinks,
  });
});

/**
 * What a group takes from the groups its joiners leave empty: the first goal
 * when it has none, and the tickets and resources it lacks. Null when nothing changes.
 */
function carriedGroupData(
  destination: Pick<OrchestrationThreadGroupShell, "goal" | "links" | "manualResources">,
  sources: ReadonlyArray<Pick<OrchestrationThreadGroupShell, "goal" | "links" | "manualResources">>,
): ThreadGroupUpdatePayload | null {
  const goal = destination.goal ?? sources.find((source) => source.goal !== null)?.goal ?? null;
  const links = [...destination.links];
  const linked = new Set(links.flatMap((entry) => [entry.id, entry.url]));
  for (const entry of sources.flatMap((source) => source.links)) {
    if (linked.has(entry.id) || linked.has(entry.url)) continue;
    linked.add(entry.id).add(entry.url);
    links.push(entry);
  }
  const manualResources = [...destination.manualResources];
  const registered = new Set(
    manualResources.flatMap((entry) => (entry.url === null ? [entry.id] : [entry.id, entry.url])),
  );
  for (const entry of sources.flatMap((source) => source.manualResources)) {
    if (registered.has(entry.id) || (entry.url !== null && registered.has(entry.url))) continue;
    registered.add(entry.id);
    if (entry.url !== null) registered.add(entry.url);
    manualResources.push(entry);
  }
  const patch: ThreadGroupUpdatePayload = {
    ...(goal === destination.goal ? {} : { goal }),
    ...(links.length === destination.links.length ? {} : { links }),
    ...(manualResources.length === destination.manualResources.length ? {} : { manualResources }),
  };
  return Object.keys(patch).length === 0 ? null : patch;
}

export const layer = Layer.effect(ThreadGroupService, make);

/** Runs one client mutation. Delete and detaching moves report no group. */
export const mutateThreadGroup = Effect.fn("mutateThreadGroup")(function* (
  service: ThreadGroupService["Service"],
  mutation: ThreadGroupMutation,
) {
  switch (mutation.type) {
    case "thread-group.create":
      return {
        group: yield* service.create({
          commandId: mutation.commandId,
          groupId: mutation.groupId,
          projectId: mutation.projectId,
          threadIds: mutation.threadIds,
          ...(mutation.title === undefined ? {} : { title: mutation.title }),
          ...(mutation.goal === undefined ? {} : { goal: mutation.goal }),
        }),
      };
    case "thread-group.update":
      return {
        group: yield* service.update({
          commandId: mutation.commandId,
          groupId: mutation.groupId,
          patch: mutation.patch,
        }),
      };
    case "thread-group.delete":
      yield* service.delete({ commandId: mutation.commandId, groupId: mutation.groupId });
      return { group: null };
    case "thread-group.move-thread":
      return {
        group: yield* service.moveThread({
          commandId: mutation.commandId,
          threadId: mutation.threadId,
          groupId: mutation.groupId,
          ...(mutation.adoptGroupWorkspace === undefined
            ? {}
            : { adoptGroupWorkspace: mutation.adoptGroupWorkspace }),
        }),
      };
    case "thread-group.remove-resource": {
      const { resourceId } = mutation;
      return {
        group: yield* service.updateManualResources(
          mutation.groupId,
          mutation.commandId,
          (current) =>
            Effect.succeed(
              current.some((resource) => resource.id === resourceId)
                ? current.filter((resource) => resource.id !== resourceId)
                : null,
            ),
        ),
      };
    }
    case "thread-group.recreate-worktree":
      return { group: yield* service.recreateWorktree(mutation.groupId) };
  }
});

const mutationVerb = (type: ThreadGroupMutation["type"]): string => {
  switch (type) {
    case "thread-group.create":
      return "create the thread group";
    case "thread-group.update":
      return "update the thread group";
    case "thread-group.delete":
      return "ungroup the thread group";
    case "thread-group.move-thread":
      return "move the thread";
    case "thread-group.remove-resource":
      return "remove the resource";
    case "thread-group.recreate-worktree":
      return "recreate the group's worktree";
  }
};

const causeMessage = (cause: unknown): string | undefined =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : undefined;

/**
 * The message a client sees when a group mutation fails. Errors a user can act
 * on pass their own message; operation failures name what was being attempted.
 */
export function threadGroupMutationErrorMessage(
  mutation: Pick<ThreadGroupMutation, "type">,
  error: ThreadGroupServiceError,
): string {
  switch (error._tag) {
    case "ThreadGroupNotFoundError":
    case "ThreadGroupThreadNotFoundError":
    case "ThreadGroupProjectMismatchError":
    case "ThreadGroupSubagentError":
    case "ThreadGroupWorkspaceMismatchError":
    case "ThreadGroupThreadBusyError":
    case "ThreadGroupWorkspaceDirtyError":
    case "ThreadGroupWorktreeMissingError":
      return error.message;
    case "ThreadGroupOperationError": {
      const detail = causeMessage(error.cause);
      const verb = mutationVerb(mutation.type);
      return detail === undefined || detail === ""
        ? `Failed to ${verb}.`
        : `Failed to ${verb}: ${detail}`;
    }
  }
}

/** The machine-readable reason a client sees next to the message; none for operation failures. */
export function threadGroupMutationFailureReason(
  error: ThreadGroupServiceError,
): ThreadGroupMutationFailureReason | undefined {
  switch (error._tag) {
    case "ThreadGroupNotFoundError":
      return "group-not-found";
    case "ThreadGroupThreadNotFoundError":
      return "thread-not-found";
    case "ThreadGroupProjectMismatchError":
      return "project-mismatch";
    case "ThreadGroupSubagentError":
      return "subagent";
    case "ThreadGroupWorkspaceMismatchError":
      return "workspace-mismatch";
    case "ThreadGroupThreadBusyError":
      return "thread-busy";
    case "ThreadGroupWorkspaceDirtyError":
      return "workspace-dirty";
    case "ThreadGroupWorktreeMissingError":
      return "worktree-missing";
    case "ThreadGroupOperationError":
      return undefined;
  }
}

/**
 * Group membership and handoff links change only through ThreadGroupService,
 * which checks the group and its project. Client dispatches cannot set them.
 */
export function clientCommandChangesGroupMembership(command: OrchestrationV2Command): boolean {
  switch (command.type) {
    case "thread.create":
      return command.groupId != null;
    case "thread.metadata.update":
      return (
        command.groupId !== undefined ||
        command.groupOrderKey !== undefined ||
        command.handedOffFrom !== undefined ||
        command.handedOffTo !== undefined
      );
    default:
      return false;
  }
}
