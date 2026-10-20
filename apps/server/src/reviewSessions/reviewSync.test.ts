import { describe, expect, it } from "vite-plus/test";

import {
  itemFixture,
  localSourceFixture,
  sourceComment,
  actor,
  githubReview,
  githubThread,
  reviewRoundRead,
  threadComment,
  at,
} from "./testkit.ts";
import {
  isCopilotLogin,
  itemGithubState,
  planReviewSync,
  rawReviewItems,
  repairUnknownLocalSources,
  shouldSyncReview,
} from "./reviewSync.ts";

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

  describe("on someone else's pull request", () => {
    const asReviewer = (fields: Parameters<typeof reviewRoundRead>[0]) =>
      reviewRoundRead({ authorLogin: "dan", viewerLogin: "NeilMcEachin", ...fields });
    const marker = "<!-- ctrl-review:review:1:1:3 -->";

    it("files your pending review while the round is held, and its submission with a verdict", () => {
      const pending = planReviewSync({
        sessionId: "review:1",
        sessionRound: 1,
        roundState: "applied",
        existing: [],
        now: at,
        read: asReviewer({
          reviews: [
            githubReview("PRR_mine", "NeilMcEachin", { state: "PENDING", submittedAt: null }),
            githubReview("PRR_copilot", "copilot-pull-request-reviewer", { isBot: true }),
          ],
          threads: [githubThread("T1", [threadComment("PRR_mine", `Null session. ${marker}`)])],
        }),
      });
      // Copilot waits for the next round; your own review is this round's.
      expect(pending.upserts.map(({ source }) => [source.id, source.state, source.posted])).toEqual(
        [["PRR_mine", "pending", true]],
      );
      const submitted = planReviewSync({
        sessionId: "review:1",
        sessionRound: 1,
        roundState: "applied",
        existing: pending.upserts.map(({ source }) => source),
        now: at,
        read: asReviewer({
          reviews: [githubReview("PRR_mine", "NeilMcEachin", { state: "CHANGES_REQUESTED" })],
          threads: [githubThread("T1", [threadComment("PRR_mine", `Null session. ${marker}`)])],
        }),
      });
      expect(submitted.upserts.map(({ source }) => [source.state, source.verdict])).toEqual([
        ["done", "changes-requested"],
      ]);
    });

    it("reads a re-request of your review as the Re-review signal, not a reviewer to wait for", () => {
      const plan = planReviewSync({
        sessionRound: 1,
        roundState: "applied",
        existing: [],
        now: at,
        read: asReviewer({ pendingReviewers: [actor("NeilMcEachin")] }),
      });
      expect(plan.viewerRequested).toBe(true);
      expect(plan.upserts).toEqual([]);
    });

    it("never turns what Ctrl posted into new points, and names your own GitHub comments `you`", () => {
      const plan = planReviewSync({
        sessionId: "review:1",
        sessionRound: 1,
        roundState: "collecting",
        existing: [],
        now: at,
        read: asReviewer({
          reviews: [githubReview("PRR_mine", "NeilMcEachin")],
          threads: [
            githubThread("T1", [threadComment("PRR_mine", `Posted by Ctrl. ${marker}`)]),
            githubThread("T2", [threadComment("PRR_mine", "Written on GitHub.")]),
          ],
        }),
      });
      const items = rawReviewItems({ round: 1, nextNumber: 1 }, [], plan.upserts, {
        sessionId: "review:1",
        viewerLogin: "NeilMcEachin",
      });
      expect(items.map((item) => [item.sourceKeys, item.sources])).toEqual([[["gh:T2"], ["you"]]]);
    });
  });

  it("files your own pending review on your own pull request as before: not at all", () => {
    const plan = planReviewSync({
      sessionRound: 1,
      roundState: "collecting",
      existing: [],
      now: at,
      read: reviewRoundRead({
        reviews: [githubReview("PRR_own", "nach", { state: "PENDING", body: "draft" })],
      }),
    });
    expect(plan.upserts).toEqual([]);
    expect(plan.viewerRequested).toBe(false);
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

describe("the local review's raw findings", () => {
  it("are raised by your review, not by a nameless reviewer", () => {
    const items = rawReviewItems(
      { round: 1, nextNumber: 1 },
      [],
      [
        {
          source: localSourceFixture("local:run-1"),
          comments: [sourceComment("local:src/app.ts:null-session", "Null session.")],
        },
      ],
    );
    expect(items.map((item) => item.sources)).toEqual([["local-review"]]);
  });

  it("repairs points an older import named human:unknown, leaving real reviewers alone", () => {
    const merged = itemFixture(1, {
      sourceKeys: ["local:src/app.ts:null-session"],
      sources: ["human:unknown", "local-review"],
      draftReply: "Noticed this too.",
    });
    const github = itemFixture(2, { sourceKeys: ["gh:T1"], sources: ["human:unknown"] });
    const repaired = repairUnknownLocalSources([merged, github]);
    expect(repaired.map((item) => [item.sources, item.draftReply])).toEqual([
      [["local-review"], null],
    ]);
  });
});
