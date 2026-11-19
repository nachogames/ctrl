import { describe, expect, it } from "@effect/vitest";

import {
  nestPullRequestStacks,
  type StackablePullRequestEntry,
} from "./pullRequestStackNesting.ts";

const entry = (
  number: number,
  stack?: { number: number; position: number; size?: number },
  repository = "acme/app",
): StackablePullRequestEntry => ({
  environmentId: "env-1",
  host: "github.com",
  repository,
  number,
  ...(stack
    ? {
        stack: {
          number: stack.number,
          position: stack.position,
          size: stack.size ?? 5,
          base: "main",
        },
      }
    : {}),
});

const shape = (rows: ReturnType<typeof nestPullRequestStacks>) =>
  rows.map((row) =>
    row.kind === "entry" ? row.entry.number : row.entries.map((member) => member.number),
  );

describe("nestPullRequestStacks", () => {
  it("leaves entries without a stack in order", () => {
    expect(shape(nestPullRequestStacks([entry(1), entry(2), entry(3)]))).toEqual([1, 2, 3]);
  });

  it("collapses a stack's entries at the first one's spot, bottom layer first", () => {
    const rows = nestPullRequestStacks([
      entry(10, { number: 7, position: 3 }),
      entry(20),
      entry(11, { number: 7, position: 1 }),
      entry(30),
    ]);
    expect(shape(rows)).toEqual([[11, 10], 20, 30]);
    expect(rows[0]).toMatchObject({ kind: "stack", membership: { number: 7, size: 5 } });
  });

  it("keeps a stack with one entry here as a plain row", () => {
    expect(
      shape(nestPullRequestStacks([entry(10, { number: 7, position: 2 }), entry(20)])),
    ).toEqual([10, 20]);
  });

  it("does not merge the same stack number from two repositories", () => {
    const rows = nestPullRequestStacks([
      entry(10, { number: 7, position: 1 }, "acme/app"),
      entry(11, { number: 7, position: 2 }, "acme/app"),
      entry(12, { number: 7, position: 1 }, "acme/api"),
      entry(13, { number: 7, position: 2 }, "acme/api"),
    ]);
    expect(shape(rows)).toEqual([
      [10, 11],
      [12, 13],
    ]);
  });
});
