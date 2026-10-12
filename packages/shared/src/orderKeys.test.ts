import { describe, expect, it } from "vite-plus/test";

import { generateSpreadPinOrderKeys, pinOrderKeyBetween } from "./orderKeys.ts";

describe("pinOrderKeyBetween", () => {
  it("returns a valid key for open bounds", () => {
    const key = pinOrderKeyBetween(null, null);
    expect(key).toMatch(/^[a-z]*[b-z]$/);
  });

  it("sorts after the before key", () => {
    expect(pinOrderKeyBetween("m", null)! > "m").toBe(true);
  });

  it("sorts before the after key", () => {
    expect(pinOrderKeyBetween(null, "m")! < "m").toBe(true);
  });

  it("returns null for equal bounds", () => {
    expect(pinOrderKeyBetween("m", "m")).toBeNull();
  });
});

describe("generateSpreadPinOrderKeys", () => {
  it("produces strictly ascending unique keys", () => {
    const keys = generateSpreadPinOrderKeys(50);
    expect(keys).toHaveLength(50);
    expect(new Set(keys).size).toBe(50);
    for (let i = 1; i < keys.length; i += 1) expect(keys[i]! > keys[i - 1]!).toBe(true);
  });
});
