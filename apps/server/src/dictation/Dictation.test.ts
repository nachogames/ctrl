import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  DICTATION_MAX_SECONDS,
  DictationError,
  type DictationState,
  type DictationInstallState,
  type DictationModelId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerSettings from "../serverSettings.ts";
import * as Dictation from "./Dictation.ts";
import * as DictationArtifacts from "./DictationArtifacts.ts";
import * as DictationRecognizer from "./DictationRecognizer.ts";
import * as AppleSpeech from "./AppleSpeech.ts";
import * as DictationVocabulary from "./DictationVocabulary.ts";
import * as SmartTurn from "./SmartTurn.ts";
import * as VoiceActivity from "./VoiceActivity.ts";
import { END_OF_TURN_SILENCE_MS, TURN_MAX_SILENCE_MS, VAD_REPORT_LAG_MS } from "./endOfTurn.ts";

const testLayer = (
  options: {
    supported?: boolean;
    installed?: boolean;
    engine?: "off" | "local";
    localModel?: DictationModelId;
    language?: string;
    install?: DictationArtifacts.DictationArtifacts["Service"]["install"];
    remove?: DictationArtifacts.DictationArtifacts["Service"]["remove"];
    inspectFails?: boolean;
    load?: DictationRecognizer.DictationRecognizer["Service"]["load"];
    apple?: AppleSpeech.AppleSpeech["Service"];
    localEngine?: "apple" | "parakeet";
    words?: ReadonlyArray<string>;
    vad?: VoiceActivity.VoiceActivity["Service"];
    smartTurn?: SmartTurn.SmartTurn["Service"];
  } = {},
) =>
  Dictation.layer.pipe(
    Layer.provide(
      options.smartTurn
        ? Layer.succeed(SmartTurn.SmartTurn, options.smartTurn)
        : SmartTurn.layerUnavailable,
    ),
    Layer.provide(
      options.vad
        ? Layer.succeed(VoiceActivity.VoiceActivity, options.vad)
        : VoiceActivity.layerUnavailable,
    ),
    Layer.provide(
      options.apple
        ? Layer.succeed(AppleSpeech.AppleSpeech, options.apple)
        : AppleSpeech.layerUnavailable,
    ),
    Layer.provide(
      Layer.succeed(DictationVocabulary.DictationVocabulary, {
        words: Effect.succeed(options.words ?? []),
      }),
    ),
    Layer.provide(
      Layer.sync(DictationArtifacts.DictationArtifacts, () => {
        let runtime: DictationInstallState =
          options.installed === false
            ? { _tag: "not-installed" }
            : { _tag: "installed", sizeBytes: 1 };
        const disk = new Map<DictationModelId, DictationInstallState>(
          ["parakeet-v3", "whisper-turbo", "moonshine-base"].map((model) => [
            model as DictationModelId,
            runtime,
          ]),
        );
        const complete: DictationArtifacts.DictationArtifacts["Service"]["install"] = (
          model,
          progress,
        ) =>
          Effect.gen(function* () {
            yield* progress("runtime", { _tag: "installed", sizeBytes: 1 });
            yield* progress(model, { _tag: "installed", sizeBytes: 1 });
          });
        return {
          supported: options.supported ?? true,
          paths: () => ({ runtime: "/unused", model: "/unused" }),
          inspect: options.inspectFails
            ? Effect.fail(
                new DictationError({ reason: "install-failed", message: "Unreadable state." }),
              )
            : Effect.sync(() => ({ runtime, models: new Map(disk) })),
          install: (model, progress) =>
            (options.install ?? complete)(model, (artifact, value) =>
              Effect.gen(function* () {
                if (value._tag === "installed") {
                  if (artifact === "runtime") runtime = value;
                  else disk.set(artifact, value);
                }
                yield* progress(artifact, value);
              }),
            ),
          remove: (model) =>
            (options.remove ?? (() => Effect.void))(model).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  disk.set(model, { _tag: "not-installed" });
                }),
              ),
            ),
          speechPaths: { runtime: "/unused", model: "/unused" },
          inspectSpeech: Effect.succeed({ runtime, model: { _tag: "not-installed" } }),
          installSpeech: () => Effect.void,
          removeSpeech: Effect.void,
          vadPaths: { runtime: "/unused", model: "/unused" },
          turnPaths: { model: "/unused", ortModule: "/unused", wasm: "/unused" },
          turnInstalled: Effect.succeed(false),
          installTurn: Effect.void,
        } satisfies DictationArtifacts.DictationArtifacts["Service"];
      }),
    ),
    Layer.provide(
      Layer.succeed(DictationRecognizer.DictationRecognizer, {
        load:
          options.load ??
          (() =>
            Effect.succeed({
              decode: (samples) =>
                Effect.succeed({
                  text: samples.find((sample) => sample !== 0)! < 0.15 ? "one" : "two",
                  locale: "en",
                }),
              release: Effect.void,
            })),
      }),
    ),
    Layer.provideMerge(
      Layer.effect(
        ServerSettings.ServerSettingsService,
        Effect.gen(function* () {
          const original = yield* ServerSettings.ServerSettingsService;
          const changes = yield* PubSub.unbounded<import("@t3tools/contracts").ServerSettings>();
          return {
            ...original,
            updateSettings: (patch) =>
              original
                .updateSettings(patch)
                .pipe(Effect.tap((next) => PubSub.publish(changes, next))),
            streamChanges: Stream.fromPubSub(changes),
            subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
          } satisfies ServerSettings.ServerSettingsService["Service"];
        }),
      ).pipe(
        Layer.provide(
          ServerSettings.layerTest({
            dictation: {
              engine: options.engine ?? "local",
              localEngine: options.localEngine ?? "apple",
              localModel: options.localModel ?? "parakeet-v3",
              language: options.language ?? "auto",
            },
          }),
        ),
      ),
    ),
    Layer.provide(NodeCrypto.layer),
  );

