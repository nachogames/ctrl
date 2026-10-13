import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ReviewSessionChanges from "./ReviewSessionChanges.ts";

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
    const held = yield* repo.listSources(session.id);
    assert.isFalse(held.some((source) => source.id === "PRR_dan"));
    // Dan's review landed, only held: his request is not withdrawn.
    assert.equal(held.find((source) => source.id === "request:1:dan")?.state, "requested");

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

it.effect("leaves a review that landed while the round moved on to the next sync", () => {
  const harness: SyncHarness = {
    read: reviewRoundRead({ reviews: [githubReview("PRR_dan", "dan")] }),
  };
  return Effect.gen(function* () {
    const repo = yield* ReviewSessions.ReviewSessionRepository;
    const sync = yield* ReviewSyncService.ReviewSyncService;
    const session = sessionFixture();
    yield* repo.insertSession(session);
    yield* repo.upsertRound(session.id, roundFixture(1));
    // Round 1 is applied and round 2 opens while GitHub is being read.
    harness.duringRead = Effect.gen(function* () {
      harness.duringRead = undefined;
      yield* repo.upsertRound(session.id, roundFixture(1, { state: "applied" }));
      yield* repo.upsertRound(session.id, roundFixture(2));
      yield* repo.updateSession({ ...session, round: 2 });
    }).pipe(Effect.orDie);
    assert.isFalse(yield* sync.syncSession(session.id));
    assert.deepEqual(yield* repo.listSources(session.id), []);
    // The next sync files it in the round that is open now.
    assert.isTrue(yield* sync.syncSession(session.id));
    assert.deepEqual(
      (yield* repo.listSources(session.id)).map((source) => [source.id, source.round]),
      [["PRR_dan", 2]],
    );
  }).pipe(Effect.provide(makeSyncLayer(harness)));
});

it.effect("keeps sweeping after a sweep dies", () => {
  let fingerprints = 0;
  const layer = ReviewSyncService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ReviewSessions.layer,
        ReviewSessionChanges.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          reviewRound: () => Effect.succeed(null),
          watchFingerprint: () => {
            fingerprints += 1;
            return fingerprints === 1 ? Effect.die("GitHub client bug") : Effect.succeed(null);
          },
        }),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  return Effect.gen(function* () {
    const repo = yield* ReviewSessions.ReviewSessionRepository;
    const sync = yield* ReviewSyncService.ReviewSyncService;
    const session = sessionFixture();
    yield* repo.insertSession(session);
    yield* repo.upsertRound(session.id, roundFixture(1));
    yield* sync.start();
    yield* TestClock.adjust("1 second");
    assert.equal(fingerprints, 1);
    yield* TestClock.adjust("2 minutes");
    assert.equal(fingerprints, 2);
  }).pipe(Effect.scoped, Effect.provide(layer));
});
