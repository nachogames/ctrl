#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Build-time image generation script.
// GitHub has no API for social previews: upload assets/social-preview.png in
// Settings → General → Social preview.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { renderAppIconPaths } from "@t3tools/shared/appIconArtwork";
import { APP_ICON_ARTWORK } from "@t3tools/shared/appIcons";
import sharp from "sharp";

import { loadFont, resolveDmSansFont, textToPath } from "./lib/font-paths.ts";

export function buildSocialPreviewSvg(repoRoot: string): string {
  const bold = loadFont(NodeFS.readFileSync(resolveDmSansFont(repoRoot, "700Bold")));
  const medium = loadFont(NodeFS.readFileSync(resolveDmSansFont(repoRoot, "500Medium")));
  const keycap = renderAppIconPaths(APP_ICON_ARTWORK.solid.color);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640">',
    '  <rect width="1280" height="640" fill="#0B0B0C"/>',
    '  <rect x="150" y="160" width="320" height="320" rx="72" fill="#000000" stroke="#1F1F22" stroke-width="2"/>',
    `  <g transform="translate(150 160) scale(2.5)">\n${keycap}\n  </g>`,
    `  <path d="${textToPath(bold, "Ctrl", { size: 168, x: 560, baseline: 370 })}" fill="#FFFFFF"/>`,
    `  <path d="${textToPath(medium, "a fork of T3 Code", { size: 46, x: 566, baseline: 446 })}" fill="#A1A1AA"/>`,
    "</svg>",
  ].join("\n");
}

if (import.meta.main) {
  const repoRoot = NodePath.resolve(import.meta.dirname, "..");
  const output = NodePath.join(repoRoot, "assets/social-preview.png");
  await sharp(Buffer.from(buildSocialPreviewSvg(repoRoot)))
    .png()
    .toFile(output);
  console.log("wrote assets/social-preview.png");
}
