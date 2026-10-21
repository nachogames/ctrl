/**
 * Voice front - a small local model that answers a voice turn at once.
 *
 * When a hands-free turn ends, the client asks the environment for a short
 * spoken reply from a small model in LM Studio's local server, then speaks it
 * while the thread's agent works on the same message. The model is told what
 * the thread (or, in Shift's thread, every thread) is doing, says whether it
 * fully answered, and never replaces the message sent to the thread.
 *
 * The optional Gemini engine swaps the local model for a Gemini Live session
 * held by the environment: it hears the turn's speech as the user talks and
 * answers in audio, which the client plays through the same queue. Its API key
 * stays on the environment, and a monthly spend cap hands back to the local
 * model when reached.
 *
 * @module VoiceFront
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** LM Studio's key for Qwen3 4B Instruct 2507, MLX 4-bit (about 2.3 GB). */
export const DEFAULT_VOICE_FRONT_MODEL = "qwen3-4b-instruct-2507-mlx";
export const DEFAULT_VOICE_FRONT_ENDPOINT = "http://127.0.0.1:1234/v1";
/** Models larger than this are refused, so the front voice never holds a large model in memory. */
export const VOICE_FRONT_MAX_MODEL_BYTES = 6 * 1024 ** 3;
/** Longest transcript a front request accepts. */
export const VOICE_FRONT_MAX_TRANSCRIPT_LENGTH = 2_000;

/** Who answers voice turns: the local LM Studio model, or a Gemini Live session. */
export const VoiceFrontEngine = Schema.Literals(["local", "gemini"]);
export type VoiceFrontEngine = typeof VoiceFrontEngine.Type;

/**
 * Gemini Live models the front may use. 3.1 Flash Live is the default; 3.8
 * Live is the fallback and the only one with non-blocking tool calls.
 */
export const GEMINI_LIVE_MODELS = ["gemini-3.1-flash-live-preview", "gemini-3.8-live"] as const;
export const GeminiLiveModel = Schema.Literals(GEMINI_LIVE_MODELS);
export type GeminiLiveModel = typeof GeminiLiveModel.Type;
export const DEFAULT_GEMINI_LIVE_MODEL: GeminiLiveModel = "gemini-3.1-flash-live-preview";
/** Sample rate of the 16-bit mono PCM Gemini Live speaks in. */
export const GEMINI_LIVE_OUTPUT_SAMPLE_RATE = 24_000;
export const DEFAULT_VOICE_FRONT_MONTHLY_CAP_USD = 10;
export const MAX_VOICE_FRONT_MONTHLY_CAP_USD = 1_000;
export const VoiceFrontMonthlyCap = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: MAX_VOICE_FRONT_MONTHLY_CAP_USD }),
);
/** Longest API key the environment stores. */
export const GEMINI_API_KEY_MAX_LENGTH = 256;

/** Server settings for the front voice. Off by default; nothing is loaded until a voice turn asks. */
export const VoiceFrontSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** The only model Ctrl ever asks LM Studio for. */
  model: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_VOICE_FRONT_MODEL)),
  ),
  /** LM Studio's OpenAI-compatible base URL. */
  endpoint: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_VOICE_FRONT_ENDPOINT)),
  ),
  engine: VoiceFrontEngine.pipe(Schema.withDecodingDefault(Effect.succeed("local" as const))),
  geminiModel: GeminiLiveModel.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_GEMINI_LIVE_MODEL)),
  ),
  /** Gemini stops for the rest of the calendar month once its metered spend reaches this, in USD. */
  monthlyCapUsd: VoiceFrontMonthlyCap.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_VOICE_FRONT_MONTHLY_CAP_USD)),
  ),
});
export type VoiceFrontSettings = typeof VoiceFrontSettings.Type;

export const VoiceFrontSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  endpoint: Schema.optionalKey(TrimmedNonEmptyString),
  engine: Schema.optionalKey(VoiceFrontEngine),
  geminiModel: Schema.optionalKey(GeminiLiveModel),
  monthlyCapUsd: Schema.optionalKey(VoiceFrontMonthlyCap),
});
export type VoiceFrontSettingsPatch = typeof VoiceFrontSettingsPatch.Type;

