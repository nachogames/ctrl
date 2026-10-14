import { assert, it } from "@effect/vitest";
import { ThreadGroupId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ReviewSessions from "../persistence/ReviewSessions.ts";
import * as ReviewSessionService from "./ReviewSessionService.ts";
import {
  at,
  chatShell,
  githubReview,
  githubThread,
  importItem,
  insertProjectionMessage,
  localSourceFixture,
  makeReviewServiceLayer,
  newHarness,
  openInput,
  prKey,
  prLink,
  reviewRoundRead,
  reviewThreadId,
  sourceComment,
  threadComment,
} from "./testkit.ts";

const service = ReviewSessionService.ReviewSessionService;

it.effect("keeps numbers and decisions when the same points are imported again", () =>
  Effect.gen(function* () {
    const reviews = yield* service;
    const { snapshot } = yield* reviews.open(openInput);
    const sessionId = snapshot.session.id;
    yield* reviews.importItems({
      sessionId,
      sourceIds: [],
      items: [
        importItem("gh:T1"),
        importItem("local:auth.ts:null-session", { sources: ["local-review"] }),
      ],
    });
    yield* reviews.decide({ sessionId, number: 1, decision: "fix", authority: { _tag: "panel" } });
    const again = yield* reviews.importItems({
      sessionId,
      sourceIds: [],
      items: [
        importItem("local:auth.ts:null-session", { sources: ["local-review"] }),
        importItem("gh:T1"),
        importItem("gh:T3"),
      ],
    });
    assert.deepEqual(again.created, [3]);
    assert.deepEqual(again.matched, [2, 1]);
    assert.deepEqual(
      again.snapshot.items.map((item) => [item.number, item.sourceKeys[0], item.decision]),
      [
        [1, "gh:T1", "fix"],
        [2, "local:auth.ts:null-session", "needs-call"],
        [3, "gh:T3", "needs-call"],
      ],
    );
    assert.equal(again.snapshot.session.nextNumber, 4);
  }).pipe(Effect.provide(makeReviewServiceLayer(newHarness()))),
);

it.effect("recovers an already posted review without starting another local review", () => {
  const harness = newHarness();
  harness.read = reviewRoundRead({
    reviews: [githubReview("PRR_existing", "project-owner")],
    threads: [githubThread("T_existing", [threadComment("PRR_existing", "lost corrections")])],
  });
  return Effect.gen(function* () {
    const reviews = yield* service;
    const opened = yield* reviews.open(openInput);
    const sessionId = opened.snapshot.session.id;
    assert.deepEqual(
      opened.snapshot.sources.map((source) => source.id),
      ["PRR_existing"],
    );
    const imported = yield* reviews.importItems({
      sessionId,
      sourceIds: ["PRR_existing"],
      items: [
        importItem("gh:T_existing", {
          sources: ["human:project-owner"],
          githubThreadIds: ["T_existing"],
        }),
      ],
    });
    assert.equal(imported.snapshot.items.length, 1);
    yield* reviews.decide({
      sessionId,
      number: 1,
      decision: "decline",
      authority: { _tag: "panel" },
    });
    const reopened = yield* reviews.open(openInput);
    assert.equal(reopened.snapshot.session.id, sessionId);
    assert.equal(reopened.snapshot.items[0]?.decision, "decline");
    assert.deepEqual(
      reopened.snapshot.sources.map((source) => source.id),
      ["PRR_existing"],
    );
  }).pipe(Effect.provide(makeReviewServiceLayer(harness)));
});

it.effect("merges one problem from both reviewers into one point", () => {
  const harness = newHarness();
  harness.read = reviewRoundRead({
    reviews: [githubReview("PRR_1", "copilot-pull-request-reviewer", { isBot: true })],
    threads: [githubThread("T1", [threadComment("PRR_1", "session can be null")])],
  });
  return Effect.gen(function* () {
    const reviews = yield* service;
    const repo = yield* ReviewSessions.ReviewSessionRepository;
    const { snapshot } = yield* reviews.open(openInput);
    const sessionId = snapshot.session.id;
    // Opening synced Copilot's review into round 1.
    assert.deepEqual(
      snapshot.sources.map((source) => [source.id, source.state]),
      [["PRR_1", "done"]],
    );
    yield* repo.upsertSource(sessionId, localSourceFixture("local:run-1"), [
      sourceComment("local:auth.ts:null-session", "session may be null"),
    ]);
    // Triage lists the shared problem once, under both keys.
    const first = yield* reviews.importItems({
      sessionId,
      sourceIds: ["PRR_1", "local:run-1"],
      items: [
        importItem("gh:T1", {
          sourceKeys: ["gh:T1", "local:auth.ts:null-session"],
          sources: ["copilot", "local-review"],
          githubThreadIds: ["T1"],
        }),
      ],
    });
    assert.deepEqual(first.matched, [1]);
    const [point] = first.snapshot.items;
    assert.deepEqual(point?.sources, ["copilot", "local-review"]);
    assert.deepEqual(point?.sourceIds, ["PRR_1", "local:run-1"]);
    assert.isTrue(first.snapshot.sources.every((source) => source.triaged));
    // A later local finding keyed the same way is the same point.
    const later = yield* reviews.importItems({
      sessionId,
      sourceIds: [],
      items: [importItem("local:auth.ts:null-session", { sources: ["local-review"] })],
    });
    assert.deepEqual([later.created, later.matched], [[], [1]]);
    const unknown = yield* Effect.flip(
      reviews.importItems({ sessionId, sourceIds: ["PRR_missing"], items: [] }),
    );
    assert.include(unknown.message, "PRR_missing");
  }).pipe(Effect.provide(makeReviewServiceLayer(harness)));
});

it.effect("refuses a decision the user did not state, and records one they did", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reviews = yield* service;
    const { snapshot } = yield* reviews.open(openInput);
    const sessionId = snapshot.session.id;
    yield* reviews.importItems({
      sessionId,
      sourceIds: [],
      items: [importItem("gh:T1"), importItem("gh:T2")],
    });
    const decideTwo = (quote: string) =>
      reviews.decide({
        sessionId,
        number: 2,
        decision: "decline",
        reason: "Out of scope",
        authority: { _tag: "chat", threadId: reviewThreadId, quote },
      });

    const unspoken = yield* Effect.flip(decideTwo("decline"));
    assert.include(unspoken.message, "written nothing");

    yield* insertProjectionMessage(sql, {
      threadId: reviewThreadId,
      messageId: "m1",
      text: "why #2?",
      createdAt: "2026-10-13T10:00:00.000Z",
    });
    const question = yield* Effect.flip(decideTwo("why #2?"));
    assert.include(question.message, "question");
    assert.equal((yield* reviews.read(sessionId)).items[1]?.decision, "needs-call");

    yield* insertProjectionMessage(sql, {
      threadId: reviewThreadId,
      messageId: "m2",
      text: "#2 decline: out of scope",
      createdAt: "2026-10-13T10:01:00.000Z",
    });
    const decided = yield* decideTwo("decline: out of scope");
    assert.deepEqual(
      [decided.decision, decided.decidedBy, decided.reason, decided.viewed],
      ["decline", "chat", "Out of scope", false],
    );
  }).pipe(Effect.provide(makeReviewServiceLayer(newHarness()))),
);

