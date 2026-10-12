import { assert, it } from "@effect/vitest";
import {
  ContextTransferId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadGroupId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ThreadForkService from "./ThreadForkService.ts";

const sourceThreadId = ThreadId.make("thread:fork-snoozed-source");
const targetThreadId = ThreadId.make("thread:fork-awake-target");
const sourceRunId = RunId.make("run:fork-snoozed-source");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const sourceCreatedAt = DateTime.makeUnsafe("2026-07-24T09:00:00.000Z");
const snoozedAt = DateTime.makeUnsafe("2026-07-24T09:05:00.000Z");
const snoozedUntil = DateTime.makeUnsafe("2026-07-25T09:00:00.000Z");
const forkCreatedAt = DateTime.makeUnsafe("2026-07-24T09:10:00.000Z");

function makeSourceThread(): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: sourceThreadId,
    projectId: ProjectId.make("project:fork-snooze"),
    title: "Snoozed source",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: "feature/source",
    worktreePath: "/tmp/source-worktree",
    activeProviderThreadId: ProviderThreadId.make("provider-thread:fork-snoozed-source"),
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: sourceThreadId,
    },
    forkedFrom: null,
    createdAt: sourceCreatedAt,
    updatedAt: snoozedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    snoozedUntil,
    snoozedAt,
    deletedAt: null,
  };
}

function makeSourceRun(status: OrchestrationV2Run["status"]): OrchestrationV2Run {
  return {
    id: sourceRunId,
    threadId: sourceThreadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: ProviderThreadId.make("provider-thread:fork-snoozed-source"),
    userMessageId: MessageId.make("message:fork-snoozed-source"),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    queuePosition: null,
    requestedAt: sourceCreatedAt,
    startedAt: sourceCreatedAt,
    completedAt: snoozedAt,
    checkpointId: null,
    contextHandoffId: null,
  };
}

function makeSourceProjection(
  sourceRun: OrchestrationV2Run,
  thread: OrchestrationV2AppThread = makeSourceThread(),
): OrchestrationV2ThreadProjection {
  return {
    thread,
    runs: [sourceRun],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: snoozedAt,
  };
}

const planFork = (sourceRun: OrchestrationV2Run, sourceThread?: OrchestrationV2AppThread) =>
  Effect.gen(function* () {
    const service = yield* ThreadForkService.ThreadForkServiceV2;
    return yield* service.plan({
      sourceProjection: makeSourceProjection(sourceRun, sourceThread),
      sourceRun,
      sourceProviderThread: undefined,
      canonicalSourcePoint: {
        threadId: sourceThreadId,
        runId: sourceRunId,
      },
      transferId: ContextTransferId.make("context-transfer:fork-snoozed-source"),
      targetThreadId,
      title: "Awake fork",
      createdBy: "user",
      creationSource: "mobile",
      createdAt: forkCreatedAt,
    });
  }).pipe(Effect.provide(ThreadForkService.layer));

it("treats usage-limited and other provider-finished runs as forkable", () => {
  assert.isTrue(ThreadForkService.isForkableSourceRunStatus("completed"));
  assert.isTrue(ThreadForkService.isForkableSourceRunStatus("waiting"));
  assert.isTrue(ThreadForkService.isForkableSourceRunStatus("failed"));
  assert.isTrue(ThreadForkService.isForkableSourceRunStatus("interrupted"));
  assert.isTrue(ThreadForkService.isForkableSourceRunStatus("cancelled"));
  assert.isFalse(ThreadForkService.isForkableSourceRunStatus("running"));
  assert.isFalse(ThreadForkService.isForkableSourceRunStatus("starting"));
  assert.isFalse(ThreadForkService.isForkableSourceRunStatus("queued"));
  assert.isFalse(ThreadForkService.isForkableSourceRunStatus("preparing"));
  assert.isFalse(ThreadForkService.isForkableSourceRunStatus("rolled_back"));
});

