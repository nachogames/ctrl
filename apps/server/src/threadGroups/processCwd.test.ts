import { describe, expect, it } from "@effect/vitest";

import { isPathInside, parseLsofCwd } from "./processCwd.ts";

describe("parseLsofCwd", () => {
  it("maps each pid to its cwd and skips a pid lsof could not read", () => {
    const raw = [
      "p123",
      "fcwd",
      "n/a/wt",
      "p456",
      "fcwd",
      "p789",
      "fcwd",
      "n/a/wt/apps/web",
      "",
    ].join("\n");
    expect([...parseLsofCwd(raw)]).toEqual([
      [123, "/a/wt"],
      [789, "/a/wt/apps/web"],
    ]);
  });
});

describe("isPathInside", () => {
  it("accepts the root and paths below it", () => {
    expect(isPathInside("/a/wt", "/a/wt")).toBe(true);
    expect(isPathInside("/a/wt", "/a/wt/apps/web")).toBe(true);
    expect(isPathInside("/a/wt/", "/a/wt/apps")).toBe(true);
  });

  it("rejects a sibling sharing the prefix and paths outside", () => {
    expect(isPathInside("/a/wt", "/a/wt2")).toBe(false);
    expect(isPathInside("/a/wt", "/a")).toBe(false);
    expect(isPathInside("/a/wt", "/b/wt")).toBe(false);
  });
});
