import type { PullRequestCheck, ReviewItem, ReviewSource } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { reviewProgress, type ReviewProgressInput } from "./reviewProgress.ts";

const review = (id: string, day: number, sha: string, fields: Partial<ReviewSource> = {}) =>
  ({
    id,
    round: 1,
    kind: "human",
    state: "done",
    author: "neil",
    isBot: false,
    commitSha: sha,
    commentCount: 1,
    triaged: true,
    threadId: null,
    ranOn: null,
    url: null,
    updatedAt: `2026-10-${day}T10:00:00.000Z`,
    submittedAt: `2026-10-${day}T10:00:00.000Z`,
    ...fields,
  }) as ReviewSource;

const issue = (number: number, sourceId: string, fields: Partial<ReviewItem> = {}) =>
  ({
    number,
    sourceIds: [sourceId],
    sourceKeys: [`gh:T${number}`],
    sources: ["you"],
    githubState: "resolved",
    ...fields,
  }) as ReviewItem;

const check = (status: PullRequestCheck["status"]): PullRequestCheck => ({
  name: "build",
  status,
  description: null,
  url: null,
});

// Someone else's pull request: four of your reviews on four commits, then a re-request.
const reviewing: ReviewProgressInput = {
  role: "reviewer",
  viewerLogin: "neil",
  authorLogin: "august",
  sources: [
    review("copilot", 13, "aaa", { kind: "copilot", author: "copilot", isBot: true }),
    review("r1", 14, "aaa"),
    review("r2", 16, "bbb"),
    review("r3", 19, "ccc"),
    review("r4", 20, "ddd"),
  ],
  items: [
    issue(1, "copilot", { sources: ["copilot"] }),
    issue(2, "r1"),
    issue(3, "r1"),
    issue(4, "r2"),
    issue(5, "r3"),
    issue(6, "r4", { githubState: "outdated" }),
    issue(7, "r4", { githubState: "open" }),
    // Raised in round 1 and again in round 4: counted once, where it was first found.
    issue(8, "r1", { sourceIds: ["r1", "r4"], githubState: "open" }),
  ],
  checks: [check("success")],
  headSha: "eee",
  reReview: "requested",
};

describe("review progress", () => {
  it("counts each reviewed commit as a round and each issue once, where it was found", () => {
    const progress = reviewProgress(reviewing);
    expect(progress.rounds).toEqual([
      { number: 1, commitSha: "aaa", found: 4, open: 1 },
      { number: 2, commitSha: "bbb", found: 1, open: 0 },
      { number: 3, commitSha: "ccc", found: 1, open: 0 },
      { number: 4, commitSha: "ddd", found: 2, open: 2 },
    ]);
    expect(progress.trend).toBe("Settling down: 4 in round 1, 2 in round 4.");
  });

  it("tells a reviewer what stands between them and approving", () => {
    const progress = reviewProgress(reviewing);
    expect(progress.goal).toBe("approve");
    expect(progress.headline).toBe("3 issues left before you can approve");
    expect(progress.detail).toBe(
      "august asked you to look again, and changed the code under 1 of them.",
    );
    expect(progress.gates.map((gate) => [gate.label, gate.value, gate.tone])).toEqual([
      ["Your issues", "4 of 7 resolved", "waiting"],
      ["Others' issues", "All resolved", "done"],
      ["CI", "Passing", "done"],
      ["Since your review", "New commits", "waiting"],
    ]);
  });

  it("puts work waiting on the reviewer ahead of the count", () => {
    const local = review("local:1", 21, "eee", {
      kind: "local",
      author: null,
      triaged: false,
      commentCount: 3,
    });
    expect(reviewProgress({ ...reviewing, sources: [...reviewing.sources, local] }).headline).toBe(
      "Triage 3 findings from your review",
    );
    const running = { ...local, state: "reviewing", commitSha: null } as ReviewSource;
    expect(
      reviewProgress({ ...reviewing, sources: [...reviewing.sources, running] }).headline,
    ).toBe("Your review is running");
  });

  it("tells the author what stands between them and merging", () => {
    const progress = reviewProgress({
      role: "author",
      viewerLogin: "neil",
      authorLogin: "neil",
      sources: [review("dan", 19, "fff", { author: "dan" })],
      items: [
        issue(1, "dan", { sources: ["human:dan"], githubState: "open" }),
        issue(2, "dan", { sources: ["human:dan"] }),
      ],
      checks: [check("failure"), check("success")],
      reviewDecision: "review-required",
    });
    expect([progress.goal, progress.headline, progress.detail]).toEqual([
      "merge",
      "1 comment to answer",
      "From dan. Then it needs an approval.",
    ]);
    expect(progress.gates.map((gate) => gate.value)).toEqual([
      "1 open",
      "Not yet",
      "1 failing",
      "1 across 1 round",
    ]);
  });

  it("never counts a finding you skipped before it reached GitHub", () => {
    const skipped = issue(9, "r4", {
      sources: ["local-review"],
      githubState: null,
      decision: "decline",
    });
    const resolvedAll = reviewing.items.map((item) => ({
      ...item,
      githubState: "resolved" as const,
    }));
    const progress = reviewProgress({ ...reviewing, items: [...resolvedAll, skipped] });
    expect(progress.headline).toBe("Everything you raised is resolved");
    expect(progress.gates[0]!.value).toBe("7 of 7 resolved");
  });

  it("says a pull request is ready once approved, resolved and passing", () => {
    expect(
      reviewProgress({
        role: "author",
        viewerLogin: "neil",
        authorLogin: "neil",
        sources: [],
        items: [],
        checks: [check("success")],
        reviewDecision: "approved",
      }).headline,
    ).toBe("Ready to merge");
  });
});
