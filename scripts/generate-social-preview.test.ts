// @effect-diagnostics nodeBuiltinImport:off - Resolves the repo root for the font lookup.
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { buildSocialPreviewSvg } from "./generate-social-preview.ts";

describe("social preview", () => {
  it("is a 1280×640 vector composition with no font dependency", () => {
    const svg = buildSocialPreviewSvg(NodePath.resolve(import.meta.dirname, ".."));
    expect(svg).toContain('width="1280" height="640"');
    expect(svg).not.toContain("<text");
  });
});
