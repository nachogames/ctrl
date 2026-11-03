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

/**
 * With Smart Turn: silence after speech that asks the model whether the turn
 * is finished. The detector's report lag means the user has been quiet about
 * this long by the time silence is first reported, so the check runs at once.
 */
export const TURN_CHECK_SILENCE_MS = 250;

/** With Smart Turn: the longest pause the turn waits through when the model hears a mid-thought pause. */
export const TURN_MAX_SILENCE_MS = 1800;

/** Smart Turn probability at or above which the turn counts as finished. */
export const TURN_COMPLETE_PROBABILITY = 0.5;

export interface TurnState {
  /** True once speech has started. */
  readonly speaking: boolean;
  readonly endOfTurn: boolean;
}

/** Asks whether the turn heard so far is finished; it answers through `verdict`. */
export type TurnCheck = (pause: number) => void;

/**
 * Ends a hands-free turn from per-frame voice activity, timed on the recording's
 * own clock so frame delivery does not matter. Once ended it stays ended. With
 * `check`, a `checkAfterMs` pause asks the turn model once and a "finished" verdict
 * ends a still-quiet turn; `maxSilenceMs` (`silenceMs` without `check`) is the cap.
 */
export function createTurnDetector(options?: {
  readonly silenceMs?: number;
  readonly detectorLagMs?: number;
  readonly check?: TurnCheck;
  readonly checkAfterMs?: number;
  readonly maxSilenceMs?: number;
}) {
  const check = options?.check ?? null;
  const silenceMs = check
    ? (options?.maxSilenceMs ?? TURN_MAX_SILENCE_MS)
    : (options?.silenceMs ?? END_OF_TURN_SILENCE_MS);
  const checkAfterMs = options?.checkAfterMs ?? TURN_CHECK_SILENCE_MS;
  const lagMs = options?.detectorLagMs ?? VAD_REPORT_LAG_MS;
  let speaking = false;
  let endOfTurn = false;
  /** When the current pause began, in audio time; null while speech continues. */
  let silenceSince: number | null = null;
  /** Counts pauses, so a verdict for one the user already spoke through is ignored. */
  let pause = 0;
  let checked = false;
  const state = (): TurnState => ({ speaking, endOfTurn });
  return {
    /** Feeds whether the detector hears speech at `atMs` of audio. */
    push(detected: boolean, atMs: number): TurnState {
      if (endOfTurn) return state();
      if (detected) {
        speaking = true;
        if (silenceSince !== null) pause += 1;
        silenceSince = null;
        checked = false;
      } else if (speaking) {
        silenceSince ??= Math.max(0, atMs - lagMs);
        const quietMs = atMs - silenceSince;
        if (quietMs >= silenceMs) endOfTurn = true;
        else if (check && !checked && quietMs >= checkAfterMs) {
          checked = true;
          check(pause);
        }
      }
      return state();
    },
    /** The semantic model's answer for `forPause`. */
    verdict(forPause: number, finished: boolean): TurnState {
      if (finished && !endOfTurn && silenceSince !== null && forPause === pause) endOfTurn = true;
      return state();
    },
    get state(): TurnState {
      return state();
    },
  };
}

export type TurnDetector = ReturnType<typeof createTurnDetector>;

/**
 * Silero probability a frame needs to count as the user talking over a reply
 * that is playing. Echo the browser's canceller lets through is quieter and
 * less speech-like than a voice at the microphone, so it rarely reaches this.
 */
export const BARGE_IN_VAD_THRESHOLD = 0.8;

/**
 * How long confident speech must last, in audio time, before it interrupts a
 * playing reply. On top of Silero's own 250 ms minimum, so a cough or a burst
 * of echo while the canceller adapts does not cut the reply off.
 */
const BARGE_IN_MIN_SPEECH_MS = 200;

/** One frame from the voice activity detector. */
export interface VoiceActivityFrame {
  /** Speech at the normal threshold. */
  readonly detected: boolean;
  /** Speech at `BARGE_IN_VAD_THRESHOLD`. */
  readonly confident: boolean;
}

/**
 * Decides which frames count as user speech while a spoken reply may echo into
 * the mic. During playback only a confident run of `BARGE_IN_MIN_SPEECH_MS`
 * counts; after one has, or with no playback, every detected frame counts.
 */
export function createBargeInGate(options?: { readonly minSpeechMs?: number }) {
  const minSpeechMs = options?.minSpeechMs ?? BARGE_IN_MIN_SPEECH_MS;
  let open = false;
  /** Audio time of the first frame in the current run of confident speech. */
  let runSince: number | null = null;
  return {
    /** Whether this frame, heard at `atMs` of audio, is the user speaking. */
    accept(frame: VoiceActivityFrame, playback: boolean, atMs: number): boolean {
      if (open || !playback) {
        runSince = null;
        return frame.detected;
      }
      if (!frame.confident) {
        runSince = null;
        return false;
      }
      runSince ??= atMs;
      if (atMs - runSince < minSpeechMs) return false;
      open = true;
      return true;
    },
  };
}

export type BargeInGate = ReturnType<typeof createBargeInGate>;
