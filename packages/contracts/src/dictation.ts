/**
 * Dictation - speech-to-text for the composer, run by an environment.
 *
 * Clients capture 16 kHz mono int16 PCM and stream it in chunks to the
 * environment they picked while the user speaks. The environment transcribes
 * on device, with Apple's speech recognition on macOS 26+ or an opt-in local
 * model (sherpa-onnx), and returns the text on finish.
 *
 * @module Dictation
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Sample rate every client sends. The server never resamples or decodes containers. */
export const DICTATION_SAMPLE_RATE = 16_000;

/** Matches the client recording cap in `client-runtime/voice-input`. */
export const DICTATION_MAX_SECONDS = 5 * 60;

export const DictationModelId = Schema.Literals(["parakeet-v3", "whisper-turbo", "moonshine-base"]);
export type DictationModelId = typeof DictationModelId.Type;

export const DictationEngine = Schema.Literals(["off", "local"]);
export type DictationEngine = typeof DictationEngine.Type;

/**
 * Which on-device recognizer a "local" engine uses. "apple" is Apple's built-in
 * speech recognition (macOS 26+, nothing to download); an environment without
 * it falls back to "parakeet", the downloadable sherpa-onnx models.
 */
export const DictationLocalEngine = Schema.Literals(["apple", "parakeet"]);
export type DictationLocalEngine = typeof DictationLocalEngine.Type;

/** "auto" lets the model detect the language; otherwise a code from the model's `languageOptions`. */
export const DictationLanguage = TrimmedNonEmptyString;
export type DictationLanguage = typeof DictationLanguage.Type;

/**
 * Server settings for this environment's dictation engine. Selecting a model
 * while the engine is on activates it: the environment downloads what it needs
 * then. Nothing is downloaded before a model is activated.
 */
export const DictationSettings = Schema.Struct({
  engine: DictationEngine.pipe(Schema.withDecodingDefault(Effect.succeed("off" as const))),
  localEngine: DictationLocalEngine.pipe(
    Schema.withDecodingDefault(Effect.succeed("apple" as const)),
  ),
  localModel: DictationModelId.pipe(
    Schema.withDecodingDefault(Effect.succeed("parakeet-v3" as const)),
  ),
  language: DictationLanguage.pipe(Schema.withDecodingDefault(Effect.succeed("auto"))),
});
export type DictationSettings = typeof DictationSettings.Type;

export const DictationSettingsPatch = Schema.Struct({
  engine: Schema.optionalKey(DictationEngine),
  localEngine: Schema.optionalKey(DictationLocalEngine),
  localModel: Schema.optionalKey(DictationModelId),
  language: Schema.optionalKey(DictationLanguage),
});
export type DictationSettingsPatch = typeof DictationSettingsPatch.Type;

/** Install state of one downloadable artifact: the native runtime or a model. */
export const DictationInstallState = Schema.Union([
  Schema.TaggedStruct("not-installed", {}),
  Schema.TaggedStruct("installing", {
    receivedBytes: Schema.Number,
    totalBytes: Schema.Number,
  }),
  Schema.TaggedStruct("installed", { sizeBytes: Schema.Number }),
  Schema.TaggedStruct("failed", { message: Schema.String }),
]);
export type DictationInstallState = typeof DictationInstallState.Type;

const DictationLanguageOption = Schema.Struct({
  code: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
});

/** Apple's on-device speech recognition on this environment. */
export const DictationAppleEngineState = Schema.Struct({
  /** True on macOS 26+ servers whose speech helper runs. */
  available: Schema.Boolean,
  /** Why it is unavailable, when the platform could have it. */
  unavailableReason: Schema.NullOr(Schema.String),
  /** Locale the current language resolves to, or null when Apple does not support it. */
  locale: Schema.NullOr(Schema.String),
  languageOptions: Schema.Array(DictationLanguageOption),
  /** Apple's own on-device language assets, which macOS downloads on first use. */
  assets: DictationInstallState,
});
export type DictationAppleEngineState = typeof DictationAppleEngineState.Type;

const unavailableAppleEngine: DictationAppleEngineState = {
  available: false,
  unavailableReason: null,
  locale: null,
  languageOptions: [],
  assets: { _tag: "not-installed" },
};