it.effect("keeps one live review per pull request per group", () =>
  Effect.gen(function* () {
    const reviews = yield* service;
    const first = yield* reviews.open(openInput);
    const again = yield* reviews.open(openInput);
    assert.isTrue(first.created);
    assert.isFalse(again.created);
    assert.equal(again.snapshot.session.id, first.snapshot.session.id);
    assert.deepEqual(
      first.snapshot.rounds.map((round) => [round.round, round.state]),
      [[1, "collecting"]],
    );

    const otherGroup = yield* reviews.open({
      ...openInput,
      groupId: ThreadGroupId.make("group:other"),
    });
    assert.isTrue(otherGroup.created);

    yield* reviews.advanceRound({
      sessionId: first.snapshot.session.id,
      headSha: "abc123",
      finish: true,
    });
    const reopened = yield* reviews.open(openInput);
    assert.isTrue(reopened.created);
    assert.notEqual(reopened.snapshot.session.id, first.snapshot.session.id);
  }).pipe(Effect.provide(makeReviewServiceLayer(newHarness()))),
);

it.effect("will not apply until every point in the round is viewed", () =>
  Effect.gen(function* () {
    const reviews = yield* service;
    const { snapshot } = yield* reviews.open(openInput);
    const sessionId = snapshot.session.id;
    yield* reviews.importItems({
      sessionId,
      sourceIds: [],
      items: [
        importItem("gh:T1", { suggestedDecision: "fix" }),
        importItem("gh:T2", { suggestedDecision: "decline", draftReply: "Out of scope." }),
        importItem("gh:T3", { suggestedDecision: null }),
      ],
    });
    const blocked = yield* Effect.flip(
      reviews.recordApply({ sessionId, number: 1, applyState: "working" }),
    );
    assert.include(blocked.message, "#1, #2, #3");

    // Viewing adopts Claude's call as the user's decision.
    const one = yield* reviews.setViewed({ sessionId, number: 1, viewed: true });
    assert.deepEqual([one.decision, one.decidedBy, one.viewed], ["fix", "panel", true]);
    const noCall = yield* Effect.flip(reviews.setViewed({ sessionId, number: 3, viewed: true }));
    assert.include(noCall.message, "Pick Fix or Decline");
    yield* reviews.decide({
      sessionId,
      number: 3,
      decision: "decline",
      authority: { _tag: "panel" },
    });
    yield* reviews.setViewed({ sessionId, number: 3, viewed: true });
    yield* reviews.setViewed({ sessionId, number: 2, viewed: true });

    // A changed suggestion is unseen again; a reply edit is not.
    const resuggested = yield* reviews.annotate({
      sessionId,
      number: 2,
      annotation: { suggestedDecision: "fix", draftReply: "Fixed." },
    });
    assert.deepEqual(
      [resuggested.viewed, resuggested.draftReplyRevision, resuggested.draftReplyBy],
      [false, 2, "agent"],
    );
    yield* reviews.setViewed({ sessionId, number: 2, viewed: true });
    const edited = yield* reviews.editReply({
      sessionId,
      number: 2,
      draftReply: "Leaving this for now.",
    });
    assert.deepEqual(
      [edited.viewed, edited.draftReplyRevision, edited.draftReplyBy],
      [true, 3, "panel"],
    );

    const working = yield* reviews.recordApply({ sessionId, number: 1, applyState: "working" });
    assert.equal(working.applyState, "working");
    assert.equal((yield* reviews.read(sessionId)).rounds[0]?.state, "applying");
    const stillFixing = yield* Effect.flip(
      reviews.advanceRound({ sessionId, headSha: "def456", finish: false }),
    );
    assert.include(stillFixing.message, "#1");

    yield* reviews.recordApply({
      sessionId,
      number: 1,
      applyState: "fixed",
      conclusion: "Returns 401.",
    });
    const advanced = yield* reviews.advanceRound({ sessionId, headSha: "def456", finish: false });
    assert.equal(advanced.session.round, 2);
    assert.deepEqual(
      advanced.rounds.map((round) => [round.round, round.state, round.appliedSha]),
      [
        [2, "collecting", null],
        [1, "applied", "def456"],
      ],
    );
    assert.isTrue(advanced.items.every((item) => item.stale));

    const reraised = yield* reviews.importItems({
      sessionId,
      sourceIds: [],
      items: [importItem("gh:T2")],
    });
    const two = reraised.snapshot.items.find((item) => item.number === 2);
    assert.deepEqual(
      [two?.lastSeenRound, two?.stale, two?.viewed, two?.decision],
      [2, false, false, "decline"],
    );
  }).pipe(Effect.provide(makeReviewServiceLayer(newHarness()))),
);

