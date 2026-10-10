// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pure path joining under test, no Effect runtime involved.
import * as NodePath from "node:path";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { resolveDesktopBaseDir } from "./DesktopStatePaths.ts";

describe("resolveDesktopBaseDir", () => {
  it.each([
    [Option.none<string>(), "/Users/alice/.ctrl"],
    [Option.some("   "), "/Users/alice/.ctrl"],
    [Option.some("/Users/alice/.t3"), "/Users/alice/.t3"],
  ])("resolves %s to %s", (t3Home, expected) => {
    expect(
      resolveDesktopBaseDir({
        homeDirectory: "/Users/alice",
        joinPath: NodePath.posix.join,
        t3Home,
      }),
    ).toBe(expected);
  });
});