it.effect("keeps a fork awake when its source thread is snoozed", () =>
  Effect.gen(function* () {
    const sourceThread = makeSourceThread();
    const sourceRun = makeSourceRun("completed");
    const result = yield* planFork(sourceRun);

    assert.isNull(result.targetThread.snoozedUntil);
    assert.isNull(result.targetThread.snoozedAt);
    assert.equal(result.targetThread.projectId, sourceThread.projectId);
    assert.equal(result.targetThread.providerInstanceId, sourceThread.providerInstanceId);
    assert.deepEqual(result.targetThread.modelSelection, sourceThread.modelSelection);
    assert.equal(result.targetThread.runtimeMode, sourceThread.runtimeMode);
    assert.equal(result.targetThread.interactionMode, sourceThread.interactionMode);
    assert.equal(result.targetThread.branch, sourceThread.branch);
    assert.equal(result.targetThread.worktreePath, sourceThread.worktreePath);
    assert.isNull(result.targetThread.activeProviderThreadId);
    assert.deepEqual(result.targetThread.lineage, {
      parentThreadId: sourceThreadId,
      relationshipToParent: "fork",
      rootThreadId: sourceThreadId,
    });
    assert.deepEqual(result.targetThread.forkedFrom, {
      type: "run",
      threadId: sourceThreadId,
      runId: sourceRunId,
    });
  }),
);

it.effect("joins the source's group without copying its handoff links", () =>
  Effect.gen(function* () {
    const groupId = ThreadGroupId.make("group:fork-source");
    const result = yield* planFork(makeSourceRun("completed"), {
      ...makeSourceThread(),
      groupId,
      handedOffFrom: ThreadId.make("thread:fork-source-predecessor"),
      handedOffTo: ThreadId.make("thread:fork-source-successor"),
    });
    assert.equal(result.targetThread.groupId, groupId);
    assert.isNull(result.targetThread.handedOffFrom);
    assert.isNull(result.targetThread.handedOffTo);
    // The plan is only a thread and a transfer, so a fork can't write group events.
    assert.sameMembers(Object.keys(result), ["targetThread", "transfer"]);
  }),
);

it.effect("drops the source's group order key so the fork lands on top", () =>
  Effect.gen(function* () {
    const result = yield* planFork(makeSourceRun("completed"), {
      ...makeSourceThread(),
      groupId: ThreadGroupId.make("group:fork-source"),
      groupOrderKey: "a0",
    });
    // A keyless chat sorts first, so the fork shows as the group's newest chat.
    assert.isNull(result.targetThread.groupOrderKey ?? null);
  }),
);

it.effect("leaves a fork of an ungrouped chat ungrouped and creates no group", () =>
  Effect.gen(function* () {
    const result = yield* planFork(makeSourceRun("completed"), {
      ...makeSourceThread(),
      groupId: null,
      handedOffFrom: ThreadId.make("thread:fork-source-predecessor"),
    });
    assert.isNull(result.targetThread.groupId ?? null);
    assert.isNull(result.targetThread.handedOffFrom);
    assert.isNull(result.targetThread.handedOffTo);
    assert.sameMembers(Object.keys(result), ["targetThread", "transfer"]);
  }),
);

it.effect("forks from a usage-limited failed run", () =>
  Effect.gen(function* () {
    const result = yield* planFork(makeSourceRun("failed"));
    assert.deepEqual(result.targetThread.forkedFrom, {
      type: "run",
      threadId: sourceThreadId,
      runId: sourceRunId,
    });
  }),
);

it.effect("rejects in-progress and rolled-back fork sources", () =>
  Effect.gen(function* () {
    for (const status of ["running", "rolled_back"] as const) {
      const sourceRun = makeSourceRun(status);
      const error = yield* planFork(sourceRun).pipe(Effect.flip);
      assert.equal(error._tag, "ThreadForkPlanError");
      assert.equal(error.sourceThreadId, sourceThreadId);
      assert.equal(error.targetThreadId, targetThreadId);
      assert.equal(error.cause, ThreadForkService.forkableSourceRunStatusError(sourceRun));
    }
  }),
);
