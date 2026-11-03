import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import { SpeechError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as DictationArtifacts from "../dictation/DictationArtifacts.ts";
import { speechModel } from "../dictation/models.ts";

interface OfflineTtsConfig {
  model: ReturnType<typeof speechModel.config> & {
    numThreads: number;
    provider: "cpu";
    debug: number;
  };
  maxNumSentences: number;
}

interface NativeAddon {
  createOfflineTtsAsync(config: OfflineTtsConfig): Promise<unknown>;
  offlineTtsGenerateAsync(
    handle: unknown,
    request: { text: string; sid: number; speed: number; enableExternalBuffer: boolean },
  ): Promise<{ samples: Float32Array; sampleRate: number }>;
}

export interface Voice {
  /** Synthesizes one short chunk of text as mono float samples. */
  readonly generate: (input: {
    readonly text: string;
    readonly speaker: number;
    readonly speed: number;
  }) => Effect.Effect<{ samples: Float32Array; sampleRate: number }, SpeechError>;
  /** Drop the N-API external handle; its native finalizer owns freeing model memory. */
  readonly release: Effect.Effect<void>;
}

export class SpeechSynthesizer extends Context.Service<
  SpeechSynthesizer,
  { readonly load: Effect.Effect<Voice, SpeechError> }
>()("t3/speech/SpeechSynthesizer") {}

const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const artifacts = yield* DictationArtifacts.DictationArtifacts;
  const load = Effect.gen(function* () {
    const locations = artifacts.speechPaths;
    const addon = yield* Effect.try({
      // The pinned addon is the native boundary, with only the methods used here typed locally.
      try: () =>
        NodeModule.createRequire(import.meta.url)(
          path.join(locations.runtime, "sherpa-onnx.node"),
        ) as NativeAddon,
      catch: (cause) =>
        new SpeechError({
          reason: "load-failed",
          message: "Could not load the speech runtime.",
          cause,
        }),
    });
    let handle: unknown = yield* Effect.tryPromise({
      try: () =>
        addon.createOfflineTtsAsync({
          model: {
            ...speechModel.config((name) => path.join(locations.model, name)),
            numThreads: Math.min(4, Math.max(1, NodeOS.availableParallelism())),
            provider: "cpu",
            debug: 0,
          },
          maxNumSentences: 1,
        }),
      catch: (cause) =>
        new SpeechError({
          reason: "load-failed",
          message: "Could not load the voice model.",
          cause,
        }),
    });
    return {
      generate: ({ text, speaker, speed }) =>
        Effect.tryPromise({
          try: () =>
            addon.offlineTtsGenerateAsync(handle, {
              text,
              sid: speaker,
              speed,
              enableExternalBuffer: false,
            }),
          catch: (cause) =>
            new SpeechError({
              reason: "synthesis-failed",
              message: "Could not synthesize speech.",
              cause,
            }),
        }),
      release: Effect.sync(() => {
        handle = null;
      }),
    } satisfies Voice;
  });
  return SpeechSynthesizer.of({ load });
});

export const layer = Layer.effect(SpeechSynthesizer, make);
