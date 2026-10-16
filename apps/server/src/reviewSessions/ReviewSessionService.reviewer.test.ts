import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ReviewSessionService from "./ReviewSessionService.ts";
import * as ReviewSyncService from "./ReviewSyncService.ts";
import {
  actor,
  githubReview,
  githubThread,
  importItem,
  makeReviewServiceLayer,
  newHarness,
  openInput,
  reviewRoundRead,
  reviewThreadId,
  threadComment,
} from "./testkit.ts";

const service = ReviewSessionService.ReviewSessionService;

/** Dan wrote the pull request; Neil reviews it. */
const asReviewer = (fields: Parameters<typeof reviewRoundRead>[0] = {}) =>
  reviewRoundRead({ authorLogin: "dan", viewerLogin: "NeilMcEachin", ...fields });

it.effect(
  "runs a reviewer's round: only your points gate it, and posting keeps the review on it",
  () => {
    const harness = newHarness();
    harness.read = asReviewer();
    return Effect.gen(function* () {
      const reviews = yield* service;
      const sync = yield* ReviewSyncService.ReviewSyncService;
      const { snapshot } = yield* reviews.open(openInput);
      const sessionId = snapshot.session.id;
      assert.deepEqual(
        [snapshot.session.authorLogin, snapshot.session.viewerLogin],
        ["dan", "NeilMcEachin"],
      );
      yield* reviews.importItems({
        sessionId,
        sourceIds: [],
        items: [
          // Copilot's alone: context, never decided.
          importItem("gh:T1", { suggestedDecision: null }),
          importItem("local:auth.ts:null-session", { sources: ["local-review"] }),
          // Also Copilot's: a +1 the user skips, leaving the drafted reply behind.
          importItem("gh:T2", {
            sourceKeys: ["gh:T2", "local:auth.ts:retry"],
            sources: ["copilot", "local-review"],
            githubThreadIds: ["T2"],
            draftReply: "Noticed this too.",
          }),
        ],
      });
      yield* reviews.decide({
        sessionId,
        number: 2,
        decision: "fix",
        authority: { _tag: "panel" },
      });
      yield* reviews.decide({
        sessionId,
        number: 3,
        decision: "decline",
        authority: { _tag: "panel" },
      });

      const unposted = yield* Effect.flip(
        reviews.advanceRound({ sessionId, headSha: "abc123", finish: false }),
      );
      assert.include(unposted.message, "#2");
      assert.notInclude(unposted.message, "#1");
      assert.notInclude(unposted.message, "#3");

      yield* reviews.recordApply({
        sessionId,
        number: 2,
        applyState: "replied",
        githubThreadIds: ["T3"],
      });
      const closed = yield* reviews.advanceRound({ sessionId, headSha: "abc123", finish: false });
      assert.equal(closed.session.round, 1);
      assert.equal(closed.rounds.find((round) => round.round === 1)?.state, "applied");

      const early = yield* Effect.flip(
        reviews.requestTurn({ sessionId, request: { _tag: "re-review" } }),
      );
      assert.include(early.message, "Nothing to re-review yet");

      // You submit with changes requested; Dan pushes and asks for your review again.
      harness.read = asReviewer({
        headSha: "def456",
        reviews: [githubReview("PRR_mine", "NeilMcEachin", { state: "CHANGES_REQUESTED" })],
        threads: [
          githubThread("T3", [
            threadComment("PRR_mine", `Null session. <!-- ctrl-review:${sessionId}:1:2 -->`),
          ]),
        ],
        pendingReviewers: [actor("NeilMcEachin")],
      });
      yield* sync.syncSession(sessionId);
      const synced = yield* reviews.read(sessionId);
      const mine = synced.sources.find((source) => source.id === "PRR_mine");
      assert.deepEqual(
        [mine?.round, mine?.verdict, mine?.posted, mine?.triaged],
        [1, "changes-requested", true, true],
      );
      assert.equal(synced.session.viewerRequested, true);
      // What Ctrl posted is not a new point.
      assert.equal(synced.items.length, 3);

      yield* reviews.requestTurn({ sessionId, request: { _tag: "re-review" } });
      assert.include(harness.sent.at(-1)?.text ?? "", "Re-review");
      assert.equal(harness.sent.at(-1)?.threadId, reviewThreadId);

      // The follow-up check raises your thread again: last round's Post is not this round's Resolve.
      const followUp = yield* reviews.importItems({
        sessionId,
        sourceIds: [],
        items: [
          importItem("local:auth.ts:null-session", {
            sources: ["local-review"],
            suggestedDecision: "decline",
            draftReply: "Still null when the token expires.",
          }),
        ],
      });
      const two = followUp.snapshot.items.find((item) => item.number === 2);
      assert.deepEqual(
        [two?.lastSeenRound, two?.decision, two?.suggestedDecision],
        [2, "needs-call", "decline"],
      );
      yield* reviews.decide({
        sessionId,
        number: 2,
        decision: "decline",
        authority: { _tag: "panel" },
      });
      const keepOpen = yield* Effect.flip(
        reviews.advanceRound({ sessionId, headSha: "def456", finish: false }),
      );
      assert.include(keepOpen.message, "#2");
      yield* reviews.recordApply({ sessionId, number: 2, applyState: "replied" });
      yield* reviews.advanceRound({ sessionId, headSha: "def456", finish: false });

      yield* reviews.requestTurn({ sessionId, request: { _tag: "finish" } });
      assert.equal((yield* reviews.read(sessionId)).session.phase, "done");
    }).pipe(Effect.provide(makeReviewServiceLayer(harness)));
  },
);