it.effect("sends the Review tab a fresh snapshot after every change", () =>
  Effect.gen(function* () {
    const reviews = yield* service;
    const { snapshot } = yield* reviews.open(openInput);
    const subscribed = yield* Deferred.make<void>();
    const fiber = yield* reviews
      .subscribe({ threadId: reviewThreadId, repository: prKey.repository, number: prKey.number })
      .pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
    yield* Deferred.await(subscribed);
    yield* reviews.importItems({
      sessionId: snapshot.session.id,
      sourceIds: [],
      items: [importItem("gh:T1")],
    });
    const emitted = Array.from(yield* Fiber.join(fiber));
    assert.deepEqual(
      emitted.map((result) => result.snapshot?.items.length),
      [0, 1],
    );
  }).pipe(Effect.provide(makeReviewServiceLayer(newHarness()))),
);

it.effect("follows a group change after discovering an ungrouped chat's review", () => {
  const harness = newHarness();
  const caller = ThreadId.make("thread:caller");
  harness.shells.set(caller, chatShell(caller, { groupId: null }));
  return Effect.gen(function* () {
    const reviews = yield* service;
    const subscribed = yield* Deferred.make<void>();
    const fiber = yield* reviews
      .subscribe({ threadId: caller, repository: prKey.repository, number: prKey.number })
      .pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
    yield* Deferred.await(subscribed);
    // The skill puts the chat in a group, then opens the review from it.
    harness.shells.set(caller, chatShell(caller));
    yield* reviews.open({ ...openInput, reviewThreadId: caller });
    const emitted = Array.from(yield* Fiber.join(fiber));
    assert.deepEqual(
      emitted.map((result) => result.snapshot?.session.reviewThreadId ?? null),
      [caller, caller],
    );
  }).pipe(Effect.provide(makeReviewServiceLayer(harness)));
});

