import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  ProjectId,
  ThreadGroupId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ThreadPullRequestLink } from "./threadPullRequest.ts";

export const ThreadGroupManualResourceKind = Schema.Literals(["server", "container", "other"]);
export type ThreadGroupManualResourceKind = typeof ThreadGroupManualResourceKind.Type;

/** A running resource registered by hand; shown as registered, never health-checked. */
export const ThreadGroupManualResource = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  url: Schema.NullOr(TrimmedNonEmptyString),
  kind: ThreadGroupManualResourceKind,
});
export type ThreadGroupManualResource = typeof ThreadGroupManualResource.Type;

/**
 * A server, container or registered resource attributed to a group. Computed
 * live, never stored; scanned ones are running by construction.
 */
export const ThreadGroupRunningResource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["server", "container", "manual"]),
  name: TrimmedNonEmptyString,
  /** ":5733" for a server, "docker" for a container, the URL for a registered resource. */
  detail: TrimmedNonEmptyString,
  url: Schema.NullOr(TrimmedNonEmptyString),
  /** How it was attributed: a member's terminal, a working directory in the worktree, a compose label, or by hand. */
  source: Schema.Literals(["terminal", "cwd", "docker", "registered"]),
});
export type ThreadGroupRunningResource = typeof ThreadGroupRunningResource.Type;

/** One emission of `threadGroups.subscribeResources`: the group's resources right now. */
export const ThreadGroupRunningResources = Schema.Struct({
  resources: Schema.Array(ThreadGroupRunningResource),
});
export type ThreadGroupRunningResources = typeof ThreadGroupRunningResources.Type;

/** The most recent handoff between two chats of a group. */
export const ThreadGroupHandoff = Schema.Struct({
  summary: TrimmedNonEmptyString,
  fromThreadId: ThreadId,
  toThreadId: ThreadId,
  at: IsoDateTime,
});
export type ThreadGroupHandoff = typeof ThreadGroupHandoff.Type;

/** A chat group as the shell carries it: one project, one workspace, many chats. */
export const OrchestrationThreadGroupShell = Schema.Struct({
  id: ThreadGroupId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  goal: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  pullRequest: Schema.NullOr(ThreadPullRequestLink),
  lastHandoff: Schema.NullOr(ThreadGroupHandoff),
  pinnedAt: Schema.NullOr(IsoDateTime),
  snoozedUntil: Schema.NullOr(IsoDateTime),
  settledAt: Schema.NullOr(IsoDateTime),
  manualResources: Schema.Array(ThreadGroupManualResource),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationThreadGroupShell = typeof OrchestrationThreadGroupShell.Type;

/** Group fields a caller may change. Absent leaves a field unchanged; null clears it. */
export const ThreadGroupUpdatePayload = Schema.Struct({
  title: Schema.optional(TrimmedNonEmptyString),
  goal: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  pullRequest: Schema.optional(Schema.NullOr(ThreadPullRequestLink)),
  lastHandoff: Schema.optional(Schema.NullOr(ThreadGroupHandoff)),
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  settledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  manualResources: Schema.optional(Schema.Array(ThreadGroupManualResource)),
});
export type ThreadGroupUpdatePayload = typeof ThreadGroupUpdatePayload.Type;

export const ThreadGroupMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("thread-group.create"),
    commandId: CommandId,
    groupId: ThreadGroupId,
    projectId: ProjectId,
    /** Chats to put in the group; the first one supplies the default workspace. */
    threadIds: Schema.Array(ThreadId).check(Schema.isMinLength(1)),
    title: Schema.optional(TrimmedNonEmptyString),
    goal: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  }),
  Schema.Struct({
    type: Schema.Literal("thread-group.update"),
    commandId: CommandId,
    groupId: ThreadGroupId,
    patch: ThreadGroupUpdatePayload,
  }),
  Schema.Struct({
    type: Schema.Literal("thread-group.delete"),
    commandId: CommandId,
    groupId: ThreadGroupId,
  }),
  Schema.Struct({
    type: Schema.Literal("thread-group.move-thread"),
    commandId: CommandId,
    threadId: ThreadId,
    /** Null detaches the thread; it keeps its branch and worktree. */
    groupId: Schema.NullOr(ThreadGroupId),
    /** Switch the thread to the group's branch and worktree when they differ from its own. */
    adoptGroupWorkspace: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    /** Remove one registered resource by id; a missing id is already removed. */
    type: Schema.Literal("thread-group.remove-resource"),
    commandId: CommandId,
    groupId: ThreadGroupId,
    resourceId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    /** Recreate the group's worktree on its branch when the directory is gone. */
    type: Schema.Literal("thread-group.recreate-worktree"),
    commandId: CommandId,
    groupId: ThreadGroupId,
  }),
]);
export type ThreadGroupMutation = typeof ThreadGroupMutation.Type;

/** The group after the mutation; null after a delete or a detaching move. */
export const ThreadGroupMutationResult = Schema.Struct({
  group: Schema.NullOr(OrchestrationThreadGroupShell),
});
export type ThreadGroupMutationResult = typeof ThreadGroupMutationResult.Type;

/** Why a group mutation was refused, for failures a client answers with its own flow. */
export const ThreadGroupMutationFailureReason = Schema.Literals([
  "group-not-found",
  "thread-not-found",
  "project-mismatch",
  "subagent",
  "workspace-mismatch",
  "thread-busy",
  "workspace-dirty",
  "worktree-missing",
]);
export type ThreadGroupMutationFailureReason = typeof ThreadGroupMutationFailureReason.Type;

export class ThreadGroupMutationError extends Schema.TaggedError<ThreadGroupMutationError>()(
  "ThreadGroupMutationError",
  {
    commandId: CommandId,
    message: Schema.String,
    /** Absent for operation failures and startup errors. */
    reason: Schema.optional(ThreadGroupMutationFailureReason),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
