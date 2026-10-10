// @effect-diagnostics nodeBuiltinImport:off - Build-time font lookup.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { create, type Font } from "fontkitten";

export type DmSansWeight = "500Medium" | "600SemiBold" | "700Bold";
export type TextAnchor = "start" | "middle" | "end";

/** DM Sans ships with the mobile app (SIL OFL 1.1), so the scripts reuse that copy. */
export function resolveDmSansFont(repoRoot: string, weight: DmSansWeight): string {
  const require = NodeModule.createRequire(NodePath.join(repoRoot, "apps/mobile/package.json"));
  return require.resolve(`@expo-google-fonts/dm-sans/${weight}/DMSans_${weight}.ttf`);
}

export function loadFont(buffer: Buffer): Font {
  const font = create(buffer);
  if (font.isCollection) throw new Error("Expected a single font, not a font collection.");
  return font;
}

export function textWidth(font: Font, text: string, size: number): number {
  const scale = size / font.unitsPerEm;
  return font.glyphsForString(text).reduce((total, glyph) => total + glyph.advanceWidth, 0) * scale;
}

/** Converts text to absolute SVG path data in a y-down coordinate space (no kerning). */
export function textToPath(
  font: Font,
  text: string,
  options: {
    readonly size: number;
    readonly x: number;
    readonly baseline: number;
    readonly anchor?: TextAnchor;
  },
): string {
  const scale = options.size / font.unitsPerEm;
  const width = textWidth(font, text, options.size);
  const anchor = options.anchor ?? "start";
  let pen =
    anchor === "middle" ? options.x - width / 2 : anchor === "end" ? options.x - width : options.x;
  const parts: string[] = [];
  for (const glyph of font.glyphsForString(text)) {
    parts.push(glyph.path.transform(scale, 0, 0, -scale, pen, options.baseline).toSVG());
    pen += glyph.advanceWidth * scale;
  }
  return parts.join("");
}
