/**
 * Gemini Live's WebSocket protocol, as far as the front voice uses it. Shapes
 * follow https://ai.google.dev/api/live and the Live API guides (read
 * 2026-10-20); the server's JSON is camelCase.
 */
import type { GeminiLiveModel } from "@t3tools/contracts";

import type { LiveUsage } from "./geminiCost.ts";

export const GEMINI_LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** The key rides in the query string, as the Live API requires. Never log this URL. */
export const liveUrl = (apiKey: string) =>
  `${GEMINI_LIVE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;

/** Replaces anything that looks like the key in a message headed for a log. */
export const redactKey = (text: string) => text.replace(/key=[^&\s"']+/g, "key=***");

/**
 * Context Gemini keeps before it slides older turns out. Every turn is billed
 * for the whole context it sees, so this stays small: about 80 s of audio.
 */
export const CONTEXT_TRIGGER_TOKENS = 4_000;
export const CONTEXT_TARGET_TOKENS = 2_000;

export const TOOL_HAND_OFF = "hand_off";
export const TOOL_CHECK_THREADS = "check_threads";

/** Only 3.8 Live supports non-blocking calls and response scheduling. */
export const supportsAsyncTools = (model: GeminiLiveModel) => model === "gemini-3.8-live";

export function toolDeclarations(model: GeminiLiveModel, worker: string) {
  const async = supportsAsyncTools(model);
  return [
    {
      functionDeclarations: [
        {
          name: TOOL_HAND_OFF,
          description: `Hands this request to ${worker}, who does the work and already has the user's words. Call it whenever the user asks for work to be done, a decision, or facts check_threads does not give you, then say briefly that ${worker} is on it.`,
          ...(async ? { behavior: "NON_BLOCKING" } : {}),
        },
        {
          name: TOOL_CHECK_THREADS,
          description:
            "Returns what the user's threads are doing right now: which are working, finished, or need the user, with their latest replies. Call it before answering any question about them.",
          ...(async ? { behavior: "BLOCKING" } : {}),
        },
      ],
    },
  ];
}

export function setupMessage(input: {
  readonly model: GeminiLiveModel;
  readonly instructions: string;
  readonly worker: string;
  readonly resumeHandle: string | null;
}) {
  return {
    setup: {
      model: `models/${input.model}`,
      generationConfig: { responseModalities: ["AUDIO"] },
      systemInstruction: { parts: [{ text: input.instructions }] },
      tools: toolDeclarations(input.model, input.worker),
      // Ctrl's own detector decides when the user speaks, so only speech is sent and billed.
      realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      contextWindowCompression: {
        triggerTokens: CONTEXT_TRIGGER_TOKENS,
        slidingWindow: { targetTokens: CONTEXT_TARGET_TOKENS },
      },
      sessionResumption: input.resumeHandle === null ? {} : { handle: input.resumeHandle },
      // Transcription is billed as text output, and the local recognizer already writes the turn.
    },
  };
}

export const activityStartMessage = { realtimeInput: { activityStart: {} } };
export const activityEndMessage = { realtimeInput: { activityEnd: {} } };

/** 16 kHz float samples as one `realtimeInput.audio` message. */
export function audioMessage(samples: Float32Array) {
  const bytes = Buffer.allocUnsafe(samples.length * 2);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]!));
    bytes.writeInt16LE(Math.round(sample * 32767), index * 2);
  }
  return {
    realtimeInput: { audio: { data: bytes.toString("base64"), mimeType: "audio/pcm;rate=16000" } },
  };
}

export function toolResponseMessage(
  model: GeminiLiveModel,
  call: { readonly id: string; readonly name: string },
  result: string,
  scheduling: "SILENT" | "WHEN_IDLE" | "INTERRUPT" | null,
) {
  return {
    toolResponse: {
      functionResponses: [
        {
          id: call.id,
          name: call.name,
          response: {
            result,
            ...(scheduling !== null && supportsAsyncTools(model) ? { scheduling } : {}),
          },
        },
      ],
    },
  };
}

export interface LiveFunctionCall {
  readonly id: string;
  readonly name: string;
}

/** One server message, reduced to what the front acts on. */
export interface LiveServerMessage {
  readonly setupComplete: boolean;
  /** Base64 PCM chunks at 24 kHz, in order. */
  readonly audio: ReadonlyArray<string>;
  readonly interrupted: boolean;
  readonly turnComplete: boolean;
  readonly toolCalls: ReadonlyArray<LiveFunctionCall>;
  readonly goAway: boolean;
  /** A handle to resume from; null when this message carries none or the session cannot resume now. */
  readonly resumeHandle: string | null;
  readonly usage: LiveUsage | null;
  /** The server reported an error in the message body. */
  readonly error: string | null;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Reads one message; anything unparseable reads as an empty message. */
export function parseServerMessage(text: string): LiveServerMessage {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = record(JSON.parse(text));
  } catch {
    parsed = null;
  }
  const content = record(parsed?.serverContent);
  const parts = record(content?.modelTurn)?.parts;
  const audio: string[] = [];
  if (Array.isArray(parts))
    for (const part of parts) {
      const inline = record(record(part)?.inlineData);
      if (
        typeof inline?.data === "string" &&
        typeof inline.mimeType === "string" &&
        inline.mimeType.startsWith("audio/pcm")
      )
        audio.push(inline.data);
    }
  const calls = record(parsed?.toolCall)?.functionCalls;
  const toolCalls: LiveFunctionCall[] = [];
  if (Array.isArray(calls))
    for (const call of calls) {
      const entry = record(call);
      if (typeof entry?.id === "string" && typeof entry.name === "string")
        toolCalls.push({ id: entry.id, name: entry.name });
    }
  const resumption = record(parsed?.sessionResumptionUpdate);
  const usage = record(parsed?.usageMetadata);
  const error = record(parsed?.error);
  return {
    setupComplete: parsed?.setupComplete !== undefined,
    audio,
    interrupted: content?.interrupted === true,
    turnComplete: content?.turnComplete === true,
    toolCalls,
    goAway: parsed?.goAway !== undefined,
    resumeHandle:
      resumption?.resumable === true &&
      typeof resumption.newHandle === "string" &&
      resumption.newHandle
        ? resumption.newHandle
        : null,
    usage: usage as LiveUsage | null,
    error: error ? String(error.message ?? "Gemini reported an error.") : null,
  };
}
