import { describe, expect, it } from "vite-plus/test";

import { scopedPullRequestListKey, type EnvironmentPullRequestListEntry } from "./pullRequestList";
import { pullRequestListItems } from "./pullRequestStackItems";

const entry = (number: number, position?: number) =>
  ({
    environmentId: "env-1",
    projectId: "project-1",
    host: "github.com",
    repository: "acme/app",
    number,
    ...(position === undefined ? {} : { stack: { number: 7, position, size: 4, base: "main" } }),
  }) as unknown as EnvironmentPullRequestListEntry;

const shape = (items: ReturnType<typeof pullRequestListItems>) =>
  items.map((item) =>
    item.kind === "stack"
      ? `stack:${item.open ? "open" : "folded"}`
      : `${item.nested ? "  " : ""}#${item.entry.number}`,
  );

describe("pullRequestListItems", () => {
  const entries = [entry(12, 2), entry(5), entry(11, 1)];
  const stackKey = "env-1|github.com|acme/app|7";

  it("puts a stack's PRs under one open header at the first one's spot", () => {
    expect(shape(pullRequestListItems(entries, new Set(), undefined))).toEqual([
      "stack:open",
      "  #11",
      "  #12",
      "#5",
    ]);
  });

  it("keeps only the header of a folded stack", () => {
    expect(shape(pullRequestListItems(entries, new Set([stackKey]), undefined))).toEqual([
      "stack:folded",
      "#5",
    ]);
  });

  it("opens a folded stack that holds the selected PR", () => {
    const selected = scopedPullRequestListKey(entries[0]!);
    expect(shape(pullRequestListItems(entries, new Set([stackKey]), selected))).toEqual([
      "stack:open",
      "  #11",
      "  #12",
      "#5",
    ]);
  });
});
