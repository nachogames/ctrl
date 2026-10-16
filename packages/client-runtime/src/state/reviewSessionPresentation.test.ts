import type { ReviewItem, ReviewRound, ReviewSource } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  effectiveDecision,
  liveRoundItems,
  reviewHistoryRounds,
  reviewResolutionLabel,
  nextUnviewedNumber,
  reviewApplyBadges,
  reviewApplySummary,
  reviewRoundStatusLine,
  reviewSourceDetail,
  reviewSourceStateLabel,
  reviewTriageLabel,
  pointDecisionLabel,
  reviewerApplyBadges,
  reviewerApplyLines,
  reviewSourceTitle,
  suggestedReviewVerdict,
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
    sourceKeys: ["gh:T1"],
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

  it("keeps raw local findings visible while they await triage", () => {
    const local = source({ kind: "local", commentCount: 3 });
    expect(reviewResolutionLabel([], [local])).toBe("3 findings awaiting triage");
    expect(reviewResolutionLabel([], [{ ...local, commentCount: 1 }])).toBe(
      "1 finding awaiting triage",
    );
    expect(reviewResolutionLabel([], [{ ...local, commentCount: 0 }])).toBe("No findings");
    expect(reviewResolutionLabel([item(1, { githubState: "resolved" })], [local])).toBe(
      "All resolved · 1/1 · 3 findings awaiting triage",
    );
    expect(
      reviewResolutionLabel([item(1, { githubState: "open" })], [{ ...local, triaged: true }]),
    ).toBe("1 open · 0 resolved");
    expect(reviewResolutionLabel([], [source({})])).toBe("No findings");
  });

  it("follows each point through the apply", () => {
    const fix = item(1, { decision: "fix" });
    expect(reviewApplyBadges(fix, "collecting")).toEqual([]);
    expect(reviewApplyBadges(fix, "applied")).toEqual(["Not applied"]);
    expect(reviewApplyBadges({ ...fix, decision: "decline" }, "applied")).toEqual(["Declined"]);
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

it("keeps old overview records and resolved points out of apply while retaining open outdated feedback", () => {
  const items = [
    item(1, { sourceKeys: ["gh-review:R1"] }),
    item(2, { githubState: "resolved" }),
    item(3, { githubState: "outdated" }),
    item(4, { stale: true }),
    item(5, { sourceKeys: ["gh-review:R1#status-radius"] }),
  ];
  expect(liveRoundItems({ items }, 1).map((item) => item.number)).toEqual([3, 5]);
  expect(items).toHaveLength(5);
});

describe("GitHub review rounds", () => {
  const pass = (id: string, day: number, fields: Partial<ReviewSource> = {}) =>
    source({ id, submittedAt: `2026-10-${day}T10:00:00.000Z`, commitSha: `sha${day}`, ...fields });
  it("groups five attempts into four completed rounds, including a failed retry and matching human review", () => {
    const sources = [
      pass("failed", 10, { failed: true }),
      pass("r1", 11),
      pass("r2", 12),
      pass("r3", 13),
      pass("r4", 14),
      pass("human", 14, { kind: "human", author: "alice" }),
    ];
    const items = Array.from({ length: 28 }, (_, i) =>
      item(i + 1, {
        sourceIds: [i < 22 ? "r1" : i < 26 ? "r2" : i === 26 ? "r3" : "r4"],
        githubState: i < 27 ? "resolved" : "open",
      }),
    );
    const rounds = reviewHistoryRounds(sources.toReversed(), items);
    expect(rounds.map((round) => round.sources.map((source) => source.id))).toEqual([
      ["failed", "r1"],
      ["r2"],
      ["r3"],
      ["human", "r4"],
    ]);
    expect(rounds.map((round) => reviewResolutionLabel(round.items))).toEqual([
      "All resolved · 22/22",
      "All resolved · 4/4",
      "All resolved · 1/1",
      "1 open · 0 resolved",
    ]);
    const refreshed = reviewHistoryRounds(
      sources,
      items.map((item) => ({ ...item, githubState: "resolved" })),
    );
    expect(reviewResolutionLabel(refreshed[3]!.items)).toBe("All resolved · 1/1");
  });
  it("keeps retries with the next completed pass and repeated reviews on the same commit distinct", () => {
    const rounds = reviewHistoryRounds(
      [
        pass("r1", 11),
        pass("retry", 12, { failed: true }),
        pass("r2", 13, { commitSha: "sha11" }),
        pass("local", 13, { kind: "local", commitSha: "sha11" }),
      ],
      [],
    );
    expect(rounds.map((round) => round.sources.map((source) => source.id))).toEqual([
      ["r1"],
      ["retry", "local", "r2"],
    ]);
    expect(reviewResolutionLabel([item(1, { githubState: "outdated" })])).toBe(
      "1 open · 0 resolved",
    );
  });
});

describe("reviewing someone else's pull request", () => {
  const mine = (fields: Partial<ReviewItem>) =>
    ({
      decision: "fix",
      sources: ["local-review"],
      round: 2,
      githubThreadIds: [],
      ...fields,
    }) as Pick<ReviewItem, "decision" | "sources" | "round" | "githubThreadIds" | "postAs">;

  it("names your own GitHub reviews as yours", () => {
    const yours = source({ kind: "human", author: "NeilMcEachin", isBot: false });
    expect(reviewSourceTitle(yours, "neilmceachin")).toBe("You");
    expect(reviewSourceTitle({ ...yours, posted: true }, "NeilMcEachin")).toBe(
      "Your review · posted",
    );
    expect(reviewSourceTitle(yours, "dan")).toBe("NeilMcEachin");
    expect(
      reviewSourceDetail(source({ kind: "human", state: "pending", commentCount: 2 }), null),
    ).toBe("Pending on GitHub · 2 comments · open the pull request to submit");
    expect(
      reviewSourceDetail(source({ kind: "human", verdict: "changes-requested" }), null),
    ).toContain("Changes requested");
  });

  it("names each choice by what it does to the point", () => {
    const session = { round: 2 };
    const label = (fields: Partial<ReviewItem>, decision: "fix" | "decline", reviewer = true) =>
      pointDecisionLabel(mine(fields), decision, session, reviewer);
    expect(label({}, "fix", false)).toBe("Fix");
    expect(label({}, "fix")).toBe("Post");
    expect(label({}, "decline")).toBe("Skip");
    const overlap = { sources: ["local-review", "copilot"] as ReviewItem["sources"] };
    expect(label(overlap, "fix")).toBe("+1 on their thread");
    expect(label({ ...overlap, postAs: "comment" }, "fix")).toBe("Post my own");
    expect(label({ round: 1, githubThreadIds: ["T1"] }, "fix")).toBe("Resolve");
    expect(label({ round: 1, githubThreadIds: ["T1"] }, "decline")).toBe("Keep open");
  });

  it("says what preparing the pending review did to each point", () => {
    expect(reviewerApplyBadges({ applyState: "replied" }, "reply", "applied")).toEqual([
      "+1 posted",
    ]);
    expect(reviewerApplyBadges({ applyState: "pending" }, "skip", "applied")).toEqual(["Skipped"]);
    expect(reviewerApplyBadges({ applyState: "working" }, "resolve", "applying")).toEqual([
      "Resolving…",
    ]);
    expect(reviewerApplyBadges({ applyState: "pending" }, null, "applied")).toEqual([]);
  });

  it("suggests approving only when every follow-up resolved and nothing new is posted", () => {
    const resolved = mine({ round: 1, githubThreadIds: ["T1"] });
    expect(suggestedReviewVerdict([resolved], 2)).toBe("approve");
    expect(suggestedReviewVerdict([{ ...resolved, decision: "decline" }], 2)).toBe(
      "request-changes",
    );
    expect(suggestedReviewVerdict([resolved, mine({})], 2)).toBe("request-changes");
    // Skipped findings and points only others raised ask nothing of the author.
    expect(
      suggestedReviewVerdict(
        [resolved, mine({ decision: "decline" }), mine({ sources: ["copilot"] })],
        2,
      ),
    ).toBe("approve");
  });

  it("lists what goes into the pending review", () => {
    const lines = reviewerApplyLines(
      [
        mine({}),
        mine({ sources: ["local-review", "copilot"], githubThreadIds: ["T2"] }),
        mine({ sources: ["local-review", "copilot"], githubThreadIds: ["T4"], postAs: "comment" }),
        mine({ round: 1, githubThreadIds: ["T1"] }),
        mine({ sources: ["copilot"] }),
      ],
      2,
    );
    expect(lines).toEqual([
      "Post 2 new comments.",
      "Reply +1 on 1 thread someone else already raised.",
      "Resolve 1 thread of yours that are fixed.",
      "Everything goes into your pending review on GitHub. Nothing is submitted, and no code is changed.",
    ]);
  });
});