it.effect("keeps your own pull request's loop: Finish is not offered there", () => {
  const harness = newHarness();
  harness.read = reviewRoundRead();
  return Effect.gen(function* () {
    const reviews = yield* service;
    const { snapshot } = yield* reviews.open(openInput);
    const refused = yield* Effect.flip(
      reviews.requestTurn({ sessionId: snapshot.session.id, request: { _tag: "finish" } }),
    );
    assert.include(refused.message, "Finish is for reviewing someone else's pull request");
  }).pipe(Effect.provide(makeReviewServiceLayer(harness)));
});

it.effect(
  "re-reviews only a posted round, never with a pending review open, and leaves your verdict behind",
  () => {
    const harness = newHarness();
    harness.read = asReviewer();
    return Effect.gen(function* () {
      const reviews = yield* service;
      const sync = yield* ReviewSyncService.ReviewSyncService;
      const { snapshot } = yield* reviews.open(openInput);
      const sessionId = snapshot.session.id;
      yield* reviews.importItems({
        sessionId,
        sourceIds: [],
        items: [importItem("local:auth.ts:null-session", { sources: ["local-review"] })],
      });
      yield* reviews.decide({
        sessionId,
        number: 1,
        decision: "fix",
        authority: { _tag: "panel" },
      });
      yield* reviews.recordApply({ sessionId, number: 1, applyState: "working" });
      const applying = yield* Effect.flip(
        reviews.requestTurn({ sessionId, request: { _tag: "re-review" } }),
      );
      assert.include(applying.message, "Finish this round first");
      yield* reviews.recordApply({ sessionId, number: 1, applyState: "replied" });
      yield* reviews.advanceRound({ sessionId, headSha: "abc123", finish: false });

      // You approved straight on GitHub (no marker), started another pending review, and Dan pushed.
      harness.read = asReviewer({
        headSha: "def456",
        reviews: [
          githubReview("PRR_approved", "NeilMcEachin", { state: "APPROVED", body: "LGTM" }),
          githubReview("PRR_draft", "NeilMcEachin", { state: "PENDING", submittedAt: null }),
        ],
      });
      yield* sync.syncSession(sessionId);
      const pending = yield* Effect.flip(
        reviews.requestTurn({ sessionId, request: { _tag: "re-review" } }),
      );
      assert.include(pending.message, "Submit your pending review on GitHub first");

      harness.read = asReviewer({
        headSha: "def456",
        reviews: [
          githubReview("PRR_approved", "NeilMcEachin", { state: "APPROVED", body: "LGTM" }),
        ],
      });
      yield* sync.syncSession(sessionId);
      // The draft you deleted on GitHub stops holding Re-review.
      const synced = yield* reviews.read(sessionId);
      assert.isUndefined(synced.sources.find((source) => source.id === "PRR_draft"));
      yield* reviews.requestTurn({ sessionId, request: { _tag: "re-review" } });
      const next = yield* reviews.read(sessionId);
      assert.equal(next.session.round, 2);
      // Your approval answered round 1; it does not count as round 2's review.
      assert.equal(next.sources.find((source) => source.id === "PRR_approved")?.round, 1);
    }).pipe(Effect.provide(makeReviewServiceLayer(harness)));
  },
);