function pcm(seconds: number, value = 0.1) {
  const bytes = Buffer.alloc(seconds * 16000 * 2);
  for (let offset = 0; offset < bytes.length; offset += 2)
    bytes.writeInt16LE(Math.round(value * 32767), offset);
  return bytes.toString("base64");
}

it.effect("gates start on platform, settings and installed artifacts", () =>
  Effect.gen(function* () {
    for (const [options, reason] of [
      [{ supported: false }, "unsupported-platform"],
      [{ engine: "off" as const }, "disabled"],
      [{ installed: false, install: () => Effect.never }, "not-installed"],
    ] as const) {
      const result = yield* Effect.gen(function* () {
        return yield* (yield* Dictation.Dictation).start({}).pipe(Effect.flip);
      }).pipe(Effect.provide(testLayer(options)), Effect.scoped);
      assert.strictEqual(result.reason, reason);
    }
  }),
);

it.effect(
  "starts without awaiting cold load, decodes while recording and preserves final segment order",
  () =>
    Effect.gen(function* () {
      const loading = yield* Deferred.make<void>();
      const firstDecode = yield* Deferred.make<void>();
      const allowDecode = yield* Deferred.make<void>();
      let decoded = 0;
      const program = Effect.gen(function* () {
        const service = yield* Dictation.Dictation;
        const { sessionId } = yield* service.start({});
        yield* service.append({ sessionId, seq: 1, pcm: pcm(0.5, 0) });
        yield* service.append({ sessionId, seq: 0, pcm: pcm(4) });
        yield* Deferred.succeed(loading, undefined);
        yield* Deferred.await(firstDecode);
        yield* service.append({ sessionId, seq: 2, pcm: pcm(2, 0.2) });
        yield* Deferred.succeed(allowDecode, undefined);
        const result = yield* service.finish({ sessionId, chunkCount: 3 });
        assert.deepStrictEqual(result, { text: "one two", locale: "fr" });
        assert.strictEqual(decoded, 2);
      });
      yield* program.pipe(
        Effect.provide(
          testLayer({
            load: () =>
              Deferred.await(loading).pipe(
                Effect.as({
                  decode: () =>
                    Effect.gen(function* () {
                      decoded++;
                      if (decoded === 1) {
                        yield* Deferred.succeed(firstDecode, undefined);
                        yield* Deferred.await(allowDecode);
                      }
                      return { text: decoded === 1 ? " one " : " two ", locale: "fr" };
                    }),
                  release: Effect.void,
                }),
              ),
          }),
        ),
        Effect.scoped,
      );
    }),
);

it.effect("finish accepts ordered stragglers and deduplicates retries", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const { sessionId } = yield* service.start({});
    yield* service.append({ sessionId, seq: 1, pcm: pcm(0.1) });
    const finishing = yield* service.finish({ sessionId, chunkCount: 2 }).pipe(Effect.forkChild);
    yield* service.append({ sessionId, seq: 0, pcm: pcm(0.1) });
    yield* service.append({ sessionId, seq: 1, pcm: pcm(0.1) });
    assert.strictEqual((yield* Fiber.join(finishing)).text, "one");
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);

it.effect("cancel discards a recording and rejects later operations", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const { sessionId } = yield* service.start({});
    yield* service.append({ sessionId, seq: 0, pcm: pcm(0.1) });
    yield* service.cancel({ sessionId });
    assert.strictEqual(
      (yield* service.finish({ sessionId, chunkCount: 1 }).pipe(Effect.flip)).reason,
      "unknown-session",
    );
    assert.strictEqual(
      (yield* service.cancel({ sessionId }).pipe(Effect.flip)).reason,
      "unknown-session",
    );
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);

it.effect("rejects recordings over the duration cap and frees the session", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const { sessionId } = yield* service.start({});
    yield* service.append({ sessionId, seq: 0, pcm: pcm(DICTATION_MAX_SECONDS) });
    assert.strictEqual(
      (yield* service.append({ sessionId, seq: 1, pcm: pcm(0.1) }).pipe(Effect.flip)).reason,
      "too-long",
    );
    assert.strictEqual(
      (yield* service.finish({ sessionId, chunkCount: 2 }).pipe(Effect.flip)).reason,
      "unknown-session",
    );
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);

it.effect("expires abandoned sessions and observes engine-off settings", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const settings = yield* ServerSettings.ServerSettingsService;
    const { sessionId } = yield* service.start({});
    yield* TestClock.adjust("70 seconds");
    assert.strictEqual(
      (yield* service.finish({ sessionId, chunkCount: 0 }).pipe(Effect.flip)).reason,
      "unknown-session",
    );
    const changed = yield* service.stateStream.pipe(
      Stream.filter((state: DictationState) => state.settings.engine === "off"),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* settings.updateSettings({ dictation: { engine: "off" } });
    yield* Fiber.join(changed);
    assert.strictEqual((yield* service.start({}).pipe(Effect.flip)).reason, "disabled");
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);

it.effect("returns typed cold-load failures", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const { sessionId } = yield* service.start({});
    yield* service.append({ sessionId, seq: 0, pcm: pcm(0.1) });
    assert.strictEqual(
      (yield* service.finish({ sessionId, chunkCount: 1 }).pipe(Effect.flip)).reason,
      "load-failed",
    );
  }).pipe(
    Effect.provide(
      testLayer({
        load: () =>
          Effect.fail(
            new DictationError({
              reason: "load-failed",
              message: "Could not load the dictation model.",
            }),
          ),
      }),
    ),
    Effect.scoped,
  ),
);

