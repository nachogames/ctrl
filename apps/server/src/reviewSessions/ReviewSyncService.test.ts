import { isActiveReviewItem } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
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
      ["PRR_1", 1, true],
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

it.effect("imports future author reviews once and keeps decisions when the head changes", () => {
  const harness: SyncHarness = {
    read: reviewRoundRead({
      reviews: [githubReview("R1", "nach")],
      threads: [githubThread("T1", [threadComment("R1", "First finding")])],
    }),
  };
  return Effect.gen(function* () {
    const repo = yield* ReviewSessions.ReviewSessionRepository;
    const sync = yield* ReviewSyncService.ReviewSyncService;
    const session = sessionFixture();
    yield* repo.insertSession(session);
    yield* repo.upsertRound(session.id, roundFixture(1));
    yield* sync.syncSession(session.id);
    const first = (yield* repo.listItems(session.id))[0]!;
    yield* repo.upsertItem(session.id, {
      ...first,
      decision: "decline",
      decidedBy: "panel",
      draftReply: "Already covered",
      draftReplyBy: "panel",
      viewed: true,
    });
    harness.read = reviewRoundRead({
      headSha: "new-head",
      reviews: [githubReview("R1", "nach"), githubReview("R2", "dan")],
      threads: [
        githubThread("T1", [threadComment("R1", "First finding")]),
        githubThread("T2", [threadComment("R2", "New finding")]),
      ],
    });
    yield* sync.syncSession(session.id);
    assert.isFalse(yield* sync.syncSession(session.id));
    const items = yield* repo.listItems(session.id);
    assert.equal(items.length, 2);
    assert.deepEqual(
      items.map((item) => [item.number, item.decision, item.stale]),
      [
        [1, "decline", true],
        [2, "needs-call", false],
      ],
    );
    assert.equal(items[0]?.draftReply, "Already covered");
    assert.equal(items[0]?.viewed, true);
  }).pipe(Effect.provide(makeSyncLayer(harness)));
});

it.effect("backfills stored sources and refreshes edited text without resetting a decision", () => {
  const harness: SyncHarness = {
    read: reviewRoundRead({
      reviews: [githubReview("R", "dan")],
      threads: [githubThread("T", [threadComment("R", "Old text")])],
    }),
  };
  return Effect.gen(function* () {
    const repo = yield* ReviewSessions.ReviewSessionRepository;
    const sync = yield* ReviewSyncService.ReviewSyncService;
    const sql = yield* SqlClient.SqlClient;
    const session = sessionFixture();
    yield* repo.insertSession(session);
    yield* repo.upsertRound(session.id, roundFixture(1));
    yield* sync.syncSession(session.id);
    // Simulate an older install that has collected sources but no numbered points yet.
    yield* sql`DELETE FROM review_item_keys WHERE session_id = ${session.id}`;
    yield* sql`DELETE FROM review_items WHERE session_id = ${session.id}`;
    yield* sync.syncSession(session.id);
    const [item] = yield* repo.listItems(session.id);
    assert.equal(item?.problem, "Old text");
    yield* repo.upsertItem(session.id, {
      ...item!,
      decision: "decline",
      decidedBy: "panel",
      viewed: true,
    });
    harness.read = reviewRoundRead({
      reviews: [githubReview("R", "dan")],
      threads: [githubThread("T", [threadComment("R", "Edited text")])],
    });
    yield* sync.syncSession(session.id);
    const [edited] = yield* repo.listItems(session.id);
    assert.equal(edited?.number, item?.number);
    assert.equal(edited?.problem, "Edited text");
    assert.equal(edited?.decision, "decline");
    assert.equal(edited?.viewed, false);
  }).pipe(Effect.provide(makeSyncLayer(harness)));
});

it.effect(
  "imports five Copilot attempts as history and only one unresolved finding as active work",
  () => {
    const harness: SyncHarness = {
      read: reviewRoundRead({
        reviews: Array.from({ length: 5 }, (_, i) =>
          githubReview(`R${i}`, "Copilot", {
            body:
              i === 0
                ? "Copilot encountered an error and was unable to review this pull request."
                : "<!-- ccr-overview-v2 -->\n### Changes recommended\n<details><summary>Findings</summary>\n\nSee the inline comments.\n</details>",
            submittedAt: `2026-10-${10 + i}T10:00:00.000Z`,
            commitSha: `commit${i}`,
          }),
        ),
        threads: Array.from({ length: 28 }, (_, i) =>
          githubThread(
            `T${i}`,
            [threadComment(i === 27 ? "R4" : `R${1 + (i % 3)}`, `Finding ${i}`)],
            { isResolved: i < 27, isOutdated: i < 16 },
          ),
        ),
      }),
    };
    return Effect.gen(function* () {
      const repo = yield* ReviewSessions.ReviewSessionRepository;
      const sync = yield* ReviewSyncService.ReviewSyncService;
      const session = sessionFixture();
      yield* repo.insertSession(session);
      yield* repo.upsertRound(session.id, roundFixture(1));
      yield* sync.syncSession(session.id);
      const items = yield* repo.listItems(session.id);
      assert.equal(items.length, 28);
      assert.equal(items.filter(isActiveReviewItem).length, 1);
      assert.equal(items.filter((item) => item.githubState === "resolved").length, 27);
      const sources = yield* repo.listSources(session.id);
      assert.deepEqual(
        sources.map((source) => source.id),
        ["R0", "R1", "R2", "R3", "R4"],
      );
      assert.isTrue(sources[0]!.failed);
      assert.deepEqual(
        sources.filter((source) => !source.triaged).map((source) => source.id),
        ["R4"],
      );
      assert.equal(
        (yield* repo.listSourceComments(session.id, "R4"))[0]?.body.startsWith(
          "<!-- ccr-overview-v2 -->",
        ),
        true,
      );
      assert.isFalse(yield* sync.syncSession(session.id));
      harness.read = {
        ...harness.read!,
        threads: harness.read!.threads.map((thread) => ({ ...thread, isResolved: true })),
      };
      yield* sync.syncSession(session.id);
      assert.equal((yield* repo.listItems(session.id)).filter(isActiveReviewItem).length, 0);
    }).pipe(Effect.provide(makeSyncLayer(harness)));
  },
);
