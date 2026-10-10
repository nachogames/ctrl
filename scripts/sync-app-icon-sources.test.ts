// @effect-diagnostics nodeBuiltinImport:off - Resolves the repository root to read the generated source files.
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { buildSourceFiles } from "./sync-app-icon-sources.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");

describe("sync-app-icon-sources", () => {
  const files = buildSourceFiles(repoRoot);

  it("keeps solid in the bundled project and adds a project per extra design and channel", () => {
    for (const dir of ["assets/dev", "assets/nightly", "assets/prod"]) {
      expect(files.has(`${dir}/app-icon.icon/Assets/text.svg`)).toBe(true);
      for (const design of ["outline", "mac"]) {
        expect(files.has(`${dir}/app-icon-${design}.icon/icon.json`)).toBe(true);
        expect(files.has(`${dir}/app-icon-${design}.icon/Assets/text.svg`)).toBe(true);
      }
    }
    expect(files.has("assets/dev/app-icon-outline.icon/Assets/background.svg")).toBe(true);
    expect(files.has("assets/nightly/app-icon-mac.icon/Assets/cloud-lower-left.svg")).toBe(true);
  });

  it("writes vector lettering only", () => {
    for (const [path, contents] of files) {
      // The DMG backgrounds keep their <text> copy; only the mark is vector.
      if (path.endsWith(".svg") && !path.includes("/dmg/"))
        expect(String(contents)).not.toContain("<text");
    }
    expect(String(files.get("assets/prod/app-icon.icon/Assets/text.svg"))).toContain(
      'fill="#111111"',
    );
  });

  it("replaces the T3 mark in the DMG backgrounds and keeps their copy readable", () => {
    const latest = String(files.get("apps/desktop/resources/dmg/dmg-background-latest.svg"));
    expect(latest).not.toContain("M33.4509");
    expect(latest).toContain('color="#303034"');
    expect(latest).toContain("Drag Ctrl into Applications.");
  });
});