it.effect("cancel suppresses a decode that is already running", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const complete = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const { sessionId } = yield* service.start({});
      yield* service.append({ sessionId, seq: 0, pcm: pcm(4) });
      yield* service.append({ sessionId, seq: 1, pcm: pcm(0.5, 0) });
      yield* Deferred.await(started);
      yield* service.cancel({ sessionId });
      yield* Deferred.succeed(complete, undefined);
      assert.strictEqual(
        (yield* service.finish({ sessionId, chunkCount: 2 }).pipe(Effect.flip)).reason,
        "unknown-session",
      );
    }).pipe(
      Effect.provide(
        testLayer({
          load: () =>
            Effect.succeed({
              decode: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(complete)),
                  Effect.as({ text: "discarded", locale: "en" }),
                ),
              release: Effect.void,
            }),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("unloads an idle recognizer and loads it again for a later recording", () =>
  Effect.gen(function* () {
    const released = yield* Deferred.make<void>();
    let loads = 0;
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const { sessionId } = yield* service.start({});
      yield* service.append({ sessionId, seq: 0, pcm: pcm(0.1) });
      yield* service.finish({ sessionId, chunkCount: 1 });
      assert.strictEqual((yield* service.state).loadedModel, "parakeet-v3");
      yield* TestClock.adjust("31 minutes");
      yield* Deferred.await(released);
      assert.strictEqual((yield* service.state).loadedModel, null);
      const second = yield* service.start({});
      yield* service.append({ sessionId: second.sessionId, seq: 0, pcm: pcm(0.1) });
      yield* service.finish({ sessionId: second.sessionId, chunkCount: 1 });
      assert.strictEqual(loads, 2);
    }).pipe(
      Effect.provide(
        testLayer({
          load: () =>
            Effect.sync(() => {
              loads++;
              return {
                decode: () => Effect.succeed({ text: "one", locale: "en" }),
                release: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
              };
            }),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("keeps installed state honest when model removal fails", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const error = yield* service.remove({ model: "parakeet-v3" }).pipe(Effect.flip);
    assert.strictEqual(error.reason, "install-failed");
    const state = yield* service.state;
    assert.strictEqual(state.models[0]?.install._tag, "installed");
    assert.strictEqual(state.ready, false);
  }).pipe(
    Effect.provide(
      testLayer({
        engine: "off",
        remove: () =>
          Effect.fail(
            new DictationError({
              reason: "install-failed",
              message: "Could not access dictation files.",
            }),
          ),
      }),
    ),
    Effect.scoped,
  ),
);

it.effect("completes removal coherently when its caller disconnects during a decode", () =>
  Effect.gen(function* () {
    const decoding = yield* Deferred.make<void>();
    const completeDecode = yield* Deferred.make<void>();
    const removed = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const { sessionId } = yield* service.start({});
      yield* service.append({ sessionId, seq: 0, pcm: pcm(4) });
      yield* service.append({ sessionId, seq: 1, pcm: pcm(0.5, 0) });
      yield* Deferred.await(decoding);
      const removal = yield* service.remove({ model: "moonshine-base" }).pipe(Effect.forkChild);
      yield* service.stateStream.pipe(
        Stream.filter(
          (state) =>
            state.models.find((model) => model.id === "moonshine-base")?.install._tag ===
            "not-installed",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      removal.interruptUnsafe();
      yield* Deferred.succeed(completeDecode, undefined);
      yield* Deferred.await(removed);
      yield* Fiber.await(removal);
      const state = yield* service.state;
      assert.strictEqual(state.ready, true);
      assert.strictEqual(state.loadedModel, "parakeet-v3");
      assert.strictEqual(
        (yield* service.finish({ sessionId, chunkCount: 2 })).text,
        "discarded discarded",
      );
    }).pipe(
      Effect.provide(
        testLayer({
          load: () =>
            Effect.succeed({
              decode: () =>
                Deferred.succeed(decoding, undefined).pipe(
                  Effect.andThen(Deferred.await(completeDecode)),
                  Effect.as({ text: "discarded", locale: "en" }),
                ),
              release: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
            }),
          remove: () => Deferred.succeed(removed, undefined).pipe(Effect.asVoid),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("engine off prevents automatic and explicit downloads", () =>
  Effect.gen(function* () {
    let installs = 0;
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      assert.strictEqual(
        (yield* service.install({ model: "parakeet-v3" }).pipe(Effect.flip)).reason,
        "disabled",
      );
      assert.strictEqual((yield* service.state).models[0]?.install._tag, "not-installed");
      assert.strictEqual(installs, 0);
    }).pipe(
      Effect.provide(
        testLayer({
          engine: "off",
          installed: false,
          install: () =>
            Effect.sync(() => {
              installs++;
            }),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("activation starts one scoped install and retry RPC returns before it completes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const complete = yield* Deferred.make<void>();
    let installs = 0;
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ dictation: { engine: "local" } });
      yield* Deferred.await(started);
      yield* service.install({ model: "parakeet-v3" });
      yield* service.install({ model: "parakeet-v3" });
      yield* settings.updateSettings({ dictation: { language: "en" } });
      assert.strictEqual((yield* service.state).models[0]?.install._tag, "installing");
      assert.strictEqual(installs, 1);
      yield* Deferred.succeed(complete, undefined);
      yield* service.stateStream.pipe(
        Stream.filter((state) => state.ready),
        Stream.take(1),
        Stream.runDrain,
      );
    }).pipe(
      Effect.provide(
        testLayer({
          engine: "off",
          installed: false,
          install: (model, progress) =>
            Effect.gen(function* () {
              installs++;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(complete);
              yield* progress("runtime", { _tag: "installed", sizeBytes: 1 });
              yield* progress(model, { _tag: "installed", sizeBytes: 1 });
            }),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("a failed activation waits for explicit retry or re-selection", () =>
  Effect.gen(function* () {
    let installs = 0;
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const settings = yield* ServerSettings.ServerSettingsService;
      const failed = () =>
        service.stateStream.pipe(
          Stream.filter(
            (state) =>
              state.models.find((model) => model.id === state.settings.localModel)?.install._tag ===
              "failed",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
      yield* failed();
      yield* settings.updateSettings({ dictation: { language: "en" } });
      assert.strictEqual((yield* service.start({}).pipe(Effect.flip)).reason, "not-installed");
      assert.strictEqual(installs, 1);
      yield* service.install({ model: "parakeet-v3" });
      yield* failed();
      assert.strictEqual(installs, 2);
      yield* settings.updateSettings({ dictation: { localModel: "moonshine-base" } });
      yield* service.stateStream.pipe(
        Stream.filter(
          (state) =>
            state.settings.localModel === "moonshine-base" &&
            state.models.find((model) => model.id === "moonshine-base")?.install._tag === "failed",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      assert.strictEqual(installs, 3);
      yield* settings.updateSettings({ dictation: { localModel: "parakeet-v3" } });
      yield* service.stateStream.pipe(
        Stream.filter(
          (state) =>
            state.settings.localModel === "parakeet-v3" &&
            state.models[0]?.install._tag === "failed",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      assert.strictEqual(installs, 4);
    }).pipe(
      Effect.provide(
        testLayer({
          installed: false,
          install: () =>
            Effect.gen(function* () {
              installs++;
              return yield* new DictationError({
                reason: "install-failed",
                message: "Dictation installation failed.",
              });
            }),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("turning off cancels a download, and removing the active model is a no-op", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    let removals = 0;
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* Deferred.await(started);
      yield* service.remove({ model: "parakeet-v3" });
      assert.strictEqual(removals, 0);
      yield* settings.updateSettings({ dictation: { engine: "off" } });
      yield* Deferred.await(cancelled);
      yield* service.stateStream.pipe(
        Stream.filter((state) => state.settings.engine === "off"),
        Stream.take(1),
        Stream.runDrain,
      );
      assert.strictEqual((yield* service.state).models[0]?.install._tag, "not-installed");
    }).pipe(
      Effect.provide(
        testLayer({
          installed: false,
          install: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(cancelled, undefined)),
            ),
          remove: () =>
            Effect.sync(() => {
              removals++;
            }),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect(
  "language changes apply to the next session while existing sessions retain their language",
  () =>
    Effect.gen(function* () {
      const languages: string[] = [];
      yield* Effect.gen(function* () {
        const service = yield* Dictation.Dictation;
        const settings = yield* ServerSettings.ServerSettingsService;
        const first = yield* service.start({});
        yield* settings.updateSettings({ dictation: { language: "nl" } });
        const second = yield* service.start({});
        yield* service.append({ sessionId: first.sessionId, seq: 0, pcm: pcm(0.1) });
        yield* service.finish({ sessionId: first.sessionId, chunkCount: 1 });
        yield* service.append({ sessionId: second.sessionId, seq: 0, pcm: pcm(0.1) });
        assert.strictEqual(
          (yield* service.finish({ sessionId: second.sessionId, chunkCount: 1 })).locale,
          "nl",
        );
        yield* settings.updateSettings({ dictation: { language: "invalid" } });
        const third = yield* service.start({});
        yield* service.append({ sessionId: third.sessionId, seq: 0, pcm: pcm(0.1) });
        yield* service.finish({ sessionId: third.sessionId, chunkCount: 1 });
        assert.deepStrictEqual(languages, ["en", "nl", ""]);
      }).pipe(
        Effect.provide(
          testLayer({
            localModel: "whisper-turbo",
            language: "en",
            load: () =>
              Effect.succeed({
                decode: (_samples, language) =>
                  Effect.sync(() => {
                    languages.push(language);
                    return { text: "one", locale: language || "en" };
                  }),
                release: Effect.void,
              }),
          }),
        ),
        Effect.scoped,
      );
    }),
);

it.effect("switching models retires the previous recognizer", () =>
  Effect.gen(function* () {
    const released = yield* Deferred.make<void>();
    const loaded: DictationModelId[] = [];
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const settings = yield* ServerSettings.ServerSettingsService;
      const first = yield* service.start({});
      yield* service.append({ sessionId: first.sessionId, seq: 0, pcm: pcm(0.1) });
      yield* service.finish({ sessionId: first.sessionId, chunkCount: 1 });
      yield* settings.updateSettings({ dictation: { localModel: "moonshine-base" } });
      const second = yield* service.start({});
      yield* Deferred.await(released);
      yield* service.append({ sessionId: second.sessionId, seq: 0, pcm: pcm(0.1) });
      yield* service.finish({ sessionId: second.sessionId, chunkCount: 1 });
      assert.deepStrictEqual(loaded, ["parakeet-v3", "moonshine-base"]);
    }).pipe(
      Effect.provide(
        testLayer({
          load: (model) =>
            Effect.sync(() => {
              loaded.push(model);
              return {
                decode: () => Effect.succeed({ text: "one", locale: "en" }),
                release: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
              };
            }),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("explicit retry outlives its RPC scope and returns before downloading completes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const complete = yield* Deferred.make<void>();
    let calls = 0;
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      yield* service.stateStream.pipe(
        Stream.filter((state) => state.models[0]?.install._tag === "failed"),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* service.install({ model: "parakeet-v3" }).pipe(Effect.scoped);
      yield* Deferred.await(started);
      assert.strictEqual((yield* service.state).models[0]?.install._tag, "installing");
      yield* Deferred.succeed(complete, undefined);
      yield* service.stateStream.pipe(
        Stream.filter((state) => state.ready),
        Stream.take(1),
        Stream.runDrain,
      );
    }).pipe(
      Effect.provide(
        testLayer({
          installed: false,
          install: (model, progress) =>
            Effect.gen(function* () {
              calls++;
              if (calls === 1)
                return yield* new DictationError({
                  reason: "install-failed",
                  message: "Dictation installation failed.",
                });
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(complete);
              yield* progress("runtime", { _tag: "installed", sizeBytes: 1 });
              yield* progress(model, { _tag: "installed", sizeBytes: 1 });
            }),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("a silent tail preserves the locale detected in earlier speech", () =>
  Effect.gen(function* () {
    const speechDecoded = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const { sessionId } = yield* service.start({});
      yield* service.append({ sessionId, seq: 0, pcm: pcm(4) });
      yield* service.append({ sessionId, seq: 1, pcm: pcm(0.5, 0) });
      yield* Deferred.await(speechDecoded);
      yield* service.append({ sessionId, seq: 2, pcm: pcm(0.1, 0) });
      assert.deepStrictEqual(yield* service.finish({ sessionId, chunkCount: 3 }), {
        text: "hallo",
        locale: "nl",
      });
    }).pipe(
      Effect.provide(
        testLayer({
          localModel: "whisper-turbo",
          load: () =>
            Effect.succeed({
              decode: (samples) =>
                samples.some((sample) => sample !== 0)
                  ? Deferred.succeed(speechDecoded, undefined).pipe(
                      Effect.as({ text: "hallo", locale: "nl" }),
                    )
                  : Effect.succeed({ text: "", locale: "en" }),
              release: Effect.void,
            }),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("turning off during cancellation prevents a stale replacement download", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const cancelling = yield* Deferred.make<void>();
    const cleanup = yield* Deferred.make<void>();
    const installs: DictationModelId[] = [];
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* Deferred.await(started);
      yield* settings.updateSettings({ dictation: { localModel: "moonshine-base" } });
      yield* Deferred.await(cancelling);
      yield* settings.updateSettings({ dictation: { engine: "off" } });
      yield* Deferred.succeed(cleanup, undefined);
      yield* service.stateStream.pipe(
        Stream.filter((state) => state.settings.engine === "off"),
        Stream.take(1),
        Stream.runDrain,
      );
      assert.deepStrictEqual(installs, ["parakeet-v3"]);
      assert.strictEqual((yield* service.state).models[2]?.install._tag, "not-installed");
    }).pipe(
      Effect.provide(
        testLayer({
          installed: false,
          install: (model) => {
            installs.push(model);
            return Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Deferred.succeed(cancelling, undefined).pipe(
                  Effect.andThen(Deferred.await(cleanup)),
                ),
              ),
            );
          },
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("warm loads the model once before any recording, and is a no-op when off", () =>
  Effect.gen(function* () {
    let loads = 0;
    const load = () =>
      Effect.sync(() => {
        loads++;
        return {
          decode: () => Effect.succeed({ text: "one", locale: "en" }),
          release: Effect.void,
        };
      });
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      yield* service.warm;
      yield* service.warm;
      yield* Effect.yieldNow;
      assert.strictEqual((yield* service.state).loadedModel, "parakeet-v3");
      const { sessionId } = yield* service.start({});
      yield* service.append({ sessionId, seq: 0, pcm: pcm(0.1) });
      yield* service.finish({ sessionId, chunkCount: 1 });
      assert.strictEqual(loads, 1);
    }).pipe(Effect.provide(testLayer({ load })), Effect.scoped);

    loads = 0;
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      yield* service.warm;
      yield* Effect.yieldNow;
      assert.strictEqual((yield* service.state).loadedModel, null);
      assert.strictEqual(loads, 0);
    }).pipe(Effect.provide(testLayer({ load, engine: "off" })), Effect.scoped);
  }),
);

it.effect("warm never installs a model while its removal is still deleting files", () =>
  Effect.gen(function* () {
    const removing = yield* Deferred.make<void>();
    const finishRemoval = yield* Deferred.make<void>();
    let removalPending = false;
    let installsDuringRemoval = 0;
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const settings = yield* ServerSettings.ServerSettingsService;
      const removal = yield* service.remove({ model: "moonshine-base" }).pipe(Effect.forkChild);
      yield* Deferred.await(removing);
      yield* settings.updateSettings({ dictation: { localModel: "moonshine-base" } });
      const warming = yield* service.warm.pipe(Effect.forkChild);
      for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
      yield* Deferred.succeed(finishRemoval, undefined);
      yield* Fiber.await(removal);
      yield* Fiber.await(warming);
      assert.strictEqual(installsDuringRemoval, 0);
    }).pipe(
      Effect.provide(
        testLayer({
          remove: () =>
            Effect.sync(() => {
              removalPending = true;
            }).pipe(
              Effect.andThen(Deferred.succeed(removing, undefined)),
              Effect.andThen(Deferred.await(finishRemoval)),
              Effect.ensuring(
                Effect.sync(() => {
                  removalPending = false;
                }),
              ),
            ),
          install: (model, progress) =>
            Effect.gen(function* () {
              if (removalPending) installsDuringRemoval++;
              yield* progress("runtime", { _tag: "installed", sizeBytes: 1 });
              yield* progress(model, { _tag: "installed", sizeBytes: 1 });
            }),
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("an unreadable install directory leaves dictation not installed instead of failing", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const state = yield* service.state;
    assert.strictEqual(state.runtime._tag, "not-installed");
    assert.strictEqual(state.ready, false);
  }).pipe(Effect.provide(testLayer({ engine: "off", inspectFails: true })), Effect.scoped),
);

it("prefers Apple's engine only where it is available", () => {
  assert.strictEqual(Dictation.resolveActiveEngine("apple", true), "apple");
  assert.strictEqual(Dictation.resolveActiveEngine("apple", false), "parakeet");
  assert.strictEqual(Dictation.resolveActiveEngine("parakeet", true), "parakeet");
  assert.strictEqual(Dictation.resolveActiveEngine("parakeet", false), "parakeet");
});

const appleProbe = (
  assets: AppleSpeech.AppleProbe["assets"],
  locale: string | null = "en-US",
): AppleSpeech.AppleProbe => ({
  available: true,
  reason: null,
  locale,
  assets,
  languageOptions: [{ code: "en-US", label: "English (United States)" }],
});

const fakeApple = (options: {
  probe?: AppleSpeech.AppleProbe;
  installs?: string[];
  opened?: Array<{ language: string; words: ReadonlyArray<string> }>;
  written?: number[];
  closed?: { count: number };
}): AppleSpeech.AppleSpeech["Service"] => ({
  probe: () => Effect.succeed(options.probe ?? appleProbe("installed")),
  install: (language, progress) =>
    Effect.gen(function* () {
      options.installs?.push(language);
      yield* progress(1, 2);
    }),
  open: (input) =>
    Effect.sync(() => {
      options.opened?.push(input);
      const samples: number[] = [];
      return {
        write: (pcm) =>
          Effect.sync(() => {
            samples.push(pcm.length / 2);
            options.written?.push(pcm.length / 2);
          }),
        partial: Effect.sync(() => (samples.length ? `hearing ${samples.join("+")}` : "")),
        finish: Effect.sync(() => ({ text: `heard ${samples.join("+")}`, locale: "en-US" })),
        close: Effect.sync(() => {
          if (options.closed) options.closed.count++;
        }),
      };
    }),
});

it.effect("uses Apple's engine on a Mac without downloading Parakeet", () =>
  Effect.gen(function* () {
    const parakeetInstalls: DictationModelId[] = [];
    const installs: string[] = [];
    const opened: Array<{ language: string; words: ReadonlyArray<string> }> = [];
    const closed = { count: 0 };
    yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const { sessionId } = yield* service.start({});
      const state = yield* service.state;
      assert.strictEqual(state.activeEngine, "apple");
      assert.strictEqual(state.supported, true);
      assert.strictEqual(state.ready, true);
      // Chunks arrive out of order and are written in recording order.
      yield* service.append({ sessionId, seq: 1, pcm: pcm(0.5) });
      yield* service.append({ sessionId, seq: 0, pcm: pcm(1) });
      const result = yield* service.finish({ sessionId, chunkCount: 2 });
      assert.deepStrictEqual(result, { text: "heard 16000+8000", locale: "en-US" });
    }).pipe(
      Effect.provide(
        testLayer({
          supported: false,
          installed: false,
          install: (model) =>
            Effect.sync(() => {
              parakeetInstalls.push(model);
            }),
          words: ["PayParty"],
          apple: fakeApple({ installs, opened, closed }),
        }),
      ),
      Effect.scoped,
    );
    assert.deepStrictEqual(parakeetInstalls, []);
    assert.deepStrictEqual(installs, []);
    assert.deepStrictEqual(opened, [{ language: "auto", words: ["PayParty"] }]);
    assert.strictEqual(closed.count, 1);
  }),
);

it.effect("installs Apple's language assets when they are missing", () =>
  Effect.gen(function* () {
    const installs: string[] = [];
    const states = yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      // Starting waits for reconciliation, which begins the asset download.
      const before = yield* service.start({}).pipe(Effect.flip);
      assert.strictEqual(before.reason, "not-installed");
      return yield* service.stateStream.pipe(
        Stream.filter((state) => state.ready),
        Stream.take(1),
        Stream.runCollect,
      );
    }).pipe(
      Effect.provide(
        testLayer({
          language: "fr",
          apple: fakeApple({ probe: appleProbe("supported"), installs }),
        }),
      ),
      Effect.scoped,
    );
    assert.deepStrictEqual(installs, ["fr"]);
    assert.strictEqual(states[0]?.apple.assets._tag, "installed");
  }),
);

it.effect("keeps Parakeet when the user picks it on a Mac", () =>
  Effect.gen(function* () {
    const opened: Array<{ language: string; words: ReadonlyArray<string> }> = [];
    const result = yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      const { sessionId } = yield* service.start({});
      assert.strictEqual((yield* service.state).activeEngine, "parakeet");
      yield* service.append({ sessionId, seq: 0, pcm: pcm(1) });
      return yield* service.finish({ sessionId, chunkCount: 1 });
    }).pipe(
      Effect.provide(testLayer({ localEngine: "parakeet", apple: fakeApple({ opened }) })),
      Effect.scoped,
    );
    assert.strictEqual(result.text, "one");
    assert.deepStrictEqual(opened, []);
  }),
);

it.effect("reports a language Apple cannot transcribe as a failed install", () =>
  Effect.gen(function* () {
    const state = yield* Effect.gen(function* () {
      const service = yield* Dictation.Dictation;
      yield* service.start({}).pipe(Effect.flip);
      return yield* service.state;
    }).pipe(
      Effect.provide(testLayer({ apple: fakeApple({ probe: appleProbe("unsupported", null) }) })),
      Effect.scoped,
    );
    assert.strictEqual(state.activeEngine, "apple");
    assert.strictEqual(state.ready, false);
    assert.strictEqual(state.apple.assets._tag, "failed");
  }),
);

it.effect("streams live text with each append", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const { sessionId } = yield* service.start({});
    assert.deepStrictEqual(yield* service.append({ sessionId, seq: 0, pcm: pcm(0.5) }), {
      partial: "hearing 8000",
      speaking: false,
      endOfTurn: false,
    });
    assert.deepStrictEqual(yield* service.append({ sessionId, seq: 1, pcm: pcm(0.25) }), {
      partial: "hearing 8000+4000",
      speaking: false,
      endOfTurn: false,
    });
  }).pipe(Effect.provide(testLayer({ apple: fakeApple({}) })), Effect.scoped),
);

it.effect("keeps a session alive while the first audio waits on the microphone prompt", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    // Long enough since the server started that a stale idle clock would expire a new session.
    yield* TestClock.adjust("10 minutes");
    const { sessionId } = yield* service.start({});
    // The idle sweep runs every 10 seconds; the user is still answering the prompt.
    yield* TestClock.adjust("20 seconds");
    yield* service.append({ sessionId, seq: 0, pcm: pcm(1) });
    const result = yield* service.finish({ sessionId, chunkCount: 1 });
    assert.strictEqual(result.text, "heard 16000");
  }).pipe(Effect.provide(testLayer({ apple: fakeApple({}) })), Effect.scoped),
);

const released = { count: 0 };

/** Hears speech in any frame louder than silence. */
const loudnessVad = (released: { count: number }): VoiceActivity.VoiceActivity["Service"] => ({
  open: Effect.succeed({
    accept: (samples) => {
      const detected = samples.some((sample) => Math.abs(sample) > 0.05);
      // Loud frames are clear speech; quieter ones only pass the normal threshold, like echo.
      return { detected, confident: samples.some((sample) => Math.abs(sample) > 0.2) };
    },
    release: () => {
      released.count += 1;
    },
  }),
});

it.effect("a hands-free session reports speech and ends the turn after the silence window", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const started = yield* service.start({ handsFree: true });
    assert.strictEqual(started.handsFree, true);
    const { sessionId } = started;
    let seq = 0;
    const append = (seconds: number, value: number) =>
      service.append({ sessionId, seq: seq++, pcm: pcm(seconds, value) });
    const quiet = yield* append(0.5, 0);
    assert.strictEqual(quiet.speaking, false);
    const spoken = yield* append(1, 0.1);
    assert.deepStrictEqual([spoken.speaking, spoken.endOfTurn], [true, false]);
    // A pause under the window keeps the turn going.
    for (let index = 0; index < 4; index++) assert.isFalse((yield* append(0.1, 0)).endOfTurn);
    yield* append(0.2, 0.1);
    const endedAfter: boolean[] = [];
    for (let index = 0; index < 8; index++) endedAfter.push((yield* append(0.1, 0)).endOfTurn);
    // The detector reports silence late; that lag counts toward the silence window.
    const window = END_OF_TURN_SILENCE_MS - VAD_REPORT_LAG_MS;
    assert.deepStrictEqual(
      endedAfter,
      endedAfter.map((_, index) => (index + 1) * 100 >= window + 100),
    );
    assert.isTrue(endedAfter.at(-1));
    const result = yield* service.finish({ sessionId, chunkCount: seq });
    assert.match(result.text, /^heard /);
    assert.strictEqual(released.count, 1);
  }).pipe(
    Effect.provide(testLayer({ apple: fakeApple({}), vad: loudnessVad(released) })),
    Effect.scoped,
  ),
);

it.effect("a voice turn's audio reaches live listeners with each chunk's speech verdict", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const listened = yield* service.voiceAudio.pipe(
      Stream.takeUntil((event) => event._tag === "closed"),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    const { sessionId } = yield* service.start({
      handsFree: true,
      voiceThreadId: ThreadId.make("home:shift"),
    });
    let seq = 0;
    const append = (seconds: number, value: number) =>
      service.append({ sessionId, seq: seq++, pcm: pcm(seconds, value) });
    yield* append(0.2, 0);
    yield* append(0.5, 0.3);
    for (let index = 0; index < 10; index++) yield* append(0.1, 0);
    yield* service.cancel({ sessionId });
    const events = Array.from(yield* Fiber.join(listened));
    const tags = events.map((event) =>
      event._tag === "audio" ? (event.speech ? "speech" : "quiet") : event._tag,
    );
    assert.deepStrictEqual(tags.slice(0, 2), ["quiet", "speech"]);
    // The turn ends once, then the session closes.
    assert.deepStrictEqual(
      tags.filter((tag) => tag === "endOfTurn" || tag === "closed"),
      ["endOfTurn", "closed"],
    );
    // Without a thread, nothing is published.
    const other = yield* service.start({ handsFree: true });
    yield* service.append({ sessionId: other.sessionId, seq: 0, pcm: pcm(0.2, 0.3) });
    yield* service.cancel({ sessionId: other.sessionId });
  }).pipe(
    Effect.provide(testLayer({ apple: fakeApple({}), vad: loudnessVad({ count: 0 }) })),
    Effect.scoped,
  ),
);

it.effect("sessions fall back to a manual stop without hands-free or a detector", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const manual = yield* service.start({});
    assert.strictEqual(manual.handsFree, false);
    const result = yield* service.append({ sessionId: manual.sessionId, seq: 0, pcm: pcm(1) });
    assert.deepStrictEqual([result.speaking, result.endOfTurn], [false, false]);
    yield* service.cancel({ sessionId: manual.sessionId });
  }).pipe(
    Effect.provide(testLayer({ apple: fakeApple({}), vad: loudnessVad({ count: 0 }) })),
    Effect.scoped,
  ),
);

it.effect("asking for hands-free where no detector is installed starts a manual session", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    assert.strictEqual((yield* service.start({ handsFree: true })).handsFree, false);
  }).pipe(Effect.provide(testLayer({ apple: fakeApple({}) })), Effect.scoped),
);

const heard: number[] = [];

/** A Smart Turn stand-in that always gives `probability`, and records how much audio it was shown. */
const fakeSmartTurn = (
  probability: number,
  heard: number[] = [],
): SmartTurn.SmartTurn["Service"] => ({
  open: Effect.succeed({
    probability: (audio) =>
      Effect.sync(() => {
        heard.push(audio.length);
        return probability;
      }),
  }),
});

/** Appends 100 ms silent chunks until the turn ends; returns how many it took, or null. */
const silenceUntilEnd = Effect.fnUntraced(function* (
  append: (seconds: number, value: number) => Effect.Effect<{ endOfTurn: boolean }, DictationError>,
  limit: number,
) {
  // oxlint-disable-next-line t3code/no-polling-loop-in-tests -- bounded chunk feed whose count is the assertion; one yield per chunk stands in for the network time a forked verdict takes
  for (let index = 1; index <= limit; index++) {
    const result = yield* append(0.1, 0);
    if (result.endOfTurn) return index;
    // Let the forked verdict land before the next chunk, as network time would.
    yield* Effect.yieldNow;
  }
  return null;
});

it.effect("Smart Turn ends a finished turn before the fixed silence window", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const { sessionId } = yield* service.start({ handsFree: true });
    let seq = 0;
    const append = (seconds: number, value: number) =>
      service.append({ sessionId, seq: seq++, pcm: pcm(seconds, value) });
    yield* append(1, 0.3);
    const chunks = yield* silenceUntilEnd(append, 30);
    assert.isNotNull(chunks);
    // Fixed silence would need END_OF_TURN_SILENCE_MS minus the detector's lag.
    assert.isBelow(chunks! * 100, END_OF_TURN_SILENCE_MS - VAD_REPORT_LAG_MS);
    // The model saw the turn so far, speech included.
    assert.isAtLeast(heard[0]!, 16000);
    yield* service.cancel({ sessionId });
  }).pipe(
    Effect.provide(
      testLayer({
        apple: fakeApple({}),
        vad: loudnessVad({ count: 0 }),
        smartTurn: fakeSmartTurn(0.9, heard),
      }),
    ),
    Effect.scoped,
  ),
);

it.effect("Smart Turn holds a mid-thought pause open until the longer cap", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const { sessionId } = yield* service.start({ handsFree: true });
    let seq = 0;
    const append = (seconds: number, value: number) =>
      service.append({ sessionId, seq: seq++, pcm: pcm(seconds, value) });
    yield* append(1, 0.3);
    const chunks = yield* silenceUntilEnd(append, 40);
    assert.isNotNull(chunks);
    assert.isAbove(chunks! * 100, END_OF_TURN_SILENCE_MS);
    assert.isAtMost(chunks! * 100, TURN_MAX_SILENCE_MS);
    yield* service.cancel({ sessionId });
  }).pipe(
    Effect.provide(
      testLayer({
        apple: fakeApple({}),
        vad: loudnessVad({ count: 0 }),
        smartTurn: fakeSmartTurn(0.1),
      }),
    ),
    Effect.scoped,
  ),
);

it.effect("while a reply plays, only clear and sustained speech counts as talking over it", () =>
  Effect.gen(function* () {
    const service = yield* Dictation.Dictation;
    const { sessionId } = yield* service.start({ handsFree: true });
    let seq = 0;
    const append = (value: number, playback: boolean) =>
      service.append({ sessionId, seq: seq++, pcm: pcm(0.1, value), playback });
    // Echo-level audio through a whole reply never starts the turn.
    for (let index = 0; index < 30; index++) assert.isFalse((yield* append(0.1, true)).speaking);
    // A short clear burst does not either.
    assert.isFalse((yield* append(0.3, true)).speaking);
    assert.isFalse((yield* append(0, true)).speaking);
    // Clear speech that lasts does.
    const heard: boolean[] = [];
    for (let index = 0; index < 4; index++) heard.push((yield* append(0.3, true)).speaking);
    assert.deepStrictEqual(heard, [false, false, true, true]);
    yield* service.cancel({ sessionId });
  }).pipe(
    Effect.provide(testLayer({ apple: fakeApple({}), vad: loudnessVad({ count: 0 }) })),
    Effect.scoped,
  ),
);
