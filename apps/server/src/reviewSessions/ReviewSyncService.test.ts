import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ReviewSessions from "../persistence/ReviewSessions.ts";
import * as ReviewSyncService from "./ReviewSyncService.ts";
import {
  githubReview,
  githubThread,
  itemFixture,
  actor,
  makeSyncLayer,
  reviewRoundRead,
  roundFixture,
  sessionFixture,
  threadComment,
  type SyncHarness,
} from "./testkit.ts";

it.effect("syncs GitHub reviews without touching the user's decisions", () => {
  const harness: SyncHarness = {
    read: reviewRoundRead({
      reviews: [
        githubReview("PRR_1", "copilot-pull-request-reviewer", { isBot: true }),
        // Ctrl posted this as the PR's author: a record, never feedback.
        githubReview("PRR_own", "nach", { body: "Self-review, round 1" }),
      ],
      pendingReviewers: [actor("dan")],
      threads: [
        githubThread("T1", [threadComment("PRR_1", "The cache key ignores the patch.")]),
        githubThread("T2", [threadComment("PRR_own", "Fixed in b4c5d6e.")]),
      ],
    }),
  };
  return Effect.gen(function* () {
    const repo = yield* ReviewSessions.ReviewSessionRepository;
    const sync = yield* ReviewSyncService.ReviewSyncService;
    const session = sessionFixture();
    yield* repo.insertSession(session);
    yield* repo.upsertRound(session.id, roundFixture(1));
    yield* repo.upsertItem(
      session.id,
      itemFixture(1, {
        sourceKeys: ["gh:T1"],
        githubThreadIds: ["T1"],
        decision: "fix",
        decidedBy: "panel",
        viewed: true,
        draftReply: "Good catch.",
        draftReplyRevision: 1,
        draftReplyBy: "agent",
      }),
    );

    assert.isTrue(yield* sync.syncSession(session.id));
    // Nothing moved on GitHub, so nothing is written or announced.
    assert.isFalse(yield* sync.syncSession(session.id));
    const sources = yield* repo.listSources(session.id);
    assert.deepEqual(
      sources.map((source) => [source.id, source.kind, source.state, source.round]).sort(),
      [
        ["PRR_1", "copilot", "done", 1],
        ["request:1:dan", "human", "requested", 1],
      ],
    );
    const [point] = yield* repo.listItems(session.id);
    assert.deepEqual(point?.sourceIds, ["PRR_1"]);
    assert.deepEqual(
      [point?.decision, point?.viewed, point?.draftReply, point?.githubState],
      ["fix", true, "Good catch.", "open"],
    );

    // Copilot's thread is resolved on GitHub; Dan's review lands while round 1 applies.
    yield* repo.upsertRound(session.id, roundFixture(1, { state: "applying" }));
    harness.read = reviewRoundRead({
      reviews: [
        githubReview("PRR_1", "copilot-pull-request-reviewer", { isBot: true }),
        githubReview("PRR_dan", "dan"),
      ],
      pendingReviewers: [],
      threads: [
        githubThread("T1", [threadComment("PRR_1", "The cache key ignores the patch.")], {
          isResolved: true,
        }),
        githubThread("T3", [threadComment("PRR_dan", "Rename readAppConfig.")]),
      ],
    });
    yield* sync.syncSession(session.id);
    assert.equal((yield* repo.listItems(session.id))[0]?.githubState, "resolved");
    assert.isFalse((yield* repo.listSources(session.id)).some((source) => source.id === "PRR_dan"));

    // Once the round advances, the held review lands in round 2 and replaces Dan's request.
    yield* repo.upsertRound(session.id, roundFixture(1, { state: "applied" }));
    yield* repo.upsertRound(session.id, roundFixture(2));
    yield* repo.updateSession({ ...session, round: 2 });
    yield* sync.syncSession(session.id);
    const after = yield* repo.listSources(session.id);
    assert.deepEqual(after.map((source) => [source.id, source.round, source.triaged]).sort(), [
      ["PRR_1", 1, false],
      ["PRR_dan", 2, false],
    ]);
    const [stillDecided] = yield* repo.listItems(session.id);
    assert.deepEqual([stillDecided?.decision, stillDecided?.viewed], ["fix", true]);
  }).pipe(Effect.provide(makeSyncLayer(harness)));
});
