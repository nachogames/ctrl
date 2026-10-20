import { assert, it } from "@effect/vitest";
import type {
  DictationInstallState,
  ServerSettings as Settings,
  SpeechState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as DictationArtifacts from "../dictation/DictationArtifacts.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Speech from "./Speech.ts";
import * as SpeechSynthesizer from "./SpeechSynthesizer.ts";

interface Engine {
  loads: number;
  releases: number;
  removed: number;
  requests: { text: string; speaker: number; speed: number }[];
}

const testLayer = (
  engine: Engine,
  options: { enabled?: boolean; installed?: boolean; supported?: boolean } = {},
) =>
  Speech.layer.pipe(
    Layer.provide(
      Layer.sync(DictationArtifacts.DictationArtifacts, () => {
        let runtime: DictationInstallState =
          options.installed === false
            ? { _tag: "not-installed" }
            : { _tag: "installed", sizeBytes: 1 };
        let model = runtime;
        return {
          supported: options.supported ?? true,
          paths: () => ({ runtime: "/unused", model: "/unused" }),
          inspect: Effect.sync(() => ({ runtime, models: new Map() })),
          install: () => Effect.void,
          remove: () => Effect.void,
          speechPaths: { runtime: "/unused", model: "/unused" },
          vadPaths: { runtime: "/unused", model: "/unused" },
          inspectSpeech: Effect.sync(() => ({ runtime, model })),
          installSpeech: (progress) =>
            Effect.gen(function* () {
              runtime = { _tag: "installed", sizeBytes: 1 };
              yield* progress("runtime", runtime);
              yield* progress("speech", { _tag: "installing", receivedBytes: 1, totalBytes: 2 });
              model = { _tag: "installed", sizeBytes: 2 };
              yield* progress("speech", model);
            }),
          removeSpeech: Effect.sync(() => {
            engine.removed++;
            model = { _tag: "not-installed" };
          }),
        } satisfies DictationArtifacts.DictationArtifacts["Service"];
      }),
    ),
    Layer.provide(
      Layer.succeed(SpeechSynthesizer.SpeechSynthesizer, {
        load: Effect.sync((): SpeechSynthesizer.Voice => {
          engine.loads++;
          return {
            generate: (request) =>
              Effect.sync(() => {
                engine.requests.push(request);
                return { samples: new Float32Array([0, 0.5, -1, 1]), sampleRate: 4 };
              }),
            release: Effect.sync(() => {
              engine.releases++;
            }),
          };
        }),
      }),
    ),
    Layer.provideMerge(
      Layer.effect(
        ServerSettings.ServerSettingsService,
        Effect.gen(function* () {
          const original = yield* ServerSettings.ServerSettingsService;
          const changes = yield* PubSub.unbounded<Settings>();
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
            speech: { enabled: options.enabled ?? true, voice: "af_heart" },
          }),
        ),
      ),
    ),
  );

const newEngine = (): Engine => ({ loads: 0, releases: 0, removed: 0, requests: [] });

const waitFor = (predicate: (state: SpeechState) => boolean) =>
  Effect.gen(function* () {
    const service = yield* Speech.Speech;
    return yield* service.stateStream.pipe(Stream.filter(predicate), Stream.runHead);
  });

it.effect("gates synthesis on platform, settings and the downloaded voice", () =>
  Effect.gen(function* () {
    for (const [options, reason] of [
      [{ supported: false }, "unsupported-platform"],
      [{ enabled: false }, "disabled"],
      [{ enabled: false, installed: false }, "disabled"],
    ] as const) {
      const error = yield* Effect.gen(function* () {
        return yield* (yield* Speech.Speech).synthesize({ text: "Hi." }).pipe(Effect.flip);
      }).pipe(Effect.provide(testLayer(newEngine(), options)), Effect.scoped);
      assert.strictEqual(error.reason, reason);
    }
  }),
);

it.effect("turning spoken replies on downloads the voice", () => {
  const engine = newEngine();
  return Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    assert.isFalse((yield* (yield* Speech.Speech).state).ready);
    yield* settings.updateSettings({ speech: { enabled: true } });
    yield* waitFor((state) => state.ready);
    const state = yield* (yield* Speech.Speech).state;
    assert.deepStrictEqual(state.model.install, { _tag: "installed", sizeBytes: 2 });
    assert.strictEqual(engine.loads, 0, "the model loads on first use, not on download");
  }).pipe(Effect.provide(testLayer(engine, { enabled: false, installed: false })), Effect.scoped);
});

it.effect("synthesizes WAV with the chosen voice and keeps the model loaded", () => {
  const engine = newEngine();
  return Effect.gen(function* () {
    const speech = yield* Speech.Speech;
    const first = yield* speech.synthesize({ text: "Hey there." });
    yield* speech.synthesize({ text: "Second.", voice: "am_michael", speed: 1.2 });
    assert.strictEqual(engine.loads, 1);
    assert.deepStrictEqual(engine.requests, [
      { text: "Hey there.", speaker: 3, speed: 1 },
      { text: "Second.", speaker: 16, speed: 1.2 },
    ]);
    const wav = Buffer.from(first.wav, "base64");
    assert.strictEqual(wav.toString("ascii", 0, 4), "RIFF");
    assert.strictEqual(wav.readUInt32LE(24), 4);
    assert.deepStrictEqual(
      [0, 1, 2, 3].map((index) => wav.readInt16LE(44 + index * 2)),
      [0, 16384, -32768, 32767],
    );
    assert.strictEqual(first.durationMs, 1000);
    assert.isTrue((yield* speech.state).loaded);
  }).pipe(Effect.provide(testLayer(engine)), Effect.scoped);
});

it.effect("releases the model after it sits idle", () => {
  const engine = newEngine();
  return Effect.gen(function* () {
    const speech = yield* Speech.Speech;
    yield* speech.synthesize({ text: "Hello." });
    yield* TestClock.adjust(Speech.SPEECH_IDLE_UNLOAD_MS - 60_000);
    assert.strictEqual(engine.releases, 0);
    yield* TestClock.adjust(90_000);
    assert.strictEqual(engine.releases, 1);
    assert.isFalse((yield* speech.state).loaded);
    yield* speech.synthesize({ text: "Back again." });
    assert.strictEqual(engine.loads, 2);
  }).pipe(Effect.provide(testLayer(engine)), Effect.scoped);
});

it.effect("removes the voice only while spoken replies are off", () => {
  const engine = newEngine();
  return Effect.gen(function* () {
    const speech = yield* Speech.Speech;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* speech.synthesize({ text: "Hello." });
    assert.strictEqual((yield* speech.remove.pipe(Effect.flip)).reason, "disabled");
    assert.strictEqual(engine.removed, 0);
    yield* settings.updateSettings({ speech: { enabled: false } });
    yield* speech.remove;
    assert.strictEqual(engine.removed, 1);
    assert.strictEqual(engine.releases, 1);
    const state = yield* speech.state;
    assert.deepStrictEqual(state.model.install, { _tag: "not-installed" });
    assert.isFalse(state.ready);
  }).pipe(Effect.provide(testLayer(engine)), Effect.scoped);
});
