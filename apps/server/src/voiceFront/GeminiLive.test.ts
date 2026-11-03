import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DictationSessionId, ThreadId, type VoiceFrontSettings } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Dictation from "../dictation/Dictation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GeminiLive from "./GeminiLive.ts";
import { spendMonth } from "./geminiCost.ts";
import type { LiveSocketHandlers } from "./LiveSession.ts";
import * as VoiceFrontContext from "./VoiceFrontContext.ts";

const THREAD = ThreadId.make("home:shift");
const chunk = () => new Float32Array(1_600).fill(0.1);

interface FakeSocket {
  readonly url: string;
  readonly handlers: LiveSocketHandlers;
  readonly sent: Array<Record<string, unknown>>;
  closed: boolean;
}

function fakeOpener() {
  const sockets: FakeSocket[] = [];
  const waiters: Array<{ test: () => boolean; done: Deferred.Deferred<void> }> = [];
  const check = () => {
    for (const waiter of waiters.splice(0)) {
      if (waiter.test()) Deferred.doneUnsafe(waiter.done, Effect.void);
      else waiters.push(waiter);
    }
  };
  return {
    sockets,
    layer: Layer.succeed(GeminiLive.LiveSocketOpener, {
      open: (url, handlers) => {
        const socket: FakeSocket = { url, handlers, sent: [], closed: false };
        sockets.push(socket);
        // Gemini accepts the session as soon as it opens.
        queueMicrotask(() => {
          handlers.onOpen();
          handlers.onMessage(JSON.stringify({ setupComplete: {} }));
          check();
        });
        return {
          send: (text) => {
            socket.sent.push(JSON.parse(text));
            check();
          },
          close: () => {
            socket.closed = true;
            check();
          },
        };
      },
    }),
    /** Waits until `test` holds after some socket activity. */
    until: (test: () => boolean) =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<void>();
        waiters.push({ test, done });
        check();
        yield* Deferred.await(done);
      }),
  };
}

const kinds = (socket: FakeSocket | undefined) =>
  (socket?.sent ?? []).map((message) => {
    if ("setup" in message) return "setup";
    if ("toolResponse" in message) return "toolResponse";
    return Object.keys(message.realtimeInput as object)[0]!;
  });

const setup = (options: {
  readonly key?: string;
  readonly voiceFront?: Partial<VoiceFrontSettings>;
  readonly spendFile?: string;
}) =>
  Effect.gen(function* () {
    const opener = fakeOpener();
    const audio = yield* Queue.unbounded<Dictation.VoiceAudioEvent>();
    const dictation = { voiceAudio: Stream.fromQueue(audio) } as Dictation.Dictation["Service"];
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    if (options.spendFile !== undefined)
      yield* fs.writeFileString(
        path.join(config.stateDir, GeminiLive.SPEND_FILE_NAME),
        options.spendFile,
      );
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    if (options.key !== undefined)
      yield* secrets.set(GeminiLive.GEMINI_KEY_SECRET, new TextEncoder().encode(options.key));
    const service = yield* GeminiLive.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          opener.layer,
          Layer.succeed(Dictation.Dictation, dictation),
          Layer.succeed(VoiceFrontContext.VoiceFrontContext, {
            load: () =>
              Effect.succeed({
                kind: "shift" as const,
                title: "Shift",
                threads: [{ title: "PayParty", state: "working", ago: "just now", last: null }],
                messages: [],
              }),
          }),
          ServerSettings.layerTest({
            voiceFront: { enabled: true, engine: "gemini", ...options.voiceFront },
          }),
        ),
      ),
    );
    const sessionId = DictationSessionId.make("d1");
    const say = (samples: Float32Array, speech: boolean) =>
      Queue.offer(audio, { _tag: "audio", threadId: THREAD, sessionId, samples, speech });
    const endTurn = Queue.offer(audio, { _tag: "endOfTurn", threadId: THREAD, sessionId });
    return { service, opener, say, endTurn, audio, config, fs, path };
  });

const layer = Layer.mergeAll(ServerSecretStore.layer).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-gemini-live-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

