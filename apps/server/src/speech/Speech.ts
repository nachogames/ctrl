import {
  SpeechError,
  type DictationInstallState,
  type SpeechState,
  type SpeechSynthesizeInput,
  type SpeechSynthesizeResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as DictationArtifacts from "../dictation/DictationArtifacts.ts";
import { speechModel } from "../dictation/models.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SpeechSynthesizer from "./SpeechSynthesizer.ts";
import { encodeWav } from "./wav.ts";

/** The voice model is released after this long without a synthesize call. */
export const SPEECH_IDLE_UNLOAD_MS = 10 * 60_000;

export class Speech extends Context.Service<
  Speech,
  {
    readonly state: Effect.Effect<SpeechState>;
    readonly stateStream: Stream.Stream<SpeechState>;
    /** Starts or retries the voice model download; returns before it completes. */
    readonly install: Effect.Effect<void, SpeechError>;
    /** Deletes the voice model while spoken replies are off. */
    readonly remove: Effect.Effect<void, SpeechError>;
    readonly synthesize: (
      input: SpeechSynthesizeInput,
    ) => Effect.Effect<SpeechSynthesizeResult, SpeechError>;
  }
>()("t3/speech/Speech") {}

const toSpeechError = (error: { readonly reason: string; readonly message: string }) =>
  new SpeechError({
    reason: error.reason === "unsupported-platform" ? "unsupported-platform" : "install-failed",
    message: error.message,
  });

const make = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const settings = yield* ServerSettings.ServerSettingsService;
  const artifacts = yield* DictationArtifacts.DictationArtifacts;
  const synthesizer = yield* SpeechSynthesizer.SpeechSynthesizer;
  const settingsChanges = yield* settings.subscribeChanges;
  const readSettings = settings.getSettings.pipe(
    Effect.map((current) => current.speech),
    Effect.mapError(
      (cause) =>
        new SpeechError({ reason: "disabled", message: "Could not read speech settings.", cause }),
    ),
  );
  // An unreadable state directory must not stop the server from starting; it reads as not installed.
  const inspect = artifacts.inspectSpeech.pipe(
    Effect.orElseSucceed(() => ({
      runtime: { _tag: "not-installed" } satisfies DictationInstallState,
      model: { _tag: "not-installed" } satisfies DictationInstallState,
    })),
  );
  const installed = yield* inspect;
  const state = yield* SubscriptionRef.make<SpeechState>({
    supported: artifacts.supported,
    settings: yield* readSettings,
    runtime: installed.runtime,
    model: {
      label: speechModel.label,
      downloadBytes: speechModel.files.reduce((total, file) => total + file.bytes, 0),
      install: installed.model,
    },
    voices: Object.entries(speechModel.voices).map(([id, voice]) => ({
      id: id as keyof typeof speechModel.voices,
      label: voice.label,
    })),
    loaded: false,
    ready: false,
  });
  const update = (change: (current: SpeechState) => SpeechState) =>
    SubscriptionRef.update(state, (current) => {
      const next = change(current);
      return {
        ...next,
        ready:
          next.supported &&
          next.settings.enabled &&
          next.runtime._tag === "installed" &&
          next.model.install._tag === "installed",
      };
    });
  yield* update((current) => current);

  // Native calls cannot be cancelled; loading, synthesis and release take turns on this permit.
  const native = yield* Semaphore.make(1);
  const lifecycle = yield* Semaphore.make(1);
  let voice: SpeechSynthesizer.Voice | null = null;
  let lastUse = yield* Clock.currentTimeMillis;
  let installing: { fiber: Fiber.Fiber<void> | null } | null = null;

  const unload = native.withPermit(
    Effect.gen(function* () {
      const previous = voice;
      voice = null;
      if (previous) yield* previous.release;
      yield* update((current) => ({ ...current, loaded: false }));
    }),
  );
  const progress = (artifact: "runtime" | "speech", install: DictationInstallState) =>
    update((current) =>
      artifact === "runtime"
        ? { ...current, runtime: install }
        : { ...current, model: { ...current.model, install } },
    );
  const refresh = Effect.gen(function* () {
    const snapshot = yield* inspect;
    yield* update((current) => ({
      ...current,
      runtime: snapshot.runtime,
      model: { ...current.model, install: snapshot.model },
    }));
  });
  const stopInstallation = Effect.gen(function* () {
    const previous = installing;
    installing = null;
    if (!previous) return;
    if (previous.fiber) yield* Fiber.interrupt(previous.fiber);
    yield* refresh;
  });
  const beginInstallation = Effect.fnUntraced(function* (retry: boolean) {
    const current = yield* SubscriptionRef.get(state);
    if (!current.supported || !current.settings.enabled || installing) return;
    if (current.runtime._tag === "installed" && current.model.install._tag === "installed") return;
    if (!retry && (current.runtime._tag === "failed" || current.model.install._tag === "failed"))
      return;
    const job: { fiber: Fiber.Fiber<void> | null } = { fiber: null };
    const fail = (message: string) =>
      update((current) =>
        installing !== job
          ? current
          : {
              ...current,
              runtime:
                current.runtime._tag === "installed"
                  ? current.runtime
                  : { _tag: "failed", message },
              model: { ...current.model, install: { _tag: "failed", message } },
            },
      );
    installing = job;
    job.fiber = yield* artifacts
      .installSpeech((artifact, value) =>
        Effect.suspend(() => (installing === job ? progress(artifact, value) : Effect.void)),
      )
      .pipe(
        Effect.catchTags({ DictationError: (error) => fail(error.message) }),
        Effect.catchCause(() => fail("Voice model installation failed.")),
        Effect.ensuring(
          Effect.sync(() => {
            if (installing === job) installing = null;
          }),
        ),
        Effect.forkIn(scope),
      );
  }, Effect.uninterruptible);

  const reconcile = Effect.gen(function* () {
    const next = yield* readSettings;
    const before = yield* SubscriptionRef.get(state);
    if (before.settings.enabled && !next.enabled) {
      yield* stopInstallation;
      yield* unload;
    }
    if (before.settings.enabled !== next.enabled || before.settings.voice !== next.voice) {
      yield* update((current) => ({
        ...current,
        settings: next,
        // Turning spoken replies back on retries a failed download.
        ...(next.enabled && !before.settings.enabled
          ? {
              runtime:
                current.runtime._tag === "failed" ? { _tag: "not-installed" } : current.runtime,
              model: {
                ...current.model,
                install:
                  current.model.install._tag === "failed"
                    ? { _tag: "not-installed" }
                    : current.model.install,
              },
            }
          : {}),
      }));
    }
    yield* beginInstallation(false);
  }).pipe(Effect.uninterruptible, lifecycle.withPermit);

  yield* settingsChanges.pipe(
    Stream.runForEach(() =>
      reconcile.pipe(
        Effect.catchTags({
          SpeechError: () => Effect.logWarning("Could not reconcile speech settings."),
        }),
      ),
    ),
    Effect.forkIn(scope),
  );

  const install = Effect.gen(function* () {
    yield* reconcile;
    const current = yield* SubscriptionRef.get(state);
    if (!current.supported)
      return yield* new SpeechError({
        reason: "unsupported-platform",
        message: "Spoken replies are unavailable on this platform.",
      });
    if (!current.settings.enabled)
      return yield* new SpeechError({
        reason: "disabled",
        message: "Turn on spoken replies before downloading the voice.",
      });
    yield* beginInstallation(true).pipe(lifecycle.withPermit);
  });

  const remove = Effect.gen(function* () {
    yield* reconcile;
    yield* lifecycle.withPermit(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (current.settings.enabled)
          return yield* new SpeechError({
            reason: "disabled",
            message: "Turn off spoken replies before removing the voice.",
          });
        yield* unload;
        // The released handle must be gone before its files are deleted.
        yield* native
          .withPermit(artifacts.removeSpeech)
          .pipe(Effect.mapError(toSpeechError), Effect.ensuring(refresh));
      }),
    );
  }).pipe(Effect.uninterruptible);

  const synthesize = Effect.fnUntraced(function* (input: SpeechSynthesizeInput) {
    let current = yield* SubscriptionRef.get(state);
    if (!current.supported)
      return yield* new SpeechError({
        reason: "unsupported-platform",
        message: "Spoken replies are unavailable on this platform.",
      });
    if (!current.settings.enabled)
      return yield* new SpeechError({
        reason: "disabled",
        message: "Turn on spoken replies in environment settings.",
      });
    if (!current.ready && !installing) {
      // Dictation may have installed the shared runtime since this state was read.
      yield* refresh;
      current = yield* SubscriptionRef.get(state);
    }
    if (!current.ready)
      return yield* new SpeechError({
        reason: "not-installed",
        message: "The voice model is not downloaded yet.",
      });
    const speaker = speechModel.voices[input.voice ?? current.settings.voice].speaker;
    const audio = yield* native.withPermit(
      Effect.gen(function* () {
        lastUse = yield* Clock.currentTimeMillis;
        if (!voice) {
          voice = yield* synthesizer.load;
          yield* update((current) => ({ ...current, loaded: true }));
        }
        return yield* voice.generate({ text: input.text, speaker, speed: input.speed ?? 1 });
      }).pipe(Effect.uninterruptible),
    );
    lastUse = yield* Clock.currentTimeMillis;
    return {
      wav: Buffer.from(encodeWav(audio.samples, audio.sampleRate)).toString("base64"),
      durationMs: Math.round((audio.samples.length / audio.sampleRate) * 1000),
    };
  });

  yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (voice && now - lastUse >= SPEECH_IDLE_UNLOAD_MS) yield* unload;
  }).pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkIn(scope));
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const previous = voice;
      voice = null;
      if (previous) yield* previous.release;
    }),
  );
  yield* reconcile.pipe(Effect.catchTags({ SpeechError: () => Effect.void }));

  return Speech.of({
    state: SubscriptionRef.get(state),
    stateStream: SubscriptionRef.changes(state),
    install,
    remove,
    synthesize,
  });
});

export const layer = Layer.effect(Speech, make);
