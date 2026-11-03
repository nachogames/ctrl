/**
 * Speech - text-to-speech for spoken replies, run by an environment with an
 * opt-in local Kokoro voice (sherpa-onnx) that returns 16-bit PCM WAV.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { DictationInstallState } from "./dictation.ts";

/** Kokoro voices offered for spoken replies. */
export const SpeechVoiceId = Schema.Literals([
  "af_heart",
  "af_bella",
  "af_nicole",
  "am_michael",
  "am_fenrir",
  "am_puck",
]);
export type SpeechVoiceId = typeof SpeechVoiceId.Type;

/** Longest text one synthesize call accepts; clients send one sentence at a time. */
const SPEECH_MAX_TEXT_LENGTH = 600;

/**
 * Server settings for this environment's spoken replies. Turning them on
 * downloads the voice model; nothing is downloaded before that.
 */
export const SpeechSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  voice: SpeechVoiceId.pipe(Schema.withDecodingDefault(Effect.succeed("af_heart" as const))),
});
export type SpeechSettings = typeof SpeechSettings.Type;

export const SpeechSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  voice: Schema.optionalKey(SpeechVoiceId),
});
export type SpeechSettingsPatch = typeof SpeechSettingsPatch.Type;

/** Server-pushed spoken-reply state for one environment. */
export const SpeechState = Schema.Struct({
  /** False when this platform has no supported runtime build. */
  supported: Schema.Boolean,
  settings: SpeechSettings,
  /** The sherpa-onnx runtime, shared with local dictation. */
  runtime: DictationInstallState,
  model: Schema.Struct({
    label: TrimmedNonEmptyString,
    downloadBytes: Schema.Number,
    install: DictationInstallState,
  }),
  voices: Schema.Array(Schema.Struct({ id: SpeechVoiceId, label: TrimmedNonEmptyString })),
  /** True while the voice model is held in memory. */
  loaded: Schema.Boolean,
  /** True when a client can synthesize right now (enabled, runtime and model installed). */
  ready: Schema.Boolean,
});
export type SpeechState = typeof SpeechState.Type;

export const SpeechSynthesizeInput = Schema.Struct({
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(SPEECH_MAX_TEXT_LENGTH)),
  /** Defaults to the environment's chosen voice. */
  voice: Schema.optionalKey(SpeechVoiceId),
  /** Playback rate; 1 is normal. */
  speed: Schema.optionalKey(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0.5), Schema.isLessThanOrEqualTo(2)),
  ),
});
export type SpeechSynthesizeInput = typeof SpeechSynthesizeInput.Type;

export const SpeechSynthesizeResult = Schema.Struct({
  /** Base64 of a mono 16-bit PCM WAV file. */
  wav: Schema.String,
  durationMs: Schema.Number,
});
export type SpeechSynthesizeResult = typeof SpeechSynthesizeResult.Type;

export const SpeechErrorReason = Schema.Literals([
  "unsupported-platform",
  "disabled",
  "not-installed",
  "install-failed",
  "load-failed",
  "synthesis-failed",
]);
export type SpeechErrorReason = typeof SpeechErrorReason.Type;

export class SpeechError extends Schema.TaggedError<SpeechError>()("SpeechError", {
  reason: SpeechErrorReason,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
