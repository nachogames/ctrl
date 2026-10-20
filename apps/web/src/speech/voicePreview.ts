import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, SpeechVoiceId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { speechEnvironment } from "../state/speech";
import { decodeBase64 } from "./replySpeaker";

const SAMPLE = "Hey, it's Shift. The PayParty build finished, and two things need you.";
/** Decoded samples kept so replaying a voice is instant; a handful covers every voice. */
const CACHE_LIMIT = 12;

/**
 * Plays a short sample of a Kokoro voice in settings. One preview plays at a
 * time: starting another or calling `stop` silences the current one.
 */
class VoicePreview {
  #context: AudioContext | null = null;
  #cache = new Map<string, AudioBuffer>();
  #source: AudioBufferSourceNode | null = null;
  #generation = 0;
  /** `${environmentId}:${voice}` while that preview is loading or playing. */
  #playing: string | null = null;
  #listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  readonly playing = () => this.#playing;

  #set(playing: string | null) {
    if (this.#playing === playing) return;
    this.#playing = playing;
    for (const listener of this.#listeners) listener();
  }

  stop() {
    this.#generation++;
    if (this.#source) {
      this.#source.onended = null;
      this.#source.stop();
      this.#source = null;
    }
    this.#set(null);
  }

  /** Resolves false when the sample could not be synthesized or decoded. */
  async play(input: {
    readonly registry: AtomRegistry.AtomRegistry;
    readonly environmentId: EnvironmentId;
    readonly voice: SpeechVoiceId;
  }): Promise<boolean> {
    this.stop();
    const key = `${input.environmentId}:${input.voice}`;
    const generation = this.#generation;
    this.#set(key);
    // Created inside the click, so the browser lets it play once the sample arrives.
    this.#context ??= new AudioContext();
    const context = this.#context;
    if (context.state === "suspended") void context.resume();
    let buffer = this.#cache.get(key) ?? null;
    if (buffer === null) {
      const result = await runAtomCommand(
        input.registry,
        speechEnvironment.synthesize,
        { environmentId: input.environmentId, input: { text: SAMPLE, voice: input.voice } },
        { reportFailure: false },
      );
      if (result._tag === "Success")
        buffer = await context.decodeAudioData(decodeBase64(result.value.wav)).catch(() => null);
      if (buffer !== null) {
        this.#cache.set(key, buffer);
        if (this.#cache.size > CACHE_LIMIT) this.#cache.delete(this.#cache.keys().next().value!);
      }
    }
    if (generation !== this.#generation) return true;
    if (buffer === null) {
      this.#set(null);
      return false;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      if (this.#source === source) this.#source = null;
      if (generation === this.#generation) this.#set(null);
    };
    this.#source = source;
    source.start();
    return true;
  }
}

export const voicePreview = new VoicePreview();

/** The `${environmentId}:${voice}` preview loading or playing now, if any. */
export function useVoicePreviewPlaying() {
  return useSyncExternalStore(voicePreview.subscribe, voicePreview.playing);
}
