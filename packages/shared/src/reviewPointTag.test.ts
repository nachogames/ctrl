import { describe, expect, it } from "vite-plus/test";

import { formatReviewPointTag, parseReviewPointTag } from "./reviewPointTag.ts";

describe("review point tag", () => {
  it("round-trips the point and the message", () => {
    const text = formatReviewPointTag(
      { number: 2, label: "build cache key" },
      "why not a version bump?",
    );
    expect(text).toBe("[#2 build cache key]\nwhy not a version bump?");
    expect(parseReviewPointTag(text)).toEqual({
      number: 2,
      label: "build cache key",
      body: "why not a version bump?",
    });
  });

  it("keeps the label to one short line", () => {
    const text = formatReviewPointTag(
      { number: 3, label: "pin ] the\nversion" + "x".repeat(60) },
      "ok",
    );
    const parsed = parseReviewPointTag(text);
    expect(parsed?.label).not.toContain("]");
    expect(parsed?.label).not.toContain("\n");
    expect(parsed?.label.length).toBeLessThanOrEqual(40);
  });

  it("reads only a tag on the first line", () => {
    expect(parseReviewPointTag("#3 decline: out of scope")).toBeNull();
    expect(parseReviewPointTag("see [#2 build cache key]\nlater")).toBeNull();
  });
});
