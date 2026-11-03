import {
  INITIAL_VOICE_MODE_STATE,
  type VoiceCaption,
  type VoiceLevels,
  type VoiceModeState,
  type VoiceSessionTarget,
} from "@t3tools/client-runtime/voice-mode";

import type { DictationLevel } from "../dictation/dictationLevel";
import { replySpeaker } from "./replySpeaker";

/** The level the speaker meter shows while a reply is read; replies are not metered. */
const REPLY_SPEAKER_LEVEL = 0.35;

// The composer rebuilds captions on each render; only a changed one is news.
function sameCaptions(left: ReadonlyArray<VoiceCaption>, right: ReadonlyArray<VoiceCaption>) {
  return (
    left.length === right.length &&
    left.every(
      (caption, index) =>
        caption.role === right[index]!.role &&
        caption.text === right[index]!.text &&
        caption.final === right[index]!.final,
    )
  );
}

interface LocalVoiceControls {
  readonly stop: () => void;
  readonly setMuted: (muted: boolean) => void;
}

/**
 * Ctrl's own voice conversation (dictation, the quick voice, replies read aloud)
 * in the shape the voice strip reads from Codex voice, so every thread shows
 * the same voice UI. The composer running the conversation drives it.
 */
class LocalVoice {
  #state: VoiceModeState = INITIAL_VOICE_MODE_STATE;
  #listeners = new Set<() => void>();
  #controls: LocalVoiceControls | null = null;
  #microphone: DictationLevel | null = null;

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  readonly getState = () => this.#state;

  readonly subscribeLevels = (listener: (levels: VoiceLevels) => void): (() => void) => {
    const emit = () =>
      listener({
        microphone: this.#state.muted ? 0 : (this.#microphone?.read() ?? 0),
        speaker: replySpeaker.isSpeaking() ? REPLY_SPEAKER_LEVEL : 0,
      });
    const stopMicrophone = this.#microphone?.subscribe(emit);
    const stopSpeaker = replySpeaker.subscribe(emit);
    emit();
    return () => {
      stopMicrophone?.();
      stopSpeaker();
      listener({ microphone: 0, speaker: 0 });
    };
  };

  /** A conversation started in the composer for `target`. */
  attach(target: VoiceSessionTarget, controls: LocalVoiceControls, microphone: DictationLevel) {
    this.#controls = controls;
    this.#microphone = microphone;
    this.#set({ ...INITIAL_VOICE_MODE_STATE, phase: "connecting", target });
  }

  update(next: {
    readonly phase: "connecting" | "active";
    readonly muted: boolean;
    readonly captions: ReadonlyArray<VoiceCaption>;
  }) {
    if (this.#controls === null) return;
    this.#set({ ...this.#state, ...next });
  }

  /** The conversation ended, however it ended. */
  detach() {
    this.#controls = null;
    this.#microphone = null;
    this.#set(INITIAL_VOICE_MODE_STATE);
  }

  readonly stop = () => this.#controls?.stop();

  readonly toggleMuted = () => this.#controls?.setMuted(!this.#state.muted);

  #set(next: VoiceModeState) {
    const previous = this.#state;
    if (
      previous.phase === next.phase &&
      previous.target === next.target &&
      previous.muted === next.muted &&
      sameCaptions(previous.captions, next.captions)
    )
      return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}

export const localVoice = new LocalVoice();
