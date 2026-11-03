import { DICTATION_SAMPLE_RATE } from "@t3tools/contracts";

/** Audio kept from just before speech is heard, so the first syllable is not clipped. */
const GATE_PRE_ROLL_MS = 300;
/** Audio still sent after speech stops, so word endings and short pauses carry. */
const GATE_HANGOVER_MS = 300;

/** Audio to send, oldest first; `start` opens the activity before it. */
export interface GateOutput {
  readonly start: boolean;
  readonly audio: ReadonlyArray<Float32Array>;
}

/**
 * Decides which of a turn's audio is worth paying Gemini to hear. Nothing is
 * sent until the voice activity detector hears speech; then the activity
 * opens with a short pre-roll and audio flows while speech lasts plus a short
 * hangover. Longer silences are held back, and become the next pre-roll.
 */
export function createSpeechGate(options?: {
  readonly preRollMs?: number;
  readonly hangoverMs?: number;
  readonly sampleRate?: number;
}) {
  const rate = options?.sampleRate ?? DICTATION_SAMPLE_RATE;
  const preRollSamples = ((options?.preRollMs ?? GATE_PRE_ROLL_MS) / 1000) * rate;
  const hangoverSamples = ((options?.hangoverMs ?? GATE_HANGOVER_MS) / 1000) * rate;
  let open = false;
  /** Held-back audio, newest last, trimmed to the pre-roll. */
  let held: Float32Array[] = [];
  let heldSamples = 0;
  /** Samples heard since the last speech, while the activity is open. */
  let quietSamples = Number.POSITIVE_INFINITY;

  const hold = (chunk: Float32Array) => {
    held.push(chunk);
    heldSamples += chunk.length;
    while (held.length > 1 && heldSamples - held[0]!.length >= preRollSamples) {
      heldSamples -= held[0]!.length;
      held.shift();
    }
  };
  const release = () => {
    const audio = held;
    held = [];
    heldSamples = 0;
    return audio;
  };

  return {
    /** Feeds one chunk and whether the user is speaking in it; returns what to send, if anything. */
    push(chunk: Float32Array, speech: boolean): GateOutput | null {
      if (speech) {
        quietSamples = 0;
        const start = !open;
        open = true;
        return { start, audio: [...release(), chunk] };
      }
      if (!open) {
        hold(chunk);
        return null;
      }
      quietSamples += chunk.length;
      if (quietSamples <= hangoverSamples) return { start: false, audio: [chunk] };
      hold(chunk);
      return null;
    },
    /** True while an activity is open, which the caller must close with `activityEnd`. */
    get open() {
      return open;
    },
  };
}

export type SpeechGate = ReturnType<typeof createSpeechGate>;