it.effect("follows a chat moved to another group to that group's review", () => {
  const harness = newHarness();
  const otherGroup = ThreadGroupId.make("group:other");
  return Effect.gen(function* () {
    const reviews = yield* service;
    const first = yield* reviews.open(openInput);
    const subscribed = yield* Deferred.make<void>();
    const fiber = yield* reviews
      .subscribe({ threadId: reviewThreadId, repository: prKey.repository, number: prKey.number })
      .pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
    yield* Deferred.await(subscribed);
    harness.shells.set(reviewThreadId, chatShell(reviewThreadId, { groupId: otherGroup }));
    const moved = yield* reviews.open({ ...openInput, groupId: otherGroup });
    const emitted = Array.from(yield* Fiber.join(fiber));
    assert.deepEqual(
      emitted.map((result) => result.snapshot?.session.id),
      [first.snapshot.session.id, moved.snapshot.session.id],
    );
  }).pipe(Effect.provide(makeReviewServiceLayer(harness)));
});

it.effect("tells the agent which point a message is about and what else is in the stack", () => {
  const harness = newHarness();
  harness.projectThreads.push(
    chatShell(ThreadId.make("thread:build"), {
      pullRequests: [
        prLink(23, "fix/fingerprint", "main"),
        prLink(24, "chore/pin-fingerprint", "fix/fingerprint"),
      ],
    }),
  );
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reviews = yield* service;
    const { snapshot } = yield* reviews.open(openInput);
    yield* reviews.importItems({
      sessionId: snapshot.session.id,
      sourceIds: [],
      items: [importItem("gh:T1")],
    });
    yield* insertProjectionMessage(sql, {
      threadId: reviewThreadId,
      messageId: "m1",
      text: "[#1 point gh:T1]\nwhy not a version bump?",
      createdAt: at,
    });
    const view = yield* reviews.agentView({
      sessionId: snapshot.session.id,
      threadId: reviewThreadId,
    });
    assert.equal(view.focusedItem, 1);
    assert.deepEqual(
      view.stack.map((neighbour) => [neighbour.number, neighbour.relation]),
      [[24, "stacked"]],
    );
  }).pipe(Effect.provide(makeReviewServiceLayer(harness)));
});

