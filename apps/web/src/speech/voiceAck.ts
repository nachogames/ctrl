/**
 * Short spoken acknowledgements for voice turns the agent takes on, so the
 * user hears something at once instead of silence while it works.
 */
export const ACK_PHRASES = ["On it.", "Checking.", "Got it.", "Okay, looking.", "Sure, one sec."];

/**
 * Whether a turn the agent takes on needs an acknowledgement, given what the
 * front voice said for it: any words already acknowledged it, and a turn the
 * front fully answered is never the agent's. Failed, off, slow, and silent
 * handoffs all said nothing. `heardAudio`: the front spoke in audio (Gemini).
 */
export function needsAck(input: {
  readonly answered: boolean;
  readonly spoken: string;
  readonly heardAudio?: boolean;
}): boolean {
  return !input.answered && !input.heardAudio && input.spoken.trim().length === 0;
}

/** Hands out the phrases in turn, so the same one never plays twice in a row. */
export function createAckRotation(phrases: ReadonlyArray<string> = ACK_PHRASES) {
  let next = 0;
  return () => {
    const phrase = phrases[next % phrases.length]!;
    next += 1;
    return phrase;
  };
}
