import { describe, expect, it } from "vite-plus/test";

import {
  END_OF_TURN_SILENCE_MS,
  TURN_CHECK_SILENCE_MS,
  TURN_MAX_SILENCE_MS,
  VAD_REPORT_LAG_MS,
  createBargeInGate,
  createTurnDetector,
} from "./endOfTurn.ts";

/** Feeds 100 ms frames: `true` frames are speech, `false` silence. Returns the state after each. */
function run(frames: ReadonlyArray<boolean>, detector = createTurnDetector()) {
  return frames.map((detected, index) => detector.push(detected, (index + 1) * 100));
}

const repeat = (detected: boolean, count: number) => Array.from({ length: count }, () => detected);

describe("createTurnDetector", () => {
  it("never ends a turn that has not started", () => {
    const states = run(repeat(false, 50));
    expect(states.every((state) => !state.speaking && !state.endOfTurn)).toBe(true);
  });

  it("reports speech as soon as it is detected", () => {
    const states = run([false, false, true]);
    expect(states.map((state) => state.speaking)).toEqual([false, false, true]);
  });

  it("ends the turn once the silence window passes, counting the detector's lag", () => {
    const states = run([...repeat(true, 10), ...repeat(false, 10)]);
    // Silence is reported at 1100 ms but began VAD_REPORT_LAG_MS earlier.
    const endedAt = states.findIndex((state) => state.endOfTurn);
    const silenceStartMs = 1100 - VAD_REPORT_LAG_MS;
    // The first 100 ms frame at or past the window ends it.
    expect((endedAt + 1) * 100).toBe(
      Math.ceil((silenceStartMs + END_OF_TURN_SILENCE_MS) / 100) * 100,
    );
  });

  it("keeps the turn going through a pause shorter than the window", () => {
    const pause = repeat(false, Math.floor(END_OF_TURN_SILENCE_MS / 100) - 2);
    const states = run([...repeat(true, 5), ...pause, ...repeat(true, 5), false]);
    expect(states.some((state) => state.endOfTurn)).toBe(false);
  });

  it("restarts the window when speech resumes", () => {
    const detector = createTurnDetector({ silenceMs: 500, detectorLagMs: 0 });
    expect(detector.push(true, 100).endOfTurn).toBe(false);
    expect(detector.push(false, 400).endOfTurn).toBe(false);
    expect(detector.push(true, 800).endOfTurn).toBe(false);
    expect(detector.push(false, 1000).endOfTurn).toBe(false);
    expect(detector.push(false, 1400).endOfTurn).toBe(false);
    expect(detector.push(false, 1500).endOfTurn).toBe(true);
  });

  it("stays ended after the turn ends, whatever it hears next", () => {
    const detector = createTurnDetector({ silenceMs: 200, detectorLagMs: 0 });
    detector.push(true, 100);
    detector.push(false, 200);
    expect(detector.push(false, 400)).toEqual({ speaking: true, endOfTurn: true });
    expect(detector.push(true, 500)).toEqual({ speaking: true, endOfTurn: true });
    expect(detector.state.endOfTurn).toBe(true);
  });
});