describe("GeminiLive", () => {
  it.layer(layer)("without a key", (it) => {
    it.effect("opens nothing, and says why once", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, opener, say } = yield* setup({});
          yield* say(chunk(), true);
          const first = yield* service.claim(THREAD);
          assert.deepStrictEqual(first, {
            _tag: "fallback",
            notice: "Gemini has no API key yet, so the local voice is answering.",
          });
          assert.deepStrictEqual(yield* service.claim(THREAD), { _tag: "fallback", notice: null });
          assert.strictEqual(opener.sockets.length, 0);
          assert.isFalse((yield* service.status).keySet);
        }),
      ),
    );
  });

  it.layer(layer)("with a key", (it) => {
    it.effect("streams only the speech of a turn, then hands its answer to the reply", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, opener, say, endTurn } = yield* setup({ key: "test-key" });
          for (let index = 0; index < 30; index++) yield* say(chunk(), false);
          yield* opener.until(() => kinds(opener.sockets[0]).includes("setup"));
          // Three seconds of silence: connected, nothing sent.
          assert.deepStrictEqual(kinds(opener.sockets[0]), ["setup"]);
          assert.match(opener.sockets[0]!.url, /key=test-key$/);
          yield* say(chunk(), true);
          yield* endTurn;
          yield* opener.until(() => kinds(opener.sockets[0]).includes("activityEnd"));
          assert.deepStrictEqual(kinds(opener.sockets[0]), [
            "setup",
            "activityStart",
            "audio",
            "audio",
            "audio",
            "audio",
            "activityEnd",
          ]);
          const claimed = yield* service.claim(THREAD);
          assert.strictEqual(claimed._tag, "turn");
          const status = yield* service.status;
          assert.isTrue(status.keySet);
          assert.strictEqual(status.monthSpendUsd, 0);
        }),
      ),
    );
  });

  it.layer(layer)("metering", (it) => {
    it.effect("adds each usage report to the month and falls back once the cap is reached", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, opener, say, endTurn } = yield* setup({
            key: "k",
            voiceFront: { monthlyCapUsd: 0.01 },
          });
          yield* say(chunk(), true);
          yield* endTurn;
          yield* opener.until(() => kinds(opener.sockets[0]).includes("activityEnd"));
          const socket = opener.sockets[0]!;
          // 2,000 audio tokens in at $3/M and 500 out at $12/M: $0.012.
          socket.handlers.onMessage(
            JSON.stringify({
              serverContent: { turnComplete: true },
              usageMetadata: {
                promptTokenCount: 2_000,
                promptTokensDetails: [{ modality: "AUDIO", tokenCount: 2_000 }],
                responseTokenCount: 500,
                responseTokensDetails: [{ modality: "AUDIO", tokenCount: 500 }],
              },
            }),
          );
          const status = yield* service.status;
          assert.closeTo(status.monthSpendUsd, 0.012, 1e-9);
          assert.isTrue(status.capped);
          // The session closes once its answer is done, and the next turn is local.
          assert.isTrue(socket.closed);
          assert.deepStrictEqual(yield* service.claim(THREAD), {
            _tag: "fallback",
            notice:
              "Gemini reached this month's $0.01 limit, so the local voice takes over until next month.",
          });
        }),
      ),
    );
  });

  it.layer(layer)("saved spend", (it) => {
    it.effect("reads month-to-date spend saved by an earlier run", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const month = spendMonth(yield* Clock.currentTimeMillis);
          const { service } = yield* setup({
            key: "k",
            spendFile: JSON.stringify({ months: { [month]: 9.99, "2020-01": 50 } }),
          });
          const status = yield* service.status;
          assert.strictEqual(status.monthSpendUsd, 9.99);
          assert.isFalse(status.capped);
        }),
      ),
    );
  });

  it.layer(layer)("lifecycle", (it) => {
    it.effect("closes the session when hands-free voice ends", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, opener, say } = yield* setup({ key: "k" });
          yield* say(chunk(), false);
          yield* opener.until(() => opener.sockets.length === 1);
          yield* service.end(THREAD);
          assert.isTrue(opener.sockets[0]!.closed);
        }),
      ),
    );

    it.effect("runs check_threads against the thread's context", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { opener, say, endTurn } = yield* setup({ key: "k" });
          yield* say(chunk(), true);
          yield* endTurn;
          yield* opener.until(() => kinds(opener.sockets[0]).includes("activityEnd"));
          opener.sockets[0]!.handlers.onMessage(
            JSON.stringify({ toolCall: { functionCalls: [{ id: "c1", name: "check_threads" }] } }),
          );
          yield* opener.until(() => kinds(opener.sockets[0]).includes("toolResponse"));
          const response = opener.sockets[0]!.sent.at(-1) as {
            toolResponse: { functionResponses: Array<{ response: { result: string } }> };
          };
          assert.match(
            response.toolResponse.functionResponses[0]!.response.result,
            /"PayParty": working/,
          );
        }),
      ),
    );
  });
});
