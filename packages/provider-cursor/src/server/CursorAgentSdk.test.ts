import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";

const cursorSdkMock = vi.hoisted(() => {
  const closeExecutionOrder: Array<string> = [];
  const runOperations: Array<string> = [];
  let agentCloseFailure: unknown;
  let staleRunActive = false;
  const runWait = vi.fn(async () => ({
    id: "run-cursor-agent-sdk-test",
    requestId: "request-cursor-agent-sdk-test",
    status: "finished",
    result: "ok",
    model: { id: "default" },
    durationMs: 1,
  }));
  const runCancel = vi.fn(async () => {});
  const agentClose = vi.fn(() => {
    closeExecutionOrder.push("sdk:agent.close");
    if (agentCloseFailure !== undefined) {
      throw agentCloseFailure;
    }
  });
  const send = vi.fn(
    async (
      _message: unknown,
      options: { readonly onDelta?: (input: { readonly update: unknown }) => Promise<void> },
    ) => {
      runOperations.push("run.start");
      if (staleRunActive) {
        throw new Error("Agent agent-cursor-agent-sdk-test already has active run");
      }
      await options.onDelta?.({
        update: {
          type: "assistant-message-chunk",
          text: "hello",
        },
      });
      return {
        id: "run-cursor-agent-sdk-test",
        agentId: "agent-cursor-agent-sdk-test",
        wait: runWait,
        cancel: runCancel,
      };
    },
  );
  const create = vi.fn(async () => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    close: agentClose,
  }));
  const resume = vi.fn(async () => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    close: agentClose,
  }));
  const listRuns = vi.fn(
    async (
      _agentId: string,
      options: { cursor?: string; runtime?: "local"; cwd?: string; limit?: number },
    ) => {
      runOperations.push("agent.listRuns");
      return {
        items:
          options.cursor === undefined
            ? [{ id: "run-old-finished", status: "finished" }]
            : staleRunActive
              ? [{ id: "run-stale", status: "running" }]
              : [],
        ...(options.cursor === undefined ? { nextCursor: "next-page" } : {}),
      };
    },
  );
  const cancelRun = vi.fn(async () => {
    runOperations.push("agent.cancelRun");
    staleRunActive = false;
  });

  return {
    agentClose,
    cancelRun,
    closeExecutionOrder,
    create,
    listRuns,
    resume,
    runOperations,
    runCancel,
    runWait,
    send,
    setAgentCloseFailure: (failure: unknown) => {
      agentCloseFailure = failure;
    },
    setStaleRunActive: (active: boolean) => {
      staleRunActive = active;
    },
  };
});

vi.mock("./sdk.ts", () => ({
  Agent: {
    create: cursorSdkMock.create,
    resume: cursorSdkMock.resume,
    listRuns: cursorSdkMock.listRuns,
    cancelRun: cursorSdkMock.cancelRun,
    messages: {
      list: vi.fn(async () => []),
    },
  },
  createAgentPlatform: vi.fn(),
  SqliteLocalAgentStore: { open: vi.fn() },
}));

const layerTest = CursorAgentSdk.layer.pipe(
  Layer.provide(
    Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
      native: {
        filePath: "cursor-agent-sdk-test.log",
        write: (event: unknown) =>
          Effect.sync(() => {
            if (
              typeof event === "object" &&
              event !== null &&
              Reflect.get(Reflect.get(event, "event"), "payload")?.type === "agent.close"
            ) {
              cursorSdkMock.closeExecutionOrder.push("protocol:agent.close");
            }
          }),
        close: () => Effect.void,
      },
      canonical: undefined,
    }),
  ),
  Layer.provide(CursorSdk.layer),
  Layer.provide(NodeServices.layer),
);

describe("CursorAgentSdkRunner", () => {
  it.effect(
    "finds an abandoned run after an older finished page and retries the resumed send",
    () =>
      Effect.gen(function* () {
        cursorSdkMock.runOperations.length = 0;
        cursorSdkMock.listRuns.mockClear();
        cursorSdkMock.cancelRun.mockClear();
        cursorSdkMock.setStaleRunActive(true);

        const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
        const session = yield* runner.open({
          operation: "resume",
          agentId: "agent-cursor-agent-sdk-test",
          options: { model: { id: "default" }, mode: "agent", local: { cwd: process.cwd() } },
          threadId: ThreadId.make("thread-cursor-agent-sdk-stale-run-test"),
          providerSessionId: ProviderSessionId.make(
            "provider-session-cursor-agent-sdk-stale-run-test",
          ),
        });
        assert.deepStrictEqual(cursorSdkMock.runOperations, []);
        const run = yield* session.send({ message: "continue" });
        yield* run.wait;

        assert.deepStrictEqual(cursorSdkMock.runOperations, [
          "run.start",
          "agent.listRuns",
          "agent.listRuns",
          "agent.cancelRun",
          "run.start",
        ]);
        assert.deepStrictEqual(cursorSdkMock.listRuns.mock.calls[0], [
          "agent-cursor-agent-sdk-test",
          { runtime: "local", cwd: process.cwd(), limit: 100 },
        ]);
        assert.deepStrictEqual(cursorSdkMock.listRuns.mock.calls[1], [
          "agent-cursor-agent-sdk-test",
          { runtime: "local", cwd: process.cwd(), limit: 100, cursor: "next-page" },
        ]);
        assert.deepStrictEqual(cursorSdkMock.cancelRun.mock.calls[0], [
          "run-stale",
          {
            runtime: "local",
            cwd: process.cwd(),
          },
        ]);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("does not cancel finished runs when recovery finds no active run", () =>
    Effect.gen(function* () {
      cursorSdkMock.runOperations.length = 0;
      cursorSdkMock.cancelRun.mockClear();
      cursorSdkMock.setStaleRunActive(true);
      cursorSdkMock.listRuns.mockResolvedValueOnce({
        items: [{ id: "run-old-finished", status: "finished" }],
      });
      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "resume",
        agentId: "agent-cursor-agent-sdk-test",
        options: { model: { id: "default" }, mode: "agent", local: { cwd: process.cwd() } },
        threadId: ThreadId.make("thread-cursor-agent-sdk-no-active-run"),
        providerSessionId: ProviderSessionId.make("session-cursor-agent-sdk-no-active-run"),
      });
      const error = yield* session.send({ message: "continue" }).pipe(Effect.flip);
      assert.include(String(error.cause), "already has active run");
      assert.deepStrictEqual(cursorSdkMock.runOperations, ["run.start"]);
      assert.equal(cursorSdkMock.cancelRun.mock.calls.length, 0);
    }).pipe(
      Effect.ensuring(Effect.sync(() => cursorSdkMock.setStaleRunActive(false))),
      Effect.provide(layerTest),
    ),
  );
});
