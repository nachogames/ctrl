import type {
  ReviewItem,
  ReviewSessionSnapshot,
  ReviewSource,
  ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  draftUpdateLabel,
  offersLocalReview,
  ranOnLabel,
  replyTarget,
  reviewApplyLines,
  reviewPointMentionCounts,
  reviewRoundViews,
  rewritePending,
  sameReviewItem,
  toggledDecision,
  triageButton,
  triageInFlight,
} from "./pullRequestReview.logic";

const round = (n: number, state: "collecting" | "applying" | "applied") => ({
  round: n,
  headSha: "abc",
  state,
  appliedSha: null,
  createdAt: "t",
  updatedAt: "t",
});
const point = (number: number, lastSeenRound: number, stale: boolean) =>
  ({ number, lastSeenRound, stale }) as ReviewItem;
const source = (id: string, round: number, kind: ReviewSource["kind"], state = "done") =>
  ({ id, round, kind, state }) as ReviewSource;

describe("reviewRoundViews", () => {
  it("lists rounds newest first, each with its own reviews and points", () => {
    const snapshot = {
      session: { round: 2, phase: "self-review" },
      rounds: [round(2, "collecting"), round(1, "applied")],
      sources: [source("PRR_2", 2, "copilot", "reviewing"), source("PRR_1", 1, "copilot")],
      items: [point(1, 1, true), point(2, 2, false), point(3, 1, true)],
    } as unknown as ReviewSessionSnapshot;
    expect(
      reviewRoundViews(snapshot).map((view) => [
        view.round.round,
        view.current,
        view.sources.map((s) => s.id),
        view.items.map((i) => i.number),
      ]),
    ).toEqual([
      [2, true, ["PRR_2"], [2]],
      [1, false, ["PRR_1"], [1, 3]],
    ]);
  });
});

