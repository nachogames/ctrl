import { describe, expect, it } from "vite-plus/test";

import { createAckRotation, needsAck } from "./voiceAck";

describe("needsAck", () => {
  it("acknowledges a turn the front could not take or handed off in silence", () => {
    expect(needsAck({ answered: false, spoken: "" })).toBe(true);
    expect(needsAck({ answered: false, spoken: "  " })).toBe(true);
  });

  it("stays quiet when the front already said something", () => {
    expect(needsAck({ answered: false, spoken: "On it, Shift is checking." })).toBe(false);
    expect(needsAck({ answered: true, spoken: "Two threads are running." })).toBe(false);
  });
});

describe("createAckRotation", () => {
  it("never repeats a phrase back to back, and uses them all", () => {
    const next = createAckRotation(["a", "b", "c"]);
    const spoken = Array.from({ length: 7 }, next);
    expect(spoken).toEqual(["a", "b", "c", "a", "b", "c", "a"]);
    for (let index = 1; index < spoken.length; index++)
      expect(spoken[index]).not.toBe(spoken[index - 1]);
  });
});
