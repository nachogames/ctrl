import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as FleetService from "./FleetService.ts";

const actor = { environmentId: EnvironmentId.make("hub"), threadId: ThreadId.make("home") };
const threadId = ThreadId.make("worker");
const approvalId = RuntimeRequestId.make("approval");
const questionId = RuntimeRequestId.make("question");
const toolCallId = RuntimeRequestId.make("tool-call");

const shell = (
  id: string,
  projectId: string,
  updatedAt: number,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
) =>
  ({
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    title: id,
    createdBy: "user",
    creationSource: "web",
    status: "idle",
    activityRunStatus: null,
    latestRunId: null,
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    settledOverride: null,
    settledAt: null,
    pendingRuntimeRequest: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: null },
    visibleItemCount: 0,
    deletedAt: null,
    createdAt: DateTime.makeUnsafe(updatedAt),
    updatedAt: DateTime.makeUnsafe(updatedAt),
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;

const setup = () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const layer = FleetService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed(shell(id, "a", 1)),
          getThreadRecords: () =>
            Effect.succeed({
              runtimeRequests: [
                { id: approvalId, kind: "command", status: "pending" },
                { id: questionId, kind: "user_input", status: "pending" },
                { id: toolCallId, kind: "dynamic_tool_call", status: "pending" },
              ],
              turnItems: [],
            } as never),
          dispatch: (command) => {
            dispatched.push(command);
            return Effect.succeed({ sequence: 7, storedEvents: [] } as never);
          },
        }),
      ),
    ),
  );
  return { layer, dispatched };
};

it.effect("approves a pending request with a decision", () => {
  const { layer, dispatched } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const listed = yield* fleet.execute({
      actor,
      request: { op: "requests.list", input: { threadId } },
    });
    expect(listed).toEqual({ requestIds: [questionId], approvalRequestIds: [approvalId] });
    yield* fleet.execute({
      actor,
      request: {
        op: "requests.respond",
        input: { threadId, requestId: approvalId, decision: "accept" },
      },
    });
    expect(dispatched).toMatchObject([
      { type: "runtime-request.respond", threadId, requestId: approvalId, decision: "accept" },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses to answer a question without answers", () => {
  const { layer, dispatched } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const error = yield* fleet
      .execute({
        actor,
        request: {
          op: "requests.respond",
          input: { threadId, requestId: questionId, decision: "accept" },
        },
      })
      .pipe(Effect.asVoid, Effect.flip);
    expect(error.code).toBe("invalid_request");
    expect(dispatched).toHaveLength(0);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses a decision for a request that is not an approval", () => {
  const { layer, dispatched } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const error = yield* fleet
      .execute({
        actor,
        request: {
          op: "requests.respond",
          input: { threadId, requestId: toolCallId, decision: "accept" },
        },
      })
      .pipe(Effect.asVoid, Effect.flip);
    expect(error.code).toBe("invalid_request");
    expect(dispatched).toHaveLength(0);
  }).pipe(Effect.provide(layer));
});