export const VoiceFrontRespondInput = Schema.Struct({
  threadId: ThreadId,
  transcript: TrimmedNonEmptyString.check(Schema.isMaxLength(VOICE_FRONT_MAX_TRANSCRIPT_LENGTH)),
  /** Unique per voice turn, so two turns with the same words are two requests. */
  turnId: TrimmedNonEmptyString,
});
export type VoiceFrontRespondInput = typeof VoiceFrontRespondInput.Type;

/**
 * The reply so far. `text` carries all of it, so a client may skip text
 * updates; `audio` carries only chunks new since the previous update, so a
 * client that batches updates must merge them with `mergeVoiceFrontReplies`.
 */
export const VoiceFrontReply = Schema.Struct({
  /** Plain spoken text, one or two sentences. Empty for a reply spoken as audio. */
  text: Schema.String,
  /** Gemini only: base64 16-bit mono PCM at `GEMINI_LIVE_OUTPUT_SAMPLE_RATE`, in playing order. */
  audio: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The user talked over the reply; stop playing it. Comes with `done`. */
  interrupted: Schema.optionalKey(Schema.Boolean),
  done: Schema.Boolean,
  /** The front fully answered; the agent's reply need not be read aloud. Final once `done`. */
  answered: Schema.Boolean,
  /** Milliseconds from the request to the model's first token, once it arrived. */
  firstTokenMs: Schema.NullOr(Schema.Number),
});
export type VoiceFrontReply = typeof VoiceFrontReply.Type;

/** One update holding everything `earlier` and `later` say, `later` winning for the text. */
export function mergeVoiceFrontReplies(
  earlier: VoiceFrontReply,
  later: VoiceFrontReply,
): VoiceFrontReply {
  const audio = [...(earlier.audio ?? []), ...(later.audio ?? [])];
  const interrupted = earlier.interrupted === true || later.interrupted === true;
  return {
    ...later,
    done: earlier.done || later.done,
    firstTokenMs: later.firstTokenMs ?? earlier.firstTokenMs,
    ...(audio.length > 0 ? { audio } : {}),
    ...(interrupted ? { interrupted } : {}),
  };
}

/** Stores, or with null removes, the environment's Gemini API key. It is never sent back. */
export const VoiceFrontSetGeminiKeyInput = Schema.Struct({
  key: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(GEMINI_API_KEY_MAX_LENGTH))),
});
export type VoiceFrontSetGeminiKeyInput = typeof VoiceFrontSetGeminiKeyInput.Type;

/** Hands-free voice ended in this thread: close its Gemini session, so nothing stays open. */
export const VoiceFrontEndInput = Schema.Struct({ threadId: ThreadId });
export type VoiceFrontEndInput = typeof VoiceFrontEndInput.Type;

/** What settings show about the Gemini engine. Never the key itself. */
export const VoiceFrontGeminiStatus = Schema.Struct({
  keySet: Schema.Boolean,
  /** Metered spend this calendar month, in USD. */
  monthSpendUsd: Schema.Number,
  monthlyCapUsd: Schema.Number,
  /** The cap is reached; the local front answers until next month. */
  capped: Schema.Boolean,
  /** Why Gemini last failed, until it works again. */
  problem: Schema.NullOr(Schema.String),
});
export type VoiceFrontGeminiStatus = typeof VoiceFrontGeminiStatus.Type;

/** What the settings page shows about the front voice on one environment. */
export const VoiceFrontStatus = Schema.Struct({
  settings: VoiceFrontSettings,
  /** Problem that stops the front voice right now, or null when it can answer. */
  problem: Schema.NullOr(Schema.String),
  /** Size of the configured model on disk, when LM Studio reports it. */
  modelBytes: Schema.NullOr(Schema.Number),
  maxModelBytes: Schema.Number,
  gemini: VoiceFrontGeminiStatus,
});
export type VoiceFrontStatus = typeof VoiceFrontStatus.Type;

export const VoiceFrontErrorReason = Schema.Literals([
  "disabled",
  "lm-studio-missing",
  "server-unavailable",
  "model-missing",
  "model-too-large",
  "generation-failed",
  "key-store-failed",
]);
export type VoiceFrontErrorReason = typeof VoiceFrontErrorReason.Type;

export class VoiceFrontError extends Schema.TaggedError<VoiceFrontError>()("VoiceFrontError", {
  reason: VoiceFrontErrorReason,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