/** Server-pushed dictation state for one environment. */
export const DictationState = Schema.Struct({
  /** False when this platform has no on-device engine at all. */
  supported: Schema.Boolean,
  settings: DictationSettings,
  runtime: DictationInstallState,
  models: Schema.Array(
    Schema.Struct({
      id: DictationModelId,
      label: TrimmedNonEmptyString,
      /** Human summary, e.g. "25 European languages". */
      languages: TrimmedNonEmptyString,
      /** Languages this model can be pinned to; empty when it only detects automatically. */
      languageOptions: Schema.Array(DictationLanguageOption),
      /** Short caveat shown next to the model, e.g. that it is slow without a GPU. */
      note: Schema.NullOr(TrimmedNonEmptyString).pipe(
        Schema.withDecodingDefault(Effect.succeed(null)),
      ),
      downloadBytes: Schema.Number,
      install: DictationInstallState,
    }),
  ),
  /** The model currently held in memory, if any. */
  loadedModel: Schema.NullOr(DictationModelId),
  apple: DictationAppleEngineState.pipe(
    Schema.withDecodingDefault(Effect.succeed(unavailableAppleEngine)),
  ),
  /** The recognizer sessions use now: the setting, unless Apple's is unavailable. */
  activeEngine: DictationLocalEngine.pipe(
    Schema.withDecodingDefault(Effect.succeed("parakeet" as const)),
  ),
  /** True when a client can start a session right now (engine on and the active engine installed). */
  ready: Schema.Boolean,
});
export type DictationState = typeof DictationState.Type;

export const DictationSessionId = TrimmedNonEmptyString.pipe(Schema.brand("DictationSessionId"));
export type DictationSessionId = typeof DictationSessionId.Type;

/**
 * Starts or retries installation of the active model; returns before its download completes.
 * With Apple's engine active, it retries Apple's language assets instead.
 */
export const DictationInstallInput = Schema.Struct({ model: DictationModelId });
export type DictationInstallInput = typeof DictationInstallInput.Type;

/** Removes an inactive model. The selected model is retained while the engine is on. */
export const DictationRemoveInput = Schema.Struct({ model: DictationModelId });
export type DictationRemoveInput = typeof DictationRemoveInput.Type;

export const DictationStartInput = Schema.Struct({
  /**
   * Hands-free: the environment listens for the end of the user's turn with a
   * voice activity detector and reports it on each append, so the client can
   * finish without a click. Ignored where the detector is not installed.
   */
  handsFree: Schema.optionalKey(Schema.Boolean),
  /**
   * Hands-free voice mode: the thread this turn talks to. With the Gemini
   * front voice, the environment streams the turn's speech to that thread's
   * live session as it is heard.
   */
  voiceThreadId: Schema.optionalKey(ThreadId),
});
export type DictationStartInput = typeof DictationStartInput.Type;

export const DictationStartResult = Schema.Struct({
  sessionId: DictationSessionId,
  /** True when this session reports `speaking` and `endOfTurn`; false falls back to a manual stop. */
  handsFree: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type DictationStartResult = typeof DictationStartResult.Type;

export const DictationAppendInput = Schema.Struct({
  sessionId: DictationSessionId,
  /** Zero-based chunk index. The server orders chunks by it, so concurrent delivery is safe. */
  seq: NonNegativeInt,
  /** Base64 of little-endian int16 mono PCM at `DICTATION_SAMPLE_RATE`. */
  pcm: Schema.String,
  /**
   * Hands-free sessions: a spoken reply was playing on this client while the
   * chunk was recorded, so its echo may reach the microphone. Speech must then
   * be clearer and longer before it counts as the user talking over the reply.
   */
  playback: Schema.optionalKey(Schema.Boolean),
});
export type DictationAppendInput = typeof DictationAppendInput.Type;

/**
 * What the environment has heard so far, returned by each append so the
 * composer can show words while the user speaks. Provisional: `finish`
 * returns the transcript to insert. Environments without live text return null.
 */
export const DictationAppendResult = Schema.Struct({
  /** Finalized phrases plus the phrase still being spoken; empty before any speech. */
  partial: Schema.String,
  /** Hands-free sessions: true once the user has started speaking. Never goes back to false. */
  speaking: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Hands-free sessions: true once the user stopped speaking long enough to end the turn. */
  endOfTurn: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type DictationAppendResult = typeof DictationAppendResult.Type;

export const DictationFinishInput = Schema.Struct({
  sessionId: DictationSessionId,
  /** Total chunks sent, so the server can wait for stragglers before decoding. */
  chunkCount: NonNegativeInt,
});
export type DictationFinishInput = typeof DictationFinishInput.Type;

export const DictationFinishResult = Schema.Struct({
  text: Schema.String,
  /** BCP 47 tag the transcript is in, used for insertion spacing. */
  locale: Schema.String,
});
export type DictationFinishResult = typeof DictationFinishResult.Type;

export const DictationCancelInput = Schema.Struct({ sessionId: DictationSessionId });
export type DictationCancelInput = typeof DictationCancelInput.Type;

export const DictationErrorReason = Schema.Literals([
  "unsupported-platform",
  "disabled",
  "not-installed",
  "install-failed",
  "load-failed",
  "unknown-session",
  "too-long",
  "transcription-failed",
]);
export type DictationErrorReason = typeof DictationErrorReason.Type;

export class DictationError extends Schema.TaggedError<DictationError>()("DictationError", {
  reason: DictationErrorReason,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
