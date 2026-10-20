/** Silence after speech that ends a hands-free turn. Tune here. */
export const END_OF_TURN_SILENCE_MS = 700;

/** How long the voice activity detector waits in silence before it reports it. */
export const VAD_MIN_SILENCE_MS = 100;

/**
 * How late the detector reports silence after the voice really stops: its own
 * wait plus Silero's 32 ms windows and smoothing, measured at about 250 ms on
 * synthesized speech. The turn detector counts it toward the silence window,
 * so the turn ends about `END_OF_TURN_SILENCE_MS` after the user stopped.
 */
export const VAD_REPORT_LAG_MS = 250;

export interface TurnState {
  /** True once speech has started. */
  readonly speaking: boolean;
  readonly endOfTurn: boolean;
}

/**
 * Decides when a hands-free turn ends from per-frame voice activity, on the
 * recording's own clock (milliseconds of audio heard), so timing does not
 * depend on how the frames were delivered. Pauses shorter than the silence
 * window keep the turn going; the turn ends once, and stays ended.
 */
export function createTurnDetector(options?: {
  readonly silenceMs?: number;
  readonly detectorLagMs?: number;
}) {
  const silenceMs = options?.silenceMs ?? END_OF_TURN_SILENCE_MS;
  const lagMs = options?.detectorLagMs ?? VAD_REPORT_LAG_MS;
  let speaking = false;
  let endOfTurn = false;
  /** When the current pause began, in audio time; null while speech continues. */
  let silenceSince: number | null = null;
  return {
    /** Feeds whether the detector hears speech at `atMs` of audio. */
    push(detected: boolean, atMs: number): TurnState {
      if (endOfTurn) return { speaking, endOfTurn };
      if (detected) {
        speaking = true;
        silenceSince = null;
      } else if (speaking) {
        silenceSince ??= Math.max(0, atMs - lagMs);
        if (atMs - silenceSince >= silenceMs) endOfTurn = true;
      }
      return { speaking, endOfTurn };
    },
    get state(): TurnState {
      return { speaking, endOfTurn };
    },
  };
}

export type TurnDetector = ReturnType<typeof createTurnDetector>;