describe("createTurnDetector with a semantic check", () => {
  /** A detector whose checks are recorded for the test to answer, like a slow model would. */
  const semantic = () => {
    const checks: number[] = [];
    const detector = createTurnDetector({ detectorLagMs: 0, check: (pause) => checks.push(pause) });
    return { checks, detector };
  };
  /** Speech until 100 ms, then silence from 200 ms, reported up to `untilMs` in 50 ms frames. */
  const pauseAfterSpeech = (detector: ReturnType<typeof semantic>["detector"], untilMs: number) => {
    detector.push(true, 100);
    for (let at = 200; at <= untilMs; at += 50) detector.push(false, at);
    return detector.state;
  };

  it("asks once per pause, after the short silence", () => {
    const { checks, detector } = semantic();
    pauseAfterSpeech(detector, 200 + TURN_CHECK_SILENCE_MS - 50);
    expect(checks).toEqual([]);
    detector.push(false, 200 + TURN_CHECK_SILENCE_MS);
    detector.push(false, 200 + TURN_CHECK_SILENCE_MS + 100);
    expect(checks).toEqual([0]);
  });

  it("ends the turn as soon as the model says it is finished", () => {
    const { checks, detector } = semantic();
    expect(pauseAfterSpeech(detector, 200 + TURN_CHECK_SILENCE_MS).endOfTurn).toBe(false);
    expect(detector.verdict(checks[0]!, true).endOfTurn).toBe(true);
  });

  it("waits through a mid-thought pause the model calls unfinished, up to the cap", () => {
    const { checks, detector } = semantic();
    pauseAfterSpeech(detector, 200 + TURN_CHECK_SILENCE_MS);
    detector.verdict(checks[0]!, false);
    // Well past the fixed window, the turn is still open.
    expect(detector.push(false, 200 + END_OF_TURN_SILENCE_MS + 300).endOfTurn).toBe(false);
    expect(detector.push(false, 200 + TURN_MAX_SILENCE_MS - 50).endOfTurn).toBe(false);
    expect(detector.push(false, 200 + TURN_MAX_SILENCE_MS).endOfTurn).toBe(true);
  });

  it("ends at the cap when the model never answers", () => {
    const { checks, detector } = semantic();
    expect(pauseAfterSpeech(detector, 200 + TURN_MAX_SILENCE_MS - 50).endOfTurn).toBe(false);
    expect(checks).toEqual([0]);
    expect(detector.push(false, 200 + TURN_MAX_SILENCE_MS).endOfTurn).toBe(true);
  });

  it("ignores a late 'finished' for a pause the user already spoke through", () => {
    const { checks, detector } = semantic();
    pauseAfterSpeech(detector, 200 + TURN_CHECK_SILENCE_MS);
    detector.push(true, 600);
    expect(detector.verdict(checks[0]!, true).endOfTurn).toBe(false);
    // The next pause gets its own check, and its verdict counts.
    detector.push(false, 700);
    detector.push(false, 700 + TURN_CHECK_SILENCE_MS);
    expect(checks).toEqual([0, 1]);
    expect(detector.verdict(1, true).endOfTurn).toBe(true);
  });

  it("never asks before speech starts", () => {
    const { checks, detector } = semantic();
    for (let at = 100; at <= 5000; at += 100) detector.push(false, at);
    expect(checks).toEqual([]);
    expect(detector.state).toEqual({ speaking: false, endOfTurn: false });
  });
});

describe("createBargeInGate", () => {
  const speech = { detected: true, confident: true };
  const faint = { detected: true, confident: false };
  const silence = { detected: false, confident: false };

  it("passes every detected frame when nothing is playing", () => {
    const gate = createBargeInGate();
    expect([faint, silence, speech].map((frame, i) => gate.accept(frame, false, i * 100))).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("ignores echo-like speech below the confident threshold during playback", () => {
    const gate = createBargeInGate();
    const heard = Array.from({ length: 30 }, (_, i) => gate.accept(faint, true, i * 100));
    expect(heard.some(Boolean)).toBe(false);
  });

  it("needs confident speech to last before it interrupts playback", () => {
    const gate = createBargeInGate({ minSpeechMs: 200 });
    expect(gate.accept(speech, true, 100)).toBe(false);
    expect(gate.accept(speech, true, 200)).toBe(false);
    expect(gate.accept(speech, true, 300)).toBe(true);
  });

  it("restarts the run after a gap, so bursts of echo never add up", () => {
    const gate = createBargeInGate({ minSpeechMs: 200 });
    for (let at = 100; at < 3000; at += 200) {
      expect(gate.accept(speech, true, at)).toBe(false);
      expect(gate.accept(silence, true, at + 100)).toBe(false);
    }
  });

  it("stays open once the user has talked over the reply", () => {
    const gate = createBargeInGate({ minSpeechMs: 100 });
    gate.accept(speech, true, 100);
    expect(gate.accept(speech, true, 200)).toBe(true);
    // A pause, then softer speech, still counts while the reply is winding down.
    expect(gate.accept(silence, true, 300)).toBe(false);
    expect(gate.accept(faint, true, 400)).toBe(true);
  });
});
