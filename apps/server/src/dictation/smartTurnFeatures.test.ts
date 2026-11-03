import { describe, expect, it } from "vite-plus/test";

import {
  MEL_BINS,
  MEL_FRAMES,
  createRecentAudio,
  powerSpectrum,
  smartTurnFeatures,
} from "./smartTurnFeatures.ts";

describe("powerSpectrum", () => {
  it("matches a plain DFT of the 400-sample frame", () => {
    const frame = Float64Array.from(
      { length: 400 },
      (_, n) => Math.sin(n * 0.37) + ((n * 7919) % 13) / 13,
    );
    const power = powerSpectrum(frame);
    for (const bin of [0, 1, 24, 99, 157, 200]) {
      let re = 0;
      let im = 0;
      for (let n = 0; n < 400; n++) {
        re += frame[n]! * Math.cos((-2 * Math.PI * bin * n) / 400);
        im += frame[n]! * Math.sin((-2 * Math.PI * bin * n) / 400);
      }
      expect(power[bin]).toBeCloseTo(re * re + im * im, 6);
    }
  });
});

describe("smartTurnFeatures", () => {
  it("gives Whisper's 80 x 800 features, in Whisper's clamped range", () => {
    const tone = Float32Array.from(
      { length: 16000 },
      (_, n) => 0.2 * Math.sin((2 * Math.PI * 440 * n) / 16000),
    );
    const features = smartTurnFeatures(tone);
    expect(features.length).toBe(MEL_BINS * MEL_FRAMES);
    let max = -Infinity;
    let min = Infinity;
    for (const value of features) {
      max = Math.max(max, value);
      min = Math.min(min, value);
    }
    // log10 values are clamped to 8 below the peak, then scaled by (x + 4) / 4.
    expect(max - min).toBeCloseTo(2, 5);
  });

  it("pads short audio at the start, so the speech sits at the end", () => {
    const tone = Float32Array.from(
      { length: 16000 },
      (_, n) => 0.2 * Math.sin((2 * Math.PI * 440 * n) / 16000),
    );
    const features = smartTurnFeatures(tone);
    // 440 Hz lands in a low mel band; it is loud in the last second only.
    const band = 10;
    const at = (frame: number) => features[band * MEL_FRAMES + frame]!;
    expect(at(MEL_FRAMES - 20)).toBeGreaterThan(at(100) + 1);
  });
});

describe("createRecentAudio", () => {
  it("keeps the newest samples in order once the ring wraps", () => {
    const recent = createRecentAudio(5);
    recent.push(Float32Array.of(1, 2, 3));
    expect([...recent.snapshot()]).toEqual([1, 2, 3]);
    recent.push(Float32Array.of(4, 5, 6, 7));
    expect([...recent.snapshot()]).toEqual([3, 4, 5, 6, 7]);
    recent.push(Float32Array.of(8, 9, 10, 11, 12, 13));
    expect([...recent.snapshot()]).toEqual([9, 10, 11, 12, 13]);
  });
});
