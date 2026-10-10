import {
  CommandId,
  type OrchestrationThreadGroupShell,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadGroupId,
  type ThreadGroupUpdatePayload,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import {
  decodeThreadGroupCommandRejection,
  defaultThreadGroupTitle,
  encodeThreadGroupCommandRejection,
  planThreadGroupCommand,
  type ThreadGroupCommand,
} from "./ThreadGroupCommands.ts";
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

export class ThreadGroupOperationError extends Schema.TaggedError<ThreadGroupOperationError>()(
  "ThreadGroupOperationError",
  {
    operation: Schema.Literals([
      "read-group",
      "read-threads",
      "commit-group-command",
      "update-thread",
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
  | ThreadGroupOperationError;

export interface ThreadGroupCreateInput {
  readonly commandId: CommandId;
  readonly groupId: ThreadGroupId;
  readonly projectId: ProjectId;
  /** The first thread supplies the default branch, worktree, pull request and title. */
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly title?: string;
  readonly goal?: string | null;
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
    /** Delete the group when no live thread is left in it. */
    readonly pruneIfEmpty: (groupId: ThreadGroupId) => Effect.Effect<void, ThreadGroupServiceError>;
    /** Prune every live group; a restart uses it to catch deletes it missed. */
    readonly pruneEmptyGroups: Effect.Effect<void, ThreadGroupServiceError>;
  }
>()("t3/orchestration-v2/ThreadGroupService") {}

export const make = Effect.gen(function* () {
  const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
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

  /** Not archived, not deleted threads of the project. */
  const listActive = (projectId: ProjectId, groupId?: ThreadGroupId) =>
    threads
      .listProjectThreads({ projectId, includeSubagents: true })
      .pipe(Effect.mapError(readThreadsError(groupId)));

  /** Archived, not deleted threads of the project. Loads the whole archive, so read it last. */
  const listArchived = (projectId: ProjectId, groupId?: ThreadGroupId) =>
    threads.getShellSnapshot({ location: "archive" }).pipe(
      Effect.map((snapshot) =>
        snapshot.archivedThreads.filter(
          (thread) => thread.projectId === projectId && thread.deletedAt === null,
        ),
      ),
      Effect.mapError(readThreadsError(groupId)),
    );

  /** Archived threads keep their group; only deleting or moving them empties it. */
  const hasMembers = Effect.fn("ThreadGroupService.hasMembers")(function* (
    projectId: ProjectId,
    groupId: ThreadGroupId,
  ) {
    const active = yield* listActive(projectId, groupId);
    if (active.some((thread) => thread.groupId === groupId)) return true;
    const archived = yield* listArchived(projectId, groupId);
    return archived.some((thread) => thread.groupId === groupId);
  });

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

  const setThreadGroup = (
    commandId: CommandId,
    threadId: ThreadId,
    groupId: ThreadGroupId | null,
  ) =>
    threads.dispatch({ type: "thread.metadata.update", commandId, threadId, groupId }).pipe(
      Effect.asVoid,
      Effect.mapError(
        (cause) => new ThreadGroupOperationError({ operation: "update-thread", threadId, cause }),
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

  const pruneLocked = Effect.fn("ThreadGroupService.pruneLocked")(function* (
    groupId: ThreadGroupId,
  ) {
    const group = yield* readGroup(groupId);
    if (Option.isNone(group)) return;
    if (yield* hasMembers(group.value.projectId, groupId)) return;
    yield* commitLocked({
      type: "thread-group.delete",
      // A group is deleted at most once, so one id per group replays on retry.
      commandId: CommandId.make(`server:thread-group-prune:${groupId}`),
      groupId,
    }).pipe(Effect.catchTag("ThreadGroupNotFoundError", () => Effect.void));
  });

  const pruneIfEmpty: ThreadGroupService["Service"]["pruneIfEmpty"] = (groupId) =>
    groupLocks.withLock(groupId, pruneLocked(groupId));

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
        if (member.projectId !== input.projectId) {
          return yield* new ThreadGroupProjectMismatchError({
            threadId: member.id,
            threadProjectId: member.projectId,
            groupProjectId: input.projectId,
          });
        }
      }
      const pullRequest = resolveThreadCurrentPullRequestLink(first.pullRequests ?? []);
      yield* commit({
        type: "thread-group.create",
        commandId: input.commandId,
        groupId: input.groupId,
        projectId: input.projectId,
        title:
          input.title ??
          defaultThreadGroupTitle({ pullRequest, branch: first.branch, fallback: first.title }),
        goal: input.goal ?? null,
        branch: first.branch,
        worktreePath: first.worktreePath,
        pullRequest,
      });
      const previousGroups = new Set<ThreadGroupId>();
      yield* groupLocks.withLock(
        input.groupId,
        Effect.forEach(
          members,
          (member) => {
            if (member.groupId === input.groupId) return Effect.void;
            if (member.groupId != null) previousGroups.add(member.groupId);
            return setThreadGroup(
              CommandId.make(`${input.commandId}:join:${member.id}`),
              member.id,
              input.groupId,
            );
          },
          { concurrency: 1, discard: true },
        ),
      );
      yield* Effect.forEach(previousGroups, pruneIfEmpty, { concurrency: 1, discard: true });
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
          yield* setThreadGroup(setCommandId, thread.id, target);
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

  return ThreadGroupService.of({
    create,
    update,
    delete: deleteGroup,
    moveThread,
    pruneIfEmpty,
    pruneEmptyGroups,
  });
});

export const layer = Layer.effect(ThreadGroupService, make);
