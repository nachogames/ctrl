import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import { mergeVoiceFrontReplies, VoiceFrontSettings } from "./voiceFront.ts";

describe("voice front settings", () => {
  it("keep the local engine by default, with a $10 Gemini cap", () => {
    const settings = Schema.decodeSync(VoiceFrontSettings)({});
    expect(settings.engine).toBe("local");
    expect(settings.geminiModel).toBe("gemini-3.1-flash-live-preview");
    expect(settings.monthlyCapUsd).toBe(10);
  });
});

describe("mergeVoiceFrontReplies", () => {
  it("keeps every audio chunk in order and the latest text", () => {
    const merged = mergeVoiceFrontReplies(
      { text: "", audio: ["a", "b"], done: false, answered: false, firstTokenMs: 120 },
      { text: "", audio: ["c"], done: true, answered: true, firstTokenMs: null },
    );
    expect(merged).toEqual({
      text: "",
      audio: ["a", "b", "c"],
      done: true,
      answered: true,
      firstTokenMs: 120,
    });
  });

  it("keeps an interruption from an earlier update", () => {
    const merged = mergeVoiceFrontReplies(
      { text: "", done: true, interrupted: true, answered: false, firstTokenMs: null },
      { text: "", done: false, answered: false, firstTokenMs: null },
    );
    expect(merged.interrupted).toBe(true);
    expect(merged.done).toBe(true);
  });
});
