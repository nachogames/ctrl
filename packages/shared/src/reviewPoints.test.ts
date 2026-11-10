import type { ReviewItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isOpenReviewPoint, sourceNeedsTriage } from "./reviewPoints.ts";

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

describe("sourceNeedsTriage", () => {
  const source = { id: "PRR_1", state: "done" as const, triaged: false };
  const raised = (githubState: "open" | "resolved") => ({
    ...point({ githubState }),
    sourceIds: ["PRR_1"],
  });
  it("needs triage while a point it raised is open, or before any point is linked", () => {
    expect(sourceNeedsTriage(source, [raised("open"), raised("resolved")])).toBe(true);
    expect(sourceNeedsTriage(source, [])).toBe(true);
  });
  it("needs none once everything it raised is settled, or when triaged, running or failed", () => {
    expect(sourceNeedsTriage(source, [raised("resolved")])).toBe(false);
    expect(sourceNeedsTriage({ ...source, triaged: true }, [raised("open")])).toBe(false);
    expect(sourceNeedsTriage({ ...source, state: "reviewing" }, [])).toBe(false);
    expect(sourceNeedsTriage({ ...source, failed: true }, [])).toBe(false);
  });
});
