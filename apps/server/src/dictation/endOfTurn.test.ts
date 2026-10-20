import { describe, expect, it } from "vite-plus/test";

import { END_OF_TURN_SILENCE_MS, VAD_REPORT_LAG_MS, createTurnDetector } from "./endOfTurn.ts";

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
