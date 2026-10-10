import {
  type ApplicationProjectEvent,
  type ApplicationThreadGroupEvent,
  EventId,
  type ProjectId,
  type ThreadGroupId,
  type ThreadGroupUpdatePayload,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";

import type { UnsequencedThreadGroupEvent } from "../../persistence/OrchestrationEventStore.ts";

export const fixtureAt = "2026-10-10T00:00:00.000Z";

export const pullRequestLink: ThreadPullRequestLink = {
  host: "github.com",
  repository: "t3tools/t3code",
  number: 42,
  url: "https://github.com/t3tools/t3code/pull/42",
  source: "manual",
  linkedAt: fixtureAt,
  snapshot: {
    state: "open",
    title: "Chat groups",
    headBranch: "feat/chat-groups",
    baseBranch: "main",
    isDraft: false,
    updatedAt: fixtureAt,
    syncedAt: fixtureAt,
  },
  stack: null,
};

const groupBase = (groupId: ThreadGroupId, eventId: string) => ({
  eventId: EventId.make(eventId),
  aggregateKind: "thread-group" as const,
  aggregateId: groupId,
  occurredAt: fixtureAt,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
});

export function threadGroupCreatedEvent(input: {
  readonly groupId: ThreadGroupId;
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly pullRequest?: ThreadPullRequestLink | null;
}): UnsequencedThreadGroupEvent {
  return {
    ...groupBase(input.groupId, `event:${input.groupId}:created`),
    type: "thread-group.created",
    payload: {
      groupId: input.groupId,
      projectId: input.projectId,
      title: input.title ?? "Auth refactor",
      goal: null,
      branch: input.branch === undefined ? "feat/auth-refactor" : input.branch,
      worktreePath: input.worktreePath === undefined ? "/repo-worktrees/auth" : input.worktreePath,
      pullRequest: input.pullRequest ?? null,
      createdAt: fixtureAt,
      updatedAt: fixtureAt,
    },
  };
}

export function threadGroupMetaUpdatedEvent(
  groupId: ThreadGroupId,
  patch: ThreadGroupUpdatePayload,
  updatedAt = "2026-10-10T01:00:00.000Z",
): UnsequencedThreadGroupEvent {
  return {
    ...groupBase(groupId, `event:${groupId}:updated:${updatedAt}`),
    type: "thread-group.meta-updated",
    payload: { groupId, ...patch, updatedAt },
  };
}

export function threadGroupDeletedEvent(
  groupId: ThreadGroupId,
  deletedAt = "2026-10-10T02:00:00.000Z",
): UnsequencedThreadGroupEvent {
  return {
    ...groupBase(groupId, `event:${groupId}:deleted`),
    type: "thread-group.deleted",
    payload: { groupId, deletedAt },
  };
}

export const sequenced = (
  event: UnsequencedThreadGroupEvent,
  sequence: number,
): ApplicationThreadGroupEvent => ({ ...event, sequence });

const projectBase = (projectId: ProjectId, sequence: number, eventId: string) => ({
  sequence,
  eventId: EventId.make(eventId),
  aggregateKind: "project" as const,
  aggregateId: projectId,
  occurredAt: fixtureAt,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
});

export function projectCreatedEvent(projectId: ProjectId, sequence = 1): ApplicationProjectEvent {
  return {
    ...projectBase(projectId, sequence, `event:${projectId}:created`),
    type: "project.created",
    payload: {
      projectId,
      title: "Project",
      workspaceRoot: `/repo/${projectId}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: fixtureAt,
      updatedAt: fixtureAt,
    },
  };
}

export function projectDeletedEvent(projectId: ProjectId, sequence = 2): ApplicationProjectEvent {
  return {
    ...projectBase(projectId, sequence, `event:${projectId}:deleted`),
    type: "project.deleted",
    payload: { projectId, deletedAt: "2026-10-10T03:00:00.000Z" },
  };
}
