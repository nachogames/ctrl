import * as NodeModule from "node:module";
import { DICTATION_SAMPLE_RATE, DictationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as DictationArtifacts from "./DictationArtifacts.ts";
import {
  BARGE_IN_VAD_THRESHOLD,
  VAD_MIN_SILENCE_MS,
  type VoiceActivityFrame,
} from "./endOfTurn.ts";

interface VadConfig {
  sileroVad: {
    model: string;
    threshold: number;
    minSpeechDuration: number;
    minSilenceDuration: number;
    maxSpeechDuration: number;
    windowSize: number;
  };
  sampleRate: number;
  numThreads: number;
  provider: "cpu";
  debug: number;
}

interface NativeAddon {
  createVoiceActivityDetector(config: VadConfig, bufferSizeInSeconds: number): unknown;
  voiceActivityDetectorAcceptWaveform(handle: unknown, samples: Float32Array): void;
  voiceActivityDetectorIsDetected(handle: unknown): boolean;
  voiceActivityDetectorIsEmpty(handle: unknown): boolean;
  voiceActivityDetectorPop(handle: unknown): void;
}

/** One session's detector. Calls are synchronous and take well under a millisecond per frame. */
export interface VoiceActivityDetector {
  /** Feeds 16 kHz mono samples in recording order; reports whether speech is heard, and how clearly. */
  readonly accept: (samples: Float32Array) => VoiceActivityFrame;
  /** Drop the N-API external handle; its native finalizer owns freeing the model. */
  readonly release: () => void;
}

/** Silero VAD through the sherpa-onnx runtime dictation and spoken replies share. */
export class VoiceActivity extends Context.Service<
  VoiceActivity,
  {
    /** A fresh detector, or null when the runtime or VAD model is not installed here. */
    readonly open: Effect.Effect<VoiceActivityDetector | null>;
  }
>()("t3/dictation/VoiceActivity") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const artifacts = yield* DictationArtifacts.DictationArtifacts;
  const open = Effect.gen(function* () {
    if (!artifacts.supported) return null;
    const { runtime, model } = artifacts.vadPaths;
    const present = yield* fs.exists(model).pipe(Effect.orElseSucceed(() => false));
    if (!present) return null;
    return yield* Effect.try({
      try: (): VoiceActivityDetector => {
        // The pinned addon is the native boundary, with only the methods used here typed locally.
        const addon = NodeModule.createRequire(import.meta.url)(
          path.join(runtime, "sherpa-onnx.node"),
        ) as NativeAddon;
        const create = (threshold: number): unknown =>
          addon.createVoiceActivityDetector(
            {
              sileroVad: {
                model,
                threshold,
                minSpeechDuration: 0.25,
                minSilenceDuration: VAD_MIN_SILENCE_MS / 1000,
                // Long turns stay one segment; the turn detector decides when they end.
                maxSpeechDuration: 60,
                windowSize: 512,
              },
              sampleRate: DICTATION_SAMPLE_RATE,
              numThreads: 1,
              provider: "cpu",
              debug: 0,
            },
            // Seconds of speech the detector buffers; segments are popped as they finish.
            30,
          );
        // A second, stricter detector tells the user's voice from a reply's echo during playback.
        let handles: { normal: unknown; confident: unknown } | null = {
          normal: create(0.5),
          confident: create(BARGE_IN_VAD_THRESHOLD),
        };
        const feed = (handle: unknown, samples: Float32Array) => {
          addon.voiceActivityDetectorAcceptWaveform(handle, samples);
          // Only the detected flag is used; drop finished segments so the buffer never fills.
          while (!addon.voiceActivityDetectorIsEmpty(handle))
            addon.voiceActivityDetectorPop(handle);
          return addon.voiceActivityDetectorIsDetected(handle);
        };
        return {
          accept: (samples) => {
            if (handles === null) return { detected: false, confident: false };
            return {
              detected: feed(handles.normal, samples),
              confident: feed(handles.confident, samples),
            };
          },
          release: () => {
            handles = null;
          },
        };
      },
      catch: (cause) =>
        new DictationError({
          reason: "load-failed",
          message: "Could not load the voice activity detector.",
          cause,
        }),
    }).pipe(
      // Without a detector the session still works; the user stops it by hand.
      Effect.catchTags({
        DictationError: (error) =>
          Effect.logWarning(error.message).pipe(
            Effect.annotateLogs({ cause: String(error.cause) }),
            Effect.as(null),
          ),
      }),
    );
  });
  return VoiceActivity.of({ open });
});

export const layer = Layer.effect(VoiceActivity, make);

/** No detector: sessions fall back to a manual stop. */
export const layerUnavailable = Layer.succeed(VoiceActivity, { open: Effect.succeed(null) });
