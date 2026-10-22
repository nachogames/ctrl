import type { ReviewItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isOpenReviewPoint } from "./reviewPoints.ts";

const point = (fields: Partial<Pick<ReviewItem, "githubState" | "decision" | "applyState">>) => ({
  githubState: null,
  decision: "needs-call" as const,
  applyState: "pending" as const,
  ...fields,
});

describe("isOpenReviewPoint", () => {
  it("follows the GitHub thread when there is one", () => {
    expect(isOpenReviewPoint(point({ githubState: "open", decision: "decline" }))).toBe(true);
    expect(isOpenReviewPoint(point({ githubState: "outdated" }))).toBe(true);
    expect(isOpenReviewPoint(point({ githubState: "resolved", decision: "fix" }))).toBe(false);
  });
  it("keeps an unposted finding open until it is skipped or applied", () => {
    expect(isOpenReviewPoint(point({}))).toBe(true);
    expect(isOpenReviewPoint(point({ decision: "fix" }))).toBe(true);
    expect(isOpenReviewPoint(point({ decision: "decline" }))).toBe(false);
    expect(isOpenReviewPoint(point({ decision: "fix", applyState: "fixed" }))).toBe(false);
  });
});