it.effect("merges a point whose keys span two points into the lower one", () =>
  Effect.gen(function* () {
    const reviews = yield* service;
    const { snapshot } = yield* reviews.open(openInput);
    const sessionId = snapshot.session.id;
    yield* reviews.importItems({
      sessionId,
      sourceIds: [],
      items: [importItem("gh:T1"), importItem("gh:T2")],
    });
    const merged = yield* reviews.importItems({
      sessionId,
      sourceIds: [],
      items: [importItem("gh:T2", { sourceKeys: ["gh:T2", "gh:T1", "gh:T9"] })],
    });
    assert.deepEqual([merged.created, merged.matched], [[], [1]]);
    // A key belongs to one point: #2 keeps its own, #1 gains only the new one.
    assert.deepEqual(
      merged.snapshot.items.map((item) => [item.number, item.sourceKeys]),
      [
        [1, ["gh:T1", "gh:T9"]],
        [2, ["gh:T2"]],
      ],
    );
    assert.equal(merged.snapshot.session.nextNumber, 3);
  }).pipe(Effect.provide(makeReviewServiceLayer(newHarness()))),
);

it.effect("leaves the GitHub state sync recorded when a point changes", () =>
  Effect.gen(function* () {
    const reviews = yield* service;
    const repo = yield* ReviewSessions.ReviewSessionRepository;
    const { snapshot } = yield* reviews.open(openInput);
    const sessionId = snapshot.session.id;
    yield* reviews.importItems({ sessionId, sourceIds: [], items: [importItem("gh:T1")] });
    yield* repo.setItemGithubState(sessionId, 1, "resolved");
    yield* reviews.decide({ sessionId, number: 1, decision: "fix", authority: { _tag: "panel" } });
    yield* reviews.annotate({ sessionId, number: 1, annotation: { recommendation: "Fix it." } });
    yield* reviews.importItems({ sessionId, sourceIds: [], items: [importItem("gh:T1")] });
    assert.equal((yield* reviews.read(sessionId)).items[0]?.githubState, "resolved");
  }).pipe(Effect.provide(makeReviewServiceLayer(newHarness()))),
);

it.effect("will not move a collecting round on while a point in it is unseen or undecided", () =>
  Effect.gen(function* () {
    const reviews = yield* service;
    const { snapshot } = yield* reviews.open(openInput);
    const sessionId = snapshot.session.id;
    yield* reviews.importItems({
      sessionId,
      sourceIds: [],
      items: [
        importItem("gh:T1", { suggestedDecision: "decline" }),
        importItem("gh:T2", { suggestedDecision: null }),
        importItem("gh:T3", { suggestedDecision: "decline" }),
      ],
    });
    yield* reviews.setViewed({ sessionId, number: 1, viewed: true });
    yield* reviews.decide({
      sessionId,
      number: 3,
      decision: "decline",
      authority: { _tag: "panel" },
    });
    // #2 needs a call; #3 is decided but not viewed.
    const refused = yield* Effect.flip(
      reviews.advanceRound({ sessionId, headSha: "abc123", finish: true }),
    );
    assert.include(refused.message, "#2, #3 are not viewed yet");
    assert.equal((yield* reviews.read(sessionId)).session.phase, "self-review");

    yield* reviews.decide({
      sessionId,
      number: 2,
      decision: "decline",
      authority: { _tag: "panel" },
    });
    yield* reviews.setViewed({ sessionId, number: 2, viewed: true });
    yield* reviews.setViewed({ sessionId, number: 3, viewed: true });
    const advanced = yield* reviews.advanceRound({ sessionId, headSha: "abc123", finish: false });
    assert.equal(advanced.session.round, 2);
    // Round 2 has no live points yet, so it can move on straight away.
    const finished = yield* reviews.advanceRound({ sessionId, headSha: "abc123", finish: true });
    assert.equal(finished.session.phase, "done");
  }).pipe(Effect.provide(makeReviewServiceLayer(newHarness()))),
);

