import { APP_ICONS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildAppIconArtwork,
  renderAppIconPaths,
  renderAppIconSvg,
  renderVectorDrawable,
  roundedRectPath,
} from "./appIconArtwork.ts";
import { APP_ICON_ARTWORK } from "./appIcons.ts";

const LEGENDS = { outlineCtrl: "M1 1Z", solidCtrl: "M2 2Z", macControl: "M3 3Z" };

describe("appIconArtwork", () => {
  it("draws rounded rectangles with absolute arcs", () => {
    expect(roundedRectPath(0, 0, 10, 10, 2)).toBe(
      "M2 0H8A2 2 0 0 1 10 2V8A2 2 0 0 1 8 10H2A2 2 0 0 1 0 8V2A2 2 0 0 1 2 0Z",
    );
  });

  it("builds every design with its own legend in both tones", () => {
    const artwork = buildAppIconArtwork(LEGENDS);
    expect(Object.keys(artwork).toSorted()).toEqual([...APP_ICONS].toSorted());
    expect(artwork.outline.color.some((shape) => shape.d.includes("M1 1Z"))).toBe(true);
    expect(artwork.solid.mono.some((shape) => shape.d.includes("M2 2Z"))).toBe(true);
    expect(artwork.mac.color.some((shape) => shape.d.includes("M3 3Z"))).toBe(true);
  });

  it("paints mono shapes only with currentColor", () => {
    for (const design of APP_ICONS) {
      for (const shape of buildAppIconArtwork(LEGENDS)[design].mono) {
        expect(
          [shape.fill, shape.stroke].filter(Boolean).every((paint) => paint === "currentColor"),
        ).toBe(true);
      }
    }
  });

  it("keeps the real artwork inside the inline mark viewBox (14..114)", () => {
    for (const design of APP_ICONS) {
      for (const shape of APP_ICON_ARTWORK[design].color) {
        const numbers = (shape.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
        // Arc commands carry radius/flag values; every coordinate and radius stays in range.
        expect(Math.min(...numbers)).toBeGreaterThanOrEqual(0);
        expect(Math.max(...numbers)).toBeLessThanOrEqual(114);
      }
    }
  });

  it("renders vector-only SVG and resolves currentColor on request", () => {
    const svg = renderAppIconSvg(APP_ICON_ARTWORK.solid.mono, { currentColor: "#000000" });
    expect(svg).toContain('viewBox="0 0 128 128"');
    expect(svg).not.toContain("<text");
    expect(svg).not.toContain("currentColor");
  });

  it("builds the SVG body from renderAppIconPaths", () => {
    for (const design of APP_ICONS) {
      const shapes = APP_ICON_ARTWORK[design].color;
      const paths = renderAppIconPaths(shapes);
      expect(paths.split("\n")).toHaveLength(shapes.length);
      expect(renderAppIconSvg(shapes)).toContain(`\n${paths}\n`);
    }
    const resolved = renderAppIconPaths(APP_ICON_ARTWORK.solid.mono, { currentColor: "#000000" });
    expect(resolved).not.toContain("currentColor");
    expect(renderAppIconSvg(APP_ICON_ARTWORK.solid.mono, { currentColor: "#000000" })).toContain(
      resolved,
    );
  });

  it("renders an Android vector drawable with evenOdd fill types", () => {
    const xml = renderVectorDrawable(APP_ICON_ARTWORK.solid.mono, {
      color: "#FFFFFFFF",
      sizeDp: 24,
    });
    expect(xml).toContain('android:viewportWidth="100"');
    expect(xml).toContain('android:fillType="evenOdd"');
    expect(xml).not.toContain("currentColor");
  });
});
