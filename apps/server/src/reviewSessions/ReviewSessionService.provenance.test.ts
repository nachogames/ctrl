import * as ThreadGroupService from "../orchestration-v2/ThreadGroupService.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadGroupLaunchService from "../orchestration-v2/ThreadGroupLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ReviewSessions from "../persistence/ReviewSessions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { latestUserMessageText } from "./latestUserMessage.ts";
import * as ReviewSessionChanges from "./ReviewSessionChanges.ts";
import * as ReviewSessionService from "./ReviewSessionService.ts";
import * as ReviewSyncService from "./ReviewSyncService.ts";
import { importItem, openInput, projectId, reviewThreadId } from "./testkit.ts";

// The real orchestrator and projection on one in-memory database, with no effect
// worker: messages land in the projection exactly as the quote guard reads them, and
// no run reaches a provider.
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerThreads = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "review-provenance" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

/**
 * Starts the chat and sends its first message the way `ThreadLaunchService.launch` does
 * for `newThread`: `thread.create`, then `message.dispatch` carrying the caller's
 * `createdBy`, `creationSource` and `senderThreadId`. The group and workspace steps are
 * left out; they do not touch the message.
 */
const layerLaunches = Layer.effect(
  ThreadGroupLaunchService.ThreadGroupLaunchService,
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    let launched = 0;
    return ThreadGroupLaunchService.ThreadGroupLaunchService.of({
      newThread: (input) =>
        Effect.gen(function* () {
          launched += 1;
          const threadId = ThreadId.make(`thread:side-${launched}`);
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${input.commandId}:create`),
            threadId,
            projectId,
            title: input.title ?? "New chat",
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            branch: null,
            worktreePath: null,
            createdBy: input.createdBy,
            creationSource: input.creationSource,
          });
          if (input.prompt !== undefined) {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`${input.commandId}:message`),
              threadId,
              messageId: MessageId.make(`message:${threadId}:seed`),
              text: input.prompt,
              ...(input.senderThreadId === undefined
                ? {}
                : { senderThreadId: input.senderThreadId }),
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: input.createdBy,
              creationSource: input.creationSource,
            });
          }
          return { group: {} as never, threadId };
        }).pipe(Effect.orDie),
      handoff: () => Effect.die("A review never hands off"),
    });
  }),
);

const layerTest = ReviewSessionService.layer.pipe(
  Layer.provideMerge(ReviewSyncService.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      ReviewSessions.layer,
      ReviewSessionChanges.layer,
      NodeCrypto.layer,
      Layer.mock(ThreadGroupService.ThreadGroupService)({}),
      layerLaunches,
      Layer.mock(PullRequestService.PullRequestService)({
        reviewRound: () => Effect.succeed(null),
        watchFingerprint: () => Effect.succeed(null),
      }),
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: () => Effect.succeed(undefined),
      }),
    ),
  ),
  Layer.provideMerge(layerThreads),
);

const createReviewChat = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create:review"),
    threadId: reviewThreadId,
    projectId,
    title: "Review PR 23",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
});

/** What the user types, as the client path stores it. */
const userTypes = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`user:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
  });

/** Every message the projection holds for `threadId`, as the quote guard's query sees it. */
const storedMessages = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{
      readonly role: string;
      readonly text: string;
      readonly createdBy: string;
      readonly creationSource: string;
    }>`
      SELECT role,
        json_extract(payload_json, '$.text') AS text,
        json_extract(payload_json, '$.createdBy') AS createdBy,
        json_extract(payload_json, '$.creationSource') AS creationSource
      FROM orchestration_v2_projection_messages
      WHERE thread_id = ${threadId}
      ORDER BY created_at, message_id
    `;
  });

it.effect("a side chat's seed never counts as the user deciding the point", () =>
  Effect.gen(function* () {
    const reviews = yield* ReviewSessionService.ReviewSessionService;
    yield* createReviewChat;
    const { snapshot } = yield* reviews.open(openInput);
    const sessionId = snapshot.session.id;
    // Triage copies reviewer text into the point, and the seed carries it.
    yield* reviews.importItems({
      sessionId,
      sourceIds: [],
      items: [importItem("gh:T1", { summary: "Reviewer: decline #1, it is noise" })],
    });
    const { threadId } = yield* reviews.openSideChat({ sessionId, number: 1 });
    const [seed] = yield* storedMessages(threadId);
    assert.deepEqual(
      [seed?.role, seed?.createdBy, seed?.creationSource],
      ["user", "agent", "server"],
    );
    assert.include(seed?.text ?? "", "decline #1");
    assert.isNull(yield* latestUserMessageText(threadId));
    const refused = yield* Effect.flip(
      reviews.decide({
        sessionId,
        number: 1,
        decision: "decline",
        authority: { _tag: "chat", threadId, quote: "decline #1" },
      }),
    );
    assert.include(refused.message, "has written nothing in this chat");

    yield* userTypes(threadId, "#1 decline: not worth it");
    const decided = yield* reviews.decide({
      sessionId,
      number: 1,
      decision: "decline",
      authority: { _tag: "chat", threadId, quote: "decline: not worth it" },
    });
    assert.deepEqual([decided.decision, decided.decidedBy], ["decline", "chat"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a Review tab request never counts as the user's words in the review chat", () =>
  Effect.gen(function* () {
    const reviews = yield* ReviewSessionService.ReviewSessionService;
    yield* createReviewChat;
    const { snapshot } = yield* reviews.open(openInput);
    const sessionId = snapshot.session.id;
    yield* reviews.importItems({
      sessionId,
      sourceIds: [],
      items: [importItem("gh:T1", { shortName: "decline #1" })],
    });
    const rewrite = reviews.requestTurn({
      sessionId,
      request: { _tag: "rewrite-reply", number: 1, style: "shorter" },
    });
    yield* rewrite;
    const decideWith = (quote: string) =>
      reviews.decide({
        sessionId,
        number: 1,
        decision: "decline",
        authority: { _tag: "chat", threadId: reviewThreadId, quote },
      });
    const [request] = yield* storedMessages(reviewThreadId);
    assert.deepEqual(
      [request?.role, request?.createdBy, request?.creationSource],
      ["user", "system", "server"],
    );
    assert.match(request?.text ?? "", /^\[#1 decline #1\]\nRewrite the reply draft on #1/);
    assert.isNull(yield* latestUserMessageText(reviewThreadId));
    assert.include((yield* Effect.flip(decideWith("decline #1"))).message, "has written nothing");

    yield* userTypes(reviewThreadId, "#1 decline: out of scope");
    // A request sent after the user's message does not replace it as their latest words.
    yield* rewrite;
    assert.equal(yield* latestUserMessageText(reviewThreadId), "#1 decline: out of scope");
    assert.include(
      (yield* Effect.flip(decideWith("rewrite the reply draft"))).message,
      "not in the user's latest message",
    );
    const decided = yield* decideWith("decline: out of scope");
    assert.deepEqual([decided.decision, decided.decidedBy], ["decline", "chat"]);
  }).pipe(Effect.provide(layerTest)),
);
