import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { RunResult } from "@cursor/sdk";
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
import * as HostProcess from "@t3tools/shared/HostProcess";
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
import { CursorSettings } from "../settings.ts";
import { makeCursorAdapterV2 } from "./adapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import {
  type CursorHookResponse,
  decideCursorMcpHook,
  resetCursorApprovalSessionsForTest,
} from "./CursorMcpApprovals.ts";

const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

const hookCall = (name: string) => ({
  hook_event_name: "beforeMCPExecution",
  conversation_id: `native-${name}`,
  mcp_server_name: "linear",
  mcp_server_url: "https://mcp.linear.app/mcp",
  tool_name: "save_issue",
  tool_input: '{"title":"Bug"}',
  tool_use_id: `${name}-call`,
});

/**
 * A Cursor session with approvals on whose run stays open until `finish`
 * completes. Its agent makes one Linear write through the hook while the turn
 * starts.
 */
const openApprovalSession = Effect.fnUntraced(function* (name: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: `cursor-${name}-` });
  const finish = yield* Deferred.make<RunResult["status"]>();
  const hook = yield* Deferred.make<Fiber.Fiber<CursorHookResponse>>();
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
    settings: yield* decodeCursorSettings({ askBeforeMcpTools: true }),
    environment: { HOME: workspace },
  }).pipe(
    Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
      assertComplete: Effect.void,
      open: () =>
        Effect.succeed({
          agentId: `native-${name}`,
          listMessages: Effect.succeed([]),
          close: Effect.void,
          send: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(
                hook,
                yield* decideCursorMcpHook(hookCall(name)).pipe(
                  Effect.provide(NodeServices.layer),
                  Effect.forkDetach,
                ),
              );
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
      title: "Cursor MCP approval",
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
      text: "File the bug in Linear.",
      attachments: [],
    },
  });
  const decision = yield* Deferred.await(hook);
  // Everything up to and including the approval card.
  const asked = yield* runtime.events.pipe(
    Stream.takeUntil(
      (event) => event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
    ),
    Stream.runCollect,
  );
  const request = asked.find((event) => event.type === "runtime_request.updated");
  if (request?.type !== "runtime_request.updated") return yield* Effect.die("no request");
  return {
    runtime,
    providerThread,
    finish,
    decision,
    card: asked.at(-1),
    request: request.runtimeRequest,
    workspace,
  };
});

const testLayer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer);

const inTemporaryHome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-approval-home-" });
    return yield* effect.pipe(Effect.provideService(HostProcess.HomeDirectory, home));
  }).pipe(
    Effect.ensuring(Effect.sync(resetCursorApprovalSessionsForTest)),
    Effect.scoped,
    Effect.provide(testLayer),
  );

describe("CursorAdapterV2 MCP approvals", () => {
  it.effect("holds a call until the user allows it, with a full-access card", () =>
    inTemporaryHome(
      Effect.gen(function* () {
        const { runtime, finish, decision, card, request } = yield* openApprovalSession("allow");
        assert.equal(request.kind, "permission");
        if (card?.type !== "turn_item.updated" || card.turnItem.type !== "approval_request") {
          return assert.fail("no approval card");
        }
        assert.equal(card.turnItem.appName, "linear");
        assert.include(card.turnItem.prompt ?? "", "save_issue");
        assert.equal(card.turnItem.fullAccessOverride, "ask_rule");

        yield* runtime.respondToRuntimeRequest({ requestId: request.id, decision: "accept" });
        assert.deepEqual(yield* Fiber.join(decision), { permission: "allow" });
        yield* Deferred.succeed(finish, "finished");
      }),
    ),
  );

  it.effect("denies a held call and closes its card when the turn is stopped", () =>
    inTemporaryHome(
      Effect.gen(function* () {
        const { runtime, providerThread, decision, request } = yield* openApprovalSession("stop");
        yield* runtime.interruptTurn({
          providerThread,
          providerTurnId: request.providerTurnId!,
        });
        assert.equal((yield* Fiber.join(decision)).permission, "deny");
        const closed = yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.id === request.id,
          ),
          Stream.take(1),
          Stream.runCollect,
        );
        const update = closed[0];
        assert.equal(
          update?.type === "runtime_request.updated" ? update.runtimeRequest.status : null,
          "cancelled",
        );
      }),
    ),
  );
});
