import { assert, it, vi } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderVoiceService from "./ProviderVoiceService.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

it.effect.each([
  { live: false, opens: true, openFails: false },
  { live: true, opens: false, openFails: false },
  { live: false, opens: true, openFails: true },
])(
  "reopens an idled-out session without a turn before voice (live: $live, openFails: $openFails)",
  ({ live, opens, openFails }) => {
    const threadId = ThreadId.make("thread-voice-reopen");
    const providerSessionId = ProviderSessionId.make("provider-session-voice-reopen");
    const instanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId, model: "gpt-5" };
    const runtimePolicy = { cwd: "/workspace" };
    const thread = {
      id: threadId,
      activeProviderThreadId: ProviderThreadId.make("provider-thread-voice-reopen"),
      modelSelection,
    };
    const records = {
      thread,
      providerThreads: [
        {
          id: thread.activeProviderThreadId,
          providerSessionId,
          providerInstanceId: instanceId,
          nativeThreadRef: { driver: "codex", nativeId: "native-thread", strength: "strong" },
        },
      ],
      providerSessions: [{ id: providerSessionId, status: "stopped" }],
    } as unknown as OrchestrationV2ThreadProjection;
    const calls: Array<string> = [];
    const open = vi.fn((_input: unknown) =>
      Effect.suspend(() => {
        calls.push("open");
        return openFails
          ? Effect.fail(new Error("workspace missing") as never)
          : Effect.succeed({} as never);
      }),
    );
    const startVoiceSession = vi.fn(() => {
      calls.push("startVoiceSession");
      return Stream.make({ type: "started" as const });
    });
    const layerTest = ProviderVoiceService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadRecords: () => Effect.succeed(records as never),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            isLive: () => Effect.succeed(live),
            open,
            startVoiceSession,
          }),
          Layer.mock(RuntimePolicyV2)({
            resolve: () => Effect.succeed(runtimePolicy as never),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const voice = yield* ProviderVoiceService.ProviderVoiceServiceV2;
      const result = yield* Stream.runCollect(voice.start({ threadId, offerSdp: "offer" })).pipe(
        Effect.result,
      );

      if (openFails) {
        // One-click voice falls back to a starter turn only on this text.
        assert.isTrue(
          Result.isFailure(result) && result.failure.detail.includes("Send a message first"),
        );
        assert.deepEqual(calls, ["open"]);
        return;
      }
      assert.deepEqual(Result.getOrThrow(result), [{ type: "started" }]);
      assert.deepEqual(calls, opens ? ["open", "startVoiceSession"] : ["startVoiceSession"]);
      if (opens) {
        assert.deepEqual(open.mock.calls[0]?.[0], {
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
          resumeFromSession: records.providerSessions[0],
          initialNativeThreadId: "native-thread",
        });
      }
    }).pipe(Effect.provide(layerTest));
  },
);
