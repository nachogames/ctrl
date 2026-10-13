import type { ReviewItem, ReviewRound, ReviewSource } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  effectiveDecision,
  nextUnviewedNumber,
  reviewApplyBadges,
  reviewApplySummary,
  reviewRoundStatusLine,
  reviewSourceDetail,
  reviewSourceStateLabel,
  reviewTriageLabel,
} from "./reviewSessionPresentation.ts";

const source = (fields: Partial<ReviewSource>): ReviewSource => ({
  id: "PRR_1",
  round: 1,
  kind: "copilot",
  state: "done",
  author: "copilot-pull-request-reviewer",
  isBot: true,
  commitSha: "b4c5d6e0000",
  commentCount: 3,
  triaged: false,
  threadId: null,
  ranOn: null,
  url: null,
  updatedAt: "2026-10-13T10:00:00.000Z",
  ...fields,
});

const item = (number: number, fields: Partial<ReviewItem> = {}) =>
  ({
    number,
    lastSeenRound: 1,
    stale: false,
    decision: "needs-call",
    suggestedDecision: "fix",
    viewed: false,
    applyState: "pending",
    githubThreadIds: ["T1"],
    sources: ["copilot"],
    ...fields,
  }) as ReviewItem;

const round = (fields: Partial<ReviewRound> = {}): ReviewRound => ({
  round: 1,
  headSha: "b4c5d6e",
  state: "collecting",
  appliedSha: null,
  createdAt: "2026-10-13T10:00:00.000Z",
  updatedAt: "2026-10-13T10:00:00.000Z",
  ...fields,
});

describe("review presentation", () => {
  it("shows the user's decision, else Claude's call", () => {
    expect(effectiveDecision({ decision: "needs-call", suggestedDecision: "decline" })).toBe(
      "decline",
    );
    expect(effectiveDecision({ decision: "fix", suggestedDecision: "decline" })).toBe("fix");
    expect(effectiveDecision({ decision: "needs-call", suggestedDecision: null })).toBeNull();
  });

  it("says where each review stands", () => {
    expect(reviewSourceStateLabel(source({}))).toBe("3 comments");
    expect(reviewSourceStateLabel(source({ state: "reviewing", commentCount: 0 }))).toBe(
      "Reviewing…",
    );
    expect(reviewSourceStateLabel(source({ kind: "local", commentCount: 1 }))).toBe("1 finding");
    expect(reviewSourceStateLabel(source({ kind: "local", state: "reviewing" }))).toBe("Running…");
    expect(reviewSourceDetail(source({}), null)).toBe("Reviewed b4c5d6e · 3 comments on GitHub");
    expect(reviewSourceDetail(source({ kind: "local", commentCount: 4 }), "Claude Opus 5.5")).toBe(
      "Ran on Claude Opus 5.5 · b4c5d6e · 4 findings",
    );
  });

  it("follows each point through the apply", () => {
    const fix = item(1, { decision: "fix" });
    expect(reviewApplyBadges(fix, "collecting")).toEqual([]);
    expect(reviewApplyBadges(fix, "applying")).toEqual(["Waiting"]);
    expect(reviewApplyBadges({ ...fix, applyState: "working" }, "applying")).toEqual(["Fixing…"]);
    expect(reviewApplyBadges({ ...fix, applyState: "resolved" }, "applied")).toEqual([
      "Fixed",
      "Replied",
      "Resolved",
    ]);
    const declinedLocal = item(2, {
      decision: "decline",
      githubThreadIds: [],
      applyState: "replied",
    });
    expect(reviewApplyBadges(declinedLocal, "applied")).toEqual(["Declined"]);
  });

  it("sums up a round and what triage would cover", () => {
    const copilot = source({});
    const local = source({ id: "local:1", kind: "local", state: "reviewing", author: null });
    expect(reviewRoundStatusLine({ round: round(), sources: [], items: [] })).toBe(
      "Waiting for reviews",
    );
    expect(reviewRoundStatusLine({ round: round(), sources: [copilot, local], items: [] })).toBe(
      "Copilot is in. Waiting for your review…",
    );
    expect(
      reviewRoundStatusLine({
        round: round(),
        sources: [copilot, { ...local, state: "done" }],
        items: [],
      }),
    ).toBe("Copilot and your review are in. Ready to triage.");
    expect(
      reviewRoundStatusLine({
        round: round({ state: "applied", appliedSha: "c7d8e9f1234" }),
        sources: [],
        items: [item(1, { applyState: "resolved" }), item(2, { applyState: "replied" })],
      }),
    ).toBe("Applied · pushed c7d8e9f · 2 replies · 1 resolved");
    expect(reviewTriageLabel(0)).toBeNull();
    expect(reviewTriageLabel(1)).toBe("Triage");
    expect(reviewTriageLabel(2)).toBe("Triage both");
    expect(reviewTriageLabel(3)).toBe("Triage all 3");
  });

  it("opens the next point not yet viewed", () => {
    const items = [item(1, { viewed: true }), item(2), item(3, { viewed: true }), item(4)];
    expect(nextUnviewedNumber(items, 2)).toBe(4);
    expect(nextUnviewedNumber(items, 4)).toBe(2);
    expect(nextUnviewedNumber([item(1, { viewed: true })], 1)).toBeNull();
  });

  it("tells the confirmation exactly what apply will do", () => {
    const summary = reviewApplySummary(
      [
        item(1, { decision: "fix" }),
        item(2, { decision: "decline" }),
        item(3, { decision: "fix", githubThreadIds: [], sources: ["local-review"] }),
        item(4, { decision: "decline", sources: ["human:dan"] }),
      ],
      [source({ id: "local:1", kind: "local", commentCount: 4 })],
      1,
    );
    expect(summary).toEqual({ fixes: [1, 3], replies: 3, resolves: 2, findings: 4 });
  });
});
