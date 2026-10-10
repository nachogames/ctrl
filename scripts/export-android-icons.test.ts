import { describe, expect, it } from "vite-plus/test";

import { markTransform } from "./export-android-icons.ts";

describe("export-android-icons", () => {
  it("centers the 96-unit keycap box on the adaptive canvas", () => {
    // 432px canvas, mark fraction 0.5 => 216px box, scale 2.25, box origin (16,16) -> 108px.
    expect(markTransform(432, 0.5)).toBe("translate(72.000 72.000) scale(2.2500)");
  });
});