it.effect("brings a fixed point raised again in a new round back as pending and unseen", () =>
  Effect.gen(function* () {
    const reviews = yield* service;
    const { snapshot } = yield* reviews.open(openInput);
    const sessionId = snapshot.session.id;
    yield* reviews.importItems({ sessionId, sourceIds: [], items: [importItem("gh:T1")] });
    yield* reviews.setViewed({ sessionId, number: 1, viewed: true });
    yield* reviews.recordApply({ sessionId, number: 1, applyState: "fixed" });
    yield* reviews.advanceRound({ sessionId, headSha: "def456", finish: false });

    const reraised = yield* reviews.importItems({
      sessionId,
      sourceIds: [],
      items: [importItem("gh:T1")],
    });
    const one = reraised.snapshot.items[0];
    assert.deepEqual(
      [one?.lastSeenRound, one?.decision, one?.applyState, one?.viewed],
      [2, "fix", "pending", false],
    );
    const refused = yield* Effect.flip(
      reviews.advanceRound({ sessionId, headSha: "def456", finish: true }),
    );
    assert.include(refused.message, "#1");
  }).pipe(Effect.provide(makeReviewServiceLayer(newHarness()))),
);

it.effect("will not move an applying round on before its drafted GitHub replies are posted", () =>
  Effect.gen(function* () {
    const reviews = yield* service;
    const { snapshot } = yield* reviews.open(openInput);
    const sessionId = snapshot.session.id;
    yield* reviews.importItems({
      sessionId,
      sourceIds: [],
      items: [
        importItem("gh:T1"),
        importItem("gh:T2", {
          suggestedDecision: "decline",
          githubThreadIds: ["T2"],
          draftReply: "Out of scope.",
        }),
      ],
    });
    yield* reviews.setViewed({ sessionId, number: 1, viewed: true });
    yield* reviews.setViewed({ sessionId, number: 2, viewed: true });
    yield* reviews.recordApply({ sessionId, number: 1, applyState: "fixed" });
    const unreplied = yield* Effect.flip(
      reviews.advanceRound({ sessionId, headSha: "def456", finish: false }),
    );
    assert.include(unreplied.message, "#2");

    yield* reviews.recordApply({ sessionId, number: 2, applyState: "replied" });
    const advanced = yield* reviews.advanceRound({ sessionId, headSha: "def456", finish: false });
    assert.equal(advanced.session.round, 2);
  }).pipe(Effect.provide(makeReviewServiceLayer(newHarness()))),
);

it.effect("finds the live review whatever the case of the pull request's repository", () =>
  Effect.gen(function* () {
    const reviews = yield* service;
    const first = yield* reviews.open({
      ...openInput,
      key: { host: "GitHub.com", repository: "NachoGames/Ctrl", number: prKey.number },
    });
    const again = yield* reviews.open(openInput);
    assert.isFalse(again.created);
    assert.equal(again.snapshot.session.id, first.snapshot.session.id);
    assert.deepEqual(first.snapshot.session.pullRequest, prKey);
  }).pipe(Effect.provide(makeReviewServiceLayer(newHarness()))),
);

it.effect("holds a round until every drafted GitHub reply is posted", () =>
  Effect.gen(function* () {
    const reviews = yield* service;
    const { snapshot } = yield* reviews.open(openInput);
    const sessionId = snapshot.session.id;
    yield* reviews.importItems({
      sessionId,
      sourceIds: [],
      items: [
        importItem("gh:T1", { githubThreadIds: ["T1"], draftReply: "Fixed in def456." }),
        // A local finding has no thread to reply on.
        importItem("local:auth.ts:null-session", { sources: ["local-review"] }),
        importItem("gh:T3", { githubThreadIds: ["T3"], draftReply: "   " }),
        importItem("gh:T4", {
          suggestedDecision: "decline",
          githubThreadIds: ["T4"],
          draftReply: "Out of scope.",
        }),
      ],
    });
    for (const number of [1, 2, 3, 4])
      yield* reviews.setViewed({ sessionId, number, viewed: true });
    for (const number of [1, 2, 3]) {
      yield* reviews.recordApply({ sessionId, number, applyState: "fixed" });
    }
    const advance = reviews.advanceRound({ sessionId, headSha: "def456", finish: false });
    assert.include((yield* Effect.flip(advance)).message, "#1, #4: reply not posted yet");
    yield* reviews.recordApply({ sessionId, number: 1, applyState: "replied" });
    assert.include((yield* Effect.flip(advance)).message, "#4: reply not posted yet");
    yield* reviews.recordApply({ sessionId, number: 4, applyState: "replied" });
    assert.equal((yield* advance).session.round, 2);
  }).pipe(Effect.provide(makeReviewServiceLayer(newHarness()))),
);

