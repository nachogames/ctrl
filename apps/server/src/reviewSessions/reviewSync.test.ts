import { describe, expect, it } from "vite-plus/test";

import {
  actor,
  githubReview,
  githubThread,
  reviewRoundRead,
  threadComment,
  at,
} from "./testkit.ts";
import { isCopilotLogin, itemGithubState, planReviewSync, shouldSyncReview } from "./reviewSync.ts";

describe("planReviewSync", () => {
  it("files reviewers, shows Copilot as reviewing, and skips the author's own posts", () => {
    const plan = planReviewSync({
      sessionRound: 1,
      roundState: "collecting",
      existing: [],
      now: at,
      read: reviewRoundRead({
        reviews: [githubReview("PRR_own", "nach", { body: "Self-review, round 1" })],
        pendingReviewers: [actor("copilot-pull-request-reviewer", true), actor("dan")],
        threads: [githubThread("T1", [threadComment("PRR_own", "Fixed in b4c5d6e.")])],
      }),
    });
    expect(plan.upserts.map(({ source }) => [source.id, source.kind, source.state])).toEqual([
      ["request:1:copilot-pull-request-reviewer", "copilot", "reviewing"],
      ["request:1:dan", "human", "requested"],
    ]);
    expect(plan.removals).toEqual([]);
  });

  it("holds a review that lands mid-apply and keeps its request as it was", () => {
    const request = {
      id: "request:1:dan",
      round: 1,
      kind: "human" as const,
      state: "requested" as const,
      author: "dan",
      isBot: false,
      commitSha: null,
      commentCount: 0,
      triaged: false,
      threadId: null,
      ranOn: null,
      url: null,
      updatedAt: at,
    };
    const plan = planReviewSync({
      sessionRound: 1,
      roundState: "applying",
      existing: [request],
      now: at,
      read: reviewRoundRead({
        reviews: [githubReview("PRR_dan", "dan")],
        pendingReviewers: [],
      }),
    });
    expect(plan.upserts).toEqual([]);
    expect(plan.removals).toEqual([]);
  });

  it("names Copilot under either login", () => {
    expect(isCopilotLogin("Copilot")).toBe(true);
    expect(isCopilotLogin("copilot-pull-request-reviewer[bot]")).toBe(true);
    expect(isCopilotLogin("dan")).toBe(false);
  });
});

describe("itemGithubState", () => {
  it("is resolved only when every known thread is", () => {
    const threads = new Map([
      ["T1", { isResolved: true, isOutdated: false }],
      ["T2", { isResolved: false, isOutdated: true }],
      ["T3", { isResolved: false, isOutdated: false }],
    ]);
    expect(itemGithubState(["T1"], threads)).toBe("resolved");
    expect(itemGithubState(["T1", "T2"], threads)).toBe("outdated");
    expect(itemGithubState(["T1", "T3"], threads)).toBe("open");
    expect(itemGithubState(["T9"], threads)).toBeNull();
  });
});

describe("shouldSyncReview", () => {
  const next = { fingerprint: "open abc" as string | null, round: 1, waiting: false };
  const mark = { ...next, readAt: 0 };
  it("reads when GitHub moved, the round moved, someone is reviewing, or ten minutes passed", () => {
    expect(shouldSyncReview(undefined, next, 0)).toBe(true);
    expect(shouldSyncReview(mark, next, 60_000)).toBe(false);
    expect(shouldSyncReview(mark, { ...next, fingerprint: "open def" }, 60_000)).toBe(true);
    expect(shouldSyncReview(mark, { ...next, round: 2 }, 60_000)).toBe(true);
    expect(shouldSyncReview(mark, { ...next, waiting: true }, 60_000)).toBe(true);
    expect(shouldSyncReview(mark, { ...next, fingerprint: null }, 60_000)).toBe(true);
    expect(shouldSyncReview(mark, next, 10 * 60_000)).toBe(true);
  });
});
