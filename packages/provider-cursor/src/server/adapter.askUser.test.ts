import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { RunResult, SDKCustomTool, SDKUserMessage } from "@cursor/sdk";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { CursorSettings } from "../settings.ts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeCursorAdapterV2 } from "./adapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";

const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

const askArgs = {
  questions: [
    {
      question: "Which database?",
      header: "Database",
      options: [{ label: "Postgres", description: "Relational" }, { label: "SQLite" }],
    },
  ],
};

/**
 * A Cursor session whose run stays open until `finish` completes, exposing
 * the `ask_user` tool and message the adapter handed to the SDK.
 */
const openAskUserSession = Effect.fnUntraced(function* (name: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: `cursor-${name}-` });
  const finish = yield* Deferred.make<RunResult["status"]>();
  const tools = yield* Deferred.make<Record<string, SDKCustomTool>>();
  const sent: Array<string | SDKUserMessage> = [];
  const instanceId = ProviderInstanceId.make("cursor");
  const threadId = ThreadId.make(`cursor-${name}-thread`);
  const modelSelection = { instanceId, model: "composer-2.5" };
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: workspace,
  });
  const adapter = yield* makeCursorAdapterV2({
    instanceId,
    settings: yield* decodeCursorSettings({}),
    environment: { HOME: workspace },
  }).pipe(
    Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
      assertComplete: Effect.void,
      open: () =>
        Effect.succeed({
          agentId: `native-${name}`,
          listMessages: Effect.succeed([]),
          close: Effect.void,
          send: (input) =>
            Effect.gen(function* () {
              sent.push(input.message);
              yield* Deferred.succeed(tools, input.options?.local?.customTools ?? {});
              // The SDK also reports the host tool call as an MCP tool call.
              yield* input.onDelta!({
                type: "tool-call-started",
                modelCallId: "model-call",
                callId: "ask-call",
                toolCall: {
                  type: "mcp",
                  args: {
                    providerIdentifier: "custom-user-tools",
                    toolName: "ask_user",
                    args: askArgs,
                  },
                },
              }).pipe(Effect.orDie);
              return {
                agentId: `native-${name}`,
                runId: `native-${name}-run`,
                wait: Deferred.await(finish).pipe(
                  Effect.map((status) => ({
                    id: `native-${name}-run`,
                    requestId: "native-request",
                    status,
                    model: { id: "composer-2.5" },
                    durationMs: 1,
                  })),
                ),
                cancel: Deferred.succeed(finish, "cancelled").pipe(Effect.asVoid),
              };
            }),
        }),
    }),
    Effect.provide(TestProviderHost.layer({ cwd: workspace })),
  );
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`cursor-${name}-session`),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  yield* runtime.startTurn({
    threadId,
    providerThread,
    modelSelection,
    runtimePolicy,
    runId: RunId.make(`cursor-${name}-run`),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make(`cursor-${name}-attempt`),
    rootNodeId: NodeId.make(`cursor-${name}-root`),
    appThread: {
      id: threadId,
      projectId: ProjectId.make(`cursor-${name}-project`),
      createdBy: "user",
      creationSource: "web",
      title: "Cursor ask_user",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    message: {
      messageId: MessageId.make(`cursor-${name}-message`),
      createdBy: "user",
      creationSource: "web",
      text: "Set up the database.",
      attachments: [],
    },
  });
  const askUser = (yield* Deferred.await(tools)).ask_user;
  assert.isDefined(askUser);
  const answer = yield* Effect.promise(async () =>
    askUser!.execute(askArgs, { toolCallId: "ask-call" }),
  ).pipe(Effect.forkScoped);
  // Everything up to and including the question card.
  const asked = yield* runtime.events.pipe(
    Stream.takeUntil(
      (event) => event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
    ),
    Stream.runCollect,
  );
  const request = asked.find((event) => event.type === "runtime_request.updated");
  assert.isDefined(request);
  return { runtime, providerThread, finish, answer, asked, request: request!, sent };
});

const testLayer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer);

describe("CursorAdapterV2 ask_user", () => {
  it.effect("raises a question card and returns the user's answer to the agent", () =>
    Effect.gen(function* () {
      const { runtime, finish, answer, asked, request, sent } =
        yield* openAskUserSession("ask-answer");
      assert.include(String(sent[0]), "ask_user");
      if (request.type !== "runtime_request.updated") return assert.fail("no request");
      assert.equal(request.runtimeRequest.kind, "user_input");
      assert.equal(request.runtimeRequest.status, "pending");
      const card = asked.at(-1);
      if (card?.type !== "turn_item.updated" || card.turnItem.type !== "user_input_request") {
        return assert.fail("no question card");
      }
      assert.deepEqual(
        card.turnItem.questions.map((question) => question.options),
        [
          [
            { label: "Postgres", description: "Relational" },
            { label: "SQLite", description: "SQLite" },
          ],
        ],
      );
      // The MCP call is shown only as the card, never as a tool row.
      assert.isFalse(
        asked.some(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type !== "user_input_request",
        ),
      );

      yield* runtime.respondToRuntimeRequest({
        requestId: request.runtimeRequest.id,
        answers: { "Which database?": "Postgres" },
      });
      assert.deepEqual(yield* Fiber.join(answer), {
        content: [{ type: "text", text: "Which database?\nAnswer: Postgres" }],
        structuredContent: { answers: { "Which database?": "Postgres" } },
      });
      // A second answer to the same request has nothing to resolve.
      const again = yield* runtime
        .respondToRuntimeRequest({ requestId: request.runtimeRequest.id, answers: {} })
        .pipe(Effect.flip);
      assert.equal(again._tag, "ProviderAdapterRuntimeRequestResponseError");

      yield* Deferred.succeed(finish, "finished");
      yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runDrain,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("dismisses a pending question when the turn is stopped", () =>
    Effect.gen(function* () {
      const { runtime, providerThread, answer, request } = yield* openAskUserSession("ask-stop");
      if (request.type !== "runtime_request.updated") return assert.fail("no request");
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: request.runtimeRequest.providerTurnId!,
      });
      const result = yield* Fiber.join(answer);
      assert.deepInclude(result as object, { isError: true });
      const late = yield* runtime
        .respondToRuntimeRequest({ requestId: request.runtimeRequest.id, answers: {} })
        .pipe(Effect.flip);
      assert.equal(late._tag, "ProviderAdapterRuntimeRequestResponseError");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