it.effect("asks for a fresh reply when a replied point is raised again", () =>
  Effect.gen(function* () {
    const reviews = yield* service;
    const { snapshot } = yield* reviews.open(openInput);
    const sessionId = snapshot.session.id;
    const declined = (key: string, draftReply: string) =>
      importItem(key, { suggestedDecision: "decline", githubThreadIds: [key], draftReply });
    yield* reviews.importItems({
      sessionId,
      sourceIds: [],
      items: [declined("gh:T1", "Out of scope."), declined("gh:T2", "Not needed.")],
    });
    for (const number of [1, 2]) yield* reviews.setViewed({ sessionId, number, viewed: true });
    for (const number of [1, 2]) {
      yield* reviews.recordApply({ sessionId, number, applyState: "replied" });
    }
    yield* reviews.advanceRound({ sessionId, headSha: "def456", finish: false });

    const reraised = yield* reviews.importItems({
      sessionId,
      sourceIds: [],
      items: [importItem("gh:T1"), importItem("gh:T2", { draftReply: "Still not needed." })],
    });
    assert.deepEqual(
      reraised.snapshot.items.map((item) => [
        item.number,
        item.applyState,
        item.draftReply,
        item.draftReplyRevision,
        item.draftReplyBy,
      ]),
      [
        [1, "pending", null, 2, null],
        [2, "pending", "Still not needed.", 2, "agent"],
      ],
    );
  }).pipe(Effect.provide(makeReviewServiceLayer(newHarness()))),
);

it.effect("discovers a linked PR and displays author-posted feedback without an agent", () => {
  const harness = newHarness();
  const { groupId: _groupId, ...ungrouped } = chatShell(reviewThreadId);
  harness.shells.set(reviewThreadId, ungrouped);
  harness.read = reviewRoundRead({
    reviews: [githubReview("PRR_owner_agent", "nach")],
    threads: [githubThread("T_auto", [threadComment("PRR_owner_agent", "Corrections are lost")])],
  });
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
       created_at, updated_at, payload_json)
      VALUES (${reviewThreadId}, ${openInput.projectId}, 'Linked PR', 'codex', 'full-access',
       'default', ${at}, ${at}, ${JSON.stringify({ pullRequests: [prLink(prKey.number, "feature", "main")] })})`;
    const reviews = yield* service;
    yield* reviews.discoverLinked();
    yield* reviews.discoverLinked();
    const results = yield* reviews
      .subscribe({ threadId: reviewThreadId, repository: prKey.repository, number: prKey.number })
      .pipe(Stream.take(1), Stream.runCollect);
    const snapshot = results[0]?.snapshot;
    assert.equal(snapshot?.items.length, 1);
    assert.equal(snapshot?.items[0]?.problem, "Corrections are lost");
    assert.equal(snapshot?.items[0]?.decision, "needs-call");
    assert.deepEqual(snapshot?.items[0]?.sourceKeys, ["gh:T_auto"]);
    assert.equal(harness.sent.length, 0);
    assert.equal(harness.launched.length, 0);
    const repo = yield* ReviewSessions.ReviewSessionRepository;
    assert.equal((yield* repo.listLiveSessions()).length, 1);
  }).pipe(Effect.provide(makeReviewServiceLayer(harness)));
});
