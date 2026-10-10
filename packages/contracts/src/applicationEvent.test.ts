import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ApplicationProjectEvent, ApplicationThreadGroupEvent } from "./applicationEvent.ts";

const decodeApplicationProjectEvent = Schema.decodeUnknownEffect(ApplicationProjectEvent);

describe("application project events", () => {
  it.effect("decodes project events without the legacy thread event contract", () =>
    Effect.gen(function* () {
      const event = yield* decodeApplicationProjectEvent({
        sequence: 12,
        eventId: "event-project-12",
        aggregateKind: "project",
        aggregateId: "project-1",
        occurredAt: "2026-06-24T12:00:00.000Z",
        commandId: "command-project-12",
        causationEventId: null,
        correlationId: "command-project-12",
        metadata: {},
        type: "project.created",
        payload: {
          projectId: "project-1",
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-06-24T12:00:00.000Z",
          updatedAt: "2026-06-24T12:00:00.000Z",
        },
      });

      expect(event.type).toBe("project.created");
      expect(event.payload.projectId).toBe("project-1");
    }),
  );

  it.effect("rejects a project event carrying a thread aggregate", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decodeApplicationProjectEvent({
          sequence: 12,
          eventId: "event-project-12",
          aggregateKind: "thread",
          aggregateId: "project-1",
          occurredAt: "2026-06-24T12:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.deleted",
          payload: {
            projectId: "project-1",
            deletedAt: "2026-06-24T12:00:00.000Z",
          },
        }),
      );

      expect(result._tag).toBe("Failure");
    }),
  );
});

const decodeApplicationThreadGroupEvent = Schema.decodeUnknownEffect(ApplicationThreadGroupEvent);
const groupEventAt = "2026-10-10T00:00:00.000Z";
const groupEventBase = {
  sequence: 30,
  eventId: "event-group-30",
  aggregateKind: "thread-group",
  aggregateId: "group-1",
  occurredAt: groupEventAt,
  commandId: "command-group-30",
  causationEventId: null,
  correlationId: "command-group-30",
  metadata: {},
};

describe("application thread group events", () => {
  it.effect("decodes a partial meta update that clears only the goal", () =>
    Effect.gen(function* () {
      const event = yield* decodeApplicationThreadGroupEvent({
        ...groupEventBase,
        type: "thread-group.meta-updated",
        payload: { groupId: "group-1", goal: null, updatedAt: groupEventAt },
      });
      expect(event.type).toBe("thread-group.meta-updated");
      expect(event.payload).toEqual({ groupId: "group-1", goal: null, updatedAt: groupEventAt });
    }),
  );

  it.effect("decodes a created group with its workspace", () =>
    Effect.gen(function* () {
      const event = yield* decodeApplicationThreadGroupEvent({
        ...groupEventBase,
        type: "thread-group.created",
        payload: {
          groupId: "group-1",
          projectId: "project-1",
          title: "Auth refactor",
          goal: null,
          branch: "feat/auth-refactor",
          worktreePath: "/repo-worktrees/auth",
          pullRequest: null,
          createdAt: groupEventAt,
          updatedAt: groupEventAt,
        },
      });
      expect(event.type === "thread-group.created" && event.payload.branch).toBe(
        "feat/auth-refactor",
      );
    }),
  );

  it.effect("rejects a thread group event filed under the project aggregate", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decodeApplicationThreadGroupEvent({
          ...groupEventBase,
          aggregateKind: "project",
          type: "thread-group.deleted",
          payload: { groupId: "group-1", deletedAt: groupEventAt },
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});
