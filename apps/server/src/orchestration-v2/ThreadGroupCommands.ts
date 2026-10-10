import {
  type CommandId,
  type EventId,
  type ProjectId,
  ThreadGroupId,
  type ThreadGroupUpdatePayload,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { UnsequencedThreadGroupEvent } from "../persistence/OrchestrationEventStore.ts";
import type { ThreadGroupRow } from "./ThreadGroupStore.ts";

export interface ThreadGroupCreateCommand {
  readonly type: "thread-group.create";
  readonly commandId: CommandId;
  readonly groupId: ThreadGroupId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly goal: string | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly pullRequest: ThreadPullRequestLink | null;
}

export interface ThreadGroupMetaUpdateCommand {
  readonly type: "thread-group.meta.update";
  readonly commandId: CommandId;
  readonly groupId: ThreadGroupId;
  readonly patch: ThreadGroupUpdatePayload;
}

export interface ThreadGroupDeleteCommand {
  readonly type: "thread-group.delete";
  readonly commandId: CommandId;
  readonly groupId: ThreadGroupId;
}

export type ThreadGroupCommand =
  | ThreadGroupCreateCommand
  | ThreadGroupMetaUpdateCommand
  | ThreadGroupDeleteCommand;

export class ThreadGroupCommandInvariantError extends Schema.TaggedError<ThreadGroupCommandInvariantError>()(
  "ThreadGroupCommandInvariantError",
  { commandType: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Thread group command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

/** The command targets a group that does not exist or was deleted. */
export class ThreadGroupCommandMissingGroupError extends Schema.TaggedError<ThreadGroupCommandMissingGroupError>()(
  "ThreadGroupCommandMissingGroupError",
  { commandType: Schema.String, groupId: ThreadGroupId },
) {
  override get message(): string {
    return `Thread group '${this.groupId}' does not exist for command '${this.commandType}'.`;
  }
}

export const ThreadGroupCommandRejection = Schema.Union([
  ThreadGroupCommandInvariantError,
  ThreadGroupCommandMissingGroupError,
]);
export type ThreadGroupCommandRejection = typeof ThreadGroupCommandRejection.Type;

const ThreadGroupCommandRejectionJson = Schema.fromJsonString(ThreadGroupCommandRejection);
/** A rejected receipt stores its rejection so a retried command id replays the same error. */
export const encodeThreadGroupCommandRejection = Schema.encodeSync(ThreadGroupCommandRejectionJson);
export const decodeThreadGroupCommandRejection = Schema.decodeUnknownOption(
  ThreadGroupCommandRejectionJson,
);

export interface ThreadGroupCommandState {
  /** The target group's row, including a soft-deleted one; only create sees deleted rows as taken. */
  readonly group: ThreadGroupRow | undefined;
}

/** `feat/auth-refactor` → `Auth refactor`. */
export function humanizeBranchName(branch: string): string {
  const segment =
    branch
      .split("/")
      .filter((part) => part.length > 0)
      .at(-1) ?? branch;
  const words = segment.replace(/[-_]+/g, " ").trim();
  return words.length === 0 ? "" : words.charAt(0).toUpperCase() + words.slice(1);
}

/** A new group is named after its pull request, else its branch, else its first chat. */
export function defaultThreadGroupTitle(input: {
  readonly pullRequest: ThreadPullRequestLink | null;
  readonly branch: string | null;
  readonly fallback: string;
}): string {
  const pullRequestTitle = input.pullRequest?.snapshot?.title.trim();
  if (pullRequestTitle) return pullRequestTitle;
  const branchTitle = input.branch === null ? "" : humanizeBranchName(input.branch);
  if (branchTitle.length > 0) return branchTitle;
  return input.fallback.trim() || "Untitled group";
}

/**
 * Decide one group command against its row. The caller reads `state` under the
 * group's lock and commits the planned event.
 */
export function planThreadGroupCommand(input: {
  readonly command: ThreadGroupCommand;
  readonly state: ThreadGroupCommandState;
  readonly eventId: EventId;
  readonly now: DateTime.Utc;
}): Result.Result<UnsequencedThreadGroupEvent, ThreadGroupCommandRejection> {
  const { command, state } = input;
  const invariant = (detail: string) =>
    Result.fail(new ThreadGroupCommandInvariantError({ commandType: command.type, detail }));
  const missingGroup = () =>
    Result.fail(
      new ThreadGroupCommandMissingGroupError({
        commandType: command.type,
        groupId: command.groupId,
      }),
    );
  const activeGroup = state.group?.deletedAt === null ? state.group : undefined;
  const occurredAt = DateTime.formatIso(input.now);
  const base = {
    eventId: input.eventId,
    aggregateKind: "thread-group" as const,
    aggregateId: command.groupId,
    occurredAt,
    commandId: command.commandId,
    causationEventId: null,
    correlationId: command.commandId,
    metadata: {},
  };

  switch (command.type) {
    case "thread-group.create": {
      if (state.group !== undefined) {
        return invariant(
          `Thread group '${command.groupId}' already exists and cannot be created twice.`,
        );
      }
      return Result.succeed({
        ...base,
        type: "thread-group.created",
        payload: {
          groupId: command.groupId,
          projectId: command.projectId,
          title: command.title,
          goal: command.goal,
          branch: command.branch,
          worktreePath: command.worktreePath,
          pullRequest: command.pullRequest,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      });
    }

    case "thread-group.meta.update": {
      if (activeGroup === undefined) return missingGroup();
      if (Object.keys(command.patch).length === 0) {
        return invariant("A thread group update must change at least one field.");
      }
      if (command.patch.manualResources !== undefined) {
        const ids = command.patch.manualResources.map((resource) => resource.id);
        if (new Set(ids).size !== ids.length) {
          return invariant("Registered resource ids must be unique within a group.");
        }
      }
      return Result.succeed({
        ...base,
        type: "thread-group.meta-updated",
        payload: { groupId: command.groupId, ...command.patch, updatedAt: occurredAt },
      });
    }

    case "thread-group.delete": {
      if (activeGroup === undefined) return missingGroup();
      // ThreadGroupService detaches member threads before this event commits.
      return Result.succeed({
        ...base,
        type: "thread-group.deleted",
        payload: { groupId: command.groupId, deletedAt: occurredAt },
      });
    }
  }
}
