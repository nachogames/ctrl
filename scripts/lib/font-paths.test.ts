// @effect-diagnostics nodeBuiltinImport:off - Reads the real DM Sans font files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { loadFont, resolveDmSansFont, textToPath, textWidth } from "./font-paths.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "../..");
const bold = loadFont(NodeFS.readFileSync(resolveDmSansFont(repoRoot, "700Bold")));

function coordinates(d: string) {
  const numbers = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  return {
    xs: numbers.filter((_, index) => index % 2 === 0),
    ys: numbers.filter((_, index) => index % 2 === 1),
  };
}

describe("font-paths", () => {
  it("emits absolute path data only, with no text elements", () => {
    const d = textToPath(bold, "ctrl", { size: 25, x: 64, baseline: 66, anchor: "middle" });
    expect(d.startsWith("M")).toBe(true);
    expect(d).not.toMatch(/[a-z]/);
  });

  it("centers middle-anchored text on x and keeps glyphs above the baseline", () => {
    const d = textToPath(bold, "ctrl", { size: 25, x: 64, baseline: 66, anchor: "middle" });
    const { xs, ys } = coordinates(d);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(64, 0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(66.5);
    expect(Math.min(...ys)).toBeGreaterThan(66 - 25);
  });

  it("ends end-anchored text at x", () => {
    const width = textWidth(bold, "ctrl", 20);
    const { xs } = coordinates(
      textToPath(bold, "ctrl", { size: 20, x: 100, baseline: 50, anchor: "end" }),
    );
    expect(Math.max(...xs)).toBeLessThanOrEqual(100.5);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(100 - width - 0.5);
  });
});
