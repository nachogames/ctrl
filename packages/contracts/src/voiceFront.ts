/**
 * Voice front - a small local model that answers a voice turn at once.
 *
 * When a hands-free turn ends, the client asks the environment for a short
 * spoken reply from a small model in LM Studio's local server, then speaks it
 * while the thread's agent works on the same message. The model is told what
 * the thread (or, in Shift's thread, every thread) is doing, says whether it
 * fully answered, and never replaces the message sent to the thread.
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
});
export type VoiceFrontSettings = typeof VoiceFrontSettings.Type;

export const VoiceFrontSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  endpoint: Schema.optionalKey(TrimmedNonEmptyString),
});
export type VoiceFrontSettingsPatch = typeof VoiceFrontSettingsPatch.Type;

export const VoiceFrontRespondInput = Schema.Struct({
  threadId: ThreadId,
  transcript: TrimmedNonEmptyString.check(Schema.isMaxLength(VOICE_FRONT_MAX_TRANSCRIPT_LENGTH)),
  /** Unique per voice turn, so two turns with the same words are two requests. */
  turnId: TrimmedNonEmptyString,
});
export type VoiceFrontRespondInput = typeof VoiceFrontRespondInput.Type;

/** The reply so far. Each update carries all of it, so a client may skip updates. */
export const VoiceFrontReply = Schema.Struct({
  /** Plain spoken text, one or two sentences. */
  text: Schema.String,
  done: Schema.Boolean,
  /** The front fully answered; the agent's reply need not be read aloud. Final once `done`. */
  answered: Schema.Boolean,
  /** Milliseconds from the request to the model's first token, once it arrived. */
  firstTokenMs: Schema.NullOr(Schema.Number),
});
export type VoiceFrontReply = typeof VoiceFrontReply.Type;

/** What the settings page shows about the front voice on one environment. */
export const VoiceFrontStatus = Schema.Struct({
  settings: VoiceFrontSettings,
  /** Problem that stops the front voice right now, or null when it can answer. */
  problem: Schema.NullOr(Schema.String),
  /** Size of the configured model on disk, when LM Studio reports it. */
  modelBytes: Schema.NullOr(Schema.Number),
  maxModelBytes: Schema.Number,
});
export type VoiceFrontStatus = typeof VoiceFrontStatus.Type;

export const VoiceFrontErrorReason = Schema.Literals([
  "disabled",
  "lm-studio-missing",
  "server-unavailable",
  "model-missing",
  "model-too-large",
  "generation-failed",
]);
export type VoiceFrontErrorReason = typeof VoiceFrontErrorReason.Type;

export class VoiceFrontError extends Schema.TaggedError<VoiceFrontError>()("VoiceFrontError", {
  reason: VoiceFrontErrorReason,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
