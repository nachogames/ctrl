import {
  ProviderVoiceSessionError,
  type ProviderVoiceSessionEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

export interface ProviderVoiceServiceV2Shape {
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly offerSdp: string;
  }) => Stream.Stream<ProviderVoiceSessionEvent, ProviderVoiceSessionError>;
}

export class ProviderVoiceServiceV2 extends Context.Service<
  ProviderVoiceServiceV2,
  ProviderVoiceServiceV2Shape
>()("t3/orchestration-v2/ProviderVoiceService/ProviderVoiceServiceV2") {}

export const layer: Layer.Layer<
  ProviderVoiceServiceV2,
  never,
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | RuntimePolicyV2
> = Layer.effect(
  ProviderVoiceServiceV2,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const runtimePolicy = yield* RuntimePolicyV2;

    // Reopens an idled-out session the way checkpoint rollback does, without a turn:
    // a starter turn would add seconds before the user can talk.
    const reopenIdleSession = Effect.fn("ProviderVoiceServiceV2.reopenIdleSession")(function* (
      threadId: ThreadId,
    ) {
      const { thread, providerThreads, providerSessions } = yield* projections.getThreadRecords(
        threadId,
        ["providerThreads", "providerSessions"],
      );
      const providerThread = providerThreads.find(
        (candidate) => candidate.id === thread.activeProviderThreadId,
      );
      const providerSessionId = providerThread?.providerSessionId;
      const nativeThreadId = providerThread?.nativeThreadRef?.nativeId;
      if (
        providerThread === undefined ||
        providerSessionId == null ||
        nativeThreadId == null ||
        providerThread.providerInstanceId !== thread.modelSelection.instanceId ||
        (yield* sessions.isLive(providerSessionId))
      ) {
        return;
      }
      const existingSession = providerSessions.find((session) => session.id === providerSessionId);
      yield* sessions.open({
        threadId,
        providerSessionId,
        modelSelection: thread.modelSelection,
        runtimePolicy: yield* runtimePolicy.resolve({
          thread,
          modelSelection: thread.modelSelection,
        }),
        ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
        initialNativeThreadId: nativeThreadId,
        ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
          ? {}
          : {
              initialProviderItemIdentityVersion: providerThread.nativeMetadata.itemIdentityVersion,
            }),
      });
    });

    const start: ProviderVoiceServiceV2Shape["start"] = (input) =>
      Stream.unwrap(
        reopenIdleSession(input.threadId).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderVoiceSessionError({
                threadId: input.threadId,
                // Clients fall back to a starter turn on this text; the turn path can repair
                // what reopening cannot, such as a deleted managed worktree.
                detail: "The provider session could not be reopened. Send a message first.",
                cause,
              }),
          ),
          Effect.map(() => sessions.startVoiceSession(input)),
        ),
      );

    return { start };
  }),
);