describe("review tab helpers", () => {
  it("counts the user's messages sent about each point", () => {
    const counts = reviewPointMentionCounts([
      { role: "user", text: "[#2 build cache key]\nwhy?" },
      { role: "user", text: "[#2 build cache key]\nok, shorter" },
      { role: "assistant", text: "[#3 pin]\nnot a tag from the user" },
      { role: "user", text: "#3 decline" },
      { role: "user", createdBy: "system", text: "[#2 build cache key]\nrewrite" },
      { role: "user", createdBy: "agent", text: "[#2 build cache key]\nseed" },
    ]);
    expect([...counts]).toEqual([[2, 2]]);
  });

  it("names the model a local review ran on", () => {
    const providers = [
      { instanceId: "claudeAgent", models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5" }] },
    ] as unknown as ReadonlyArray<ServerProvider>;
    expect(
      ranOnLabel({ instanceId: "claudeAgent", model: "claude-opus-5-5" } as never, providers),
    ).toBe("Claude Opus 5.5");
    expect(ranOnLabel({ instanceId: "codex", model: "gpt-6" } as never, providers)).toBe("gpt-6");
    expect(ranOnLabel(null, providers)).toBeNull();
  });

  it("knows whom a reply goes to", () => {
    expect(replyTarget({ githubThreadIds: ["T1"], sources: ["copilot"] } as never)).toBe("Copilot");
    expect(replyTarget({ githubThreadIds: ["T1"], sources: ["human:dan"] } as never)).toBe("dan");
    expect(replyTarget({ githubThreadIds: [], sources: ["local-review"] } as never)).toBeNull();
  });

  it("offers your review only in a collecting round that has none", () => {
    const view = (
      sources: ReadonlyArray<ReviewSource>,
      state: "collecting" | "applying" = "collecting",
    ) => ({ round: round(1, state), current: true, sources, items: [] }) as never;
    expect(offersLocalReview(view([source("PRR_1", 1, "copilot")]))).toBe(true);
    expect(offersLocalReview(view([source("local:1", 1, "local", "reviewing")]))).toBe(false);
    expect(offersLocalReview(view([source("local:1", 1, "local", "not-run")]))).toBe(true);
    expect(offersLocalReview(view([], "applying"))).toBe(false);
  });

  it("marks a reply the agent rewrote while the point was open", () => {
    expect(draftUpdateLabel({ draftReplyRevision: 3, draftReplyBy: "agent" } as never, 2)).toBe(
      "Updated from chat",
    );
    expect(
      draftUpdateLabel({ draftReplyRevision: 3, draftReplyBy: "panel" } as never, 2),
    ).toBeNull();
    expect(
      draftUpdateLabel({ draftReplyRevision: 2, draftReplyBy: "agent" } as never, 2),
    ).toBeNull();
  });

  it("treats a point re-sent unchanged as the same, and any changed field as new", () => {
    const item = {
      number: 2,
      sources: ["copilot", "local-review"],
      githubThreadIds: ["T1"],
      alreadyFixedIn: { number: 24, url: "https://github.com/o/r/pull/24" },
      viewed: false,
      draftReply: "Fixed.",
    } as unknown as ReviewItem;
    const resent = structuredClone(item);
    expect(sameReviewItem(item, resent)).toBe(true);
    expect(sameReviewItem(item, { ...resent, viewed: true })).toBe(false);
    expect(sameReviewItem(item, { ...resent, sources: ["copilot"] })).toBe(false);
    expect(sameReviewItem(item, { ...resent, alreadyFixedIn: null })).toBe(false);
    expect(
      sameReviewItem(item, {
        ...resent,
        alreadyFixedIn: { number: 25, url: "https://github.com/o/r/pull/25" },
      }),
    ).toBe(false);
  });
});

describe("triage in flight", () => {
  const triaged = (id: string, done: boolean) =>
    ({ id, round: 1, kind: "copilot", state: "done", triaged: done }) as ReviewSource;

  it("lasts until every review it covered is triaged, and ends if one is gone", () => {
    expect(triageInFlight([], [triaged("A", false)])).toBe(false);
    expect(triageInFlight(["A", "B"], [triaged("A", true), triaged("B", false)])).toBe(true);
    expect(triageInFlight(["A", "B"], [triaged("A", true), triaged("B", true)])).toBe(false);
    expect(triageInFlight(["A"], [])).toBe(false);
  });

  it("shows Triage disabled before any review is in, busy while triaging, gone once done", () => {
    const view = (
      sources: ReadonlyArray<ReviewSource>,
      state: "collecting" | "applying" = "collecting",
    ) => ({ round: round(1, state), current: true, sources, items: [] }) as never;
    const reviewing = { ...triaged("A", false), state: "reviewing" } as ReviewSource;
    expect(triageButton(view([reviewing]), [])).toEqual({
      label: "Triage",
      busy: false,
      ready: false,
    });
    expect(triageButton(view([]), [])).toEqual({ label: "Triage", busy: false, ready: false });
    expect(triageButton(view([triaged("A", false), triaged("B", false)]), [])).toEqual({
      label: "Triage both",
      busy: false,
      ready: true,
    });
    expect(triageButton(view([triaged("A", false)]), ["A"])).toEqual({
      label: "Triaging…",
      busy: true,
      ready: false,
    });
    expect(triageButton(view([triaged("A", true)]), ["A"])).toBeNull();
    expect(triageButton(view([triaged("A", false)], "applying"), [])).toBeNull();
  });
});

describe("reply rewrite in flight", () => {
  it("waits for the next write of the draft", () => {
    expect(rewritePending(null, 3)).toBe(false);
    expect(rewritePending(3, 3)).toBe(true);
    expect(rewritePending(3, 4)).toBe(false);
  });
});

describe("toggledDecision", () => {
  const suggested = { decision: "needs-call", suggestedDecision: "fix" } as const;
  const decided = { decision: "decline", suggestedDecision: "fix" } as const;

  it("turns a click on Claude's pressed call into the user's decision", () => {
    expect(toggledDecision(suggested, [])).toBe("fix");
    expect(toggledDecision(suggested, ["decline"])).toBe("decline");
  });

  it("switches an explicit decision, or clears it back to Claude's call", () => {
    expect(toggledDecision(decided, ["fix"])).toBe("fix");
    expect(toggledDecision(decided, [])).toBe("needs-call");
  });

  it("sends nothing for a point with no call and no decision clicked off", () => {
    expect(toggledDecision({ decision: "needs-call", suggestedDecision: null }, [])).toBeNull();
    expect(toggledDecision({ decision: "needs-call", suggestedDecision: null }, ["fix"])).toBe(
      "fix",
    );
  });
});

describe("reviewApplyLines", () => {
  it("says exactly what apply will do, and what it never does", () => {
    expect(reviewApplyLines({ fixes: [1, 2, 5], replies: 3, resolves: 2, findings: 4 })).toEqual([
      "Fix #1 #2 #5, run the checks, then commit and push. Never a force push.",
      "Reply to 3 threads with the drafts you approved.",
      "Post your review as a record: its 4 findings and what was decided for each.",
      "Resolve 2 threads (yours, Copilot's and Claude's). Human threads only get a reply.",
    ]);
    expect(reviewApplyLines({ fixes: [], replies: 1, resolves: 0, findings: 0 })).toEqual([
      "Reply to 1 thread with the drafts you approved.",
      "Post your review as a record of what was decided.",
    ]);
  });
});
