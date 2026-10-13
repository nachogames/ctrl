import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ReviewSessionService from "./ReviewSessionService.ts";
import {
  chatShell,
  githubReview,
  githubThread,
  groupId,
  importItem,
  makeReviewServiceLayer,
  newHarness,
  openInput,
  reviewRoundRead,
  reviewThreadId,
  threadComment,
} from "./testkit.ts";

const service = ReviewSessionService.ReviewSessionService;

it.effect("starts one side chat per point, in the group, from the review chat", () => {
  const harness = newHarness();
  return Effect.gen(function* () {
    const reviews = yield* service;
    const { snapshot } = yield* reviews.open(openInput);
    const sessionId = snapshot.session.id;
    yield* reviews.importItems({
      sessionId,
      sourceIds: [],
      items: [importItem("gh:T1", { shortName: "null session" })],
    });
    const first = yield* reviews.openSideChat({ sessionId, number: 1 });
    const again = yield* reviews.openSideChat({ sessionId, number: 1 });
    assert.equal(again.threadId, first.threadId);
    assert.equal(harness.launched.length, 1);
    const [launch] = harness.launched;
    assert.equal(launch?.groupId, groupId);
    assert.equal(launch?.createdBy, "agent");
    assert.equal(launch?.creationSource, "server");
    assert.equal(launch?.senderThreadId, reviewThreadId);
    assert.equal(launch?.title, "#1 · null session");
    assert.include(launch?.prompt ?? "", "point #1");
    assert.equal((yield* reviews.read(sessionId)).items[0]?.sideThreadId, first.threadId);
  }).pipe(Effect.provide(makeReviewServiceLayer(harness)));
});

it.effect("starts a fresh side chat when the old one was deleted", () => {
  const harness = newHarness();
  return Effect.gen(function* () {
    const reviews = yield* service;
    const { snapshot } = yield* reviews.open(openInput);
    const sessionId = snapshot.session.id;
    yield* reviews.importItems({ sessionId, sourceIds: [], items: [importItem("gh:T1")] });
    const first = yield* reviews.openSideChat({ sessionId, number: 1 });
    harness.shells.set(
      first.threadId,
      chatShell(first.threadId, { deletedAt: DateTime.makeUnsafe(2) as DateTime.Utc }),
    );
    const replacement = yield* reviews.openSideChat({ sessionId, number: 1 });
    assert.notEqual(replacement.threadId, first.threadId);
    assert.equal(harness.launched.length, 2);
  }).pipe(Effect.provide(makeReviewServiceLayer(harness)));
});

it.effect(
  "runs your review in its own chat on the review chat's model and files its findings",
  () => {
    const harness = newHarness();
    return Effect.gen(function* () {
      const reviews = yield* service;
      const { snapshot } = yield* reviews.open(openInput);
      const sessionId = snapshot.session.id;
      const run = yield* reviews.runLocalReview({ sessionId });
      // A second click while it runs opens the same chat.
      assert.equal((yield* reviews.runLocalReview({ sessionId })).threadId, run.threadId);
      assert.equal(harness.launched.length, 1);
      assert.include(harness.launched[0]?.prompt ?? "", "/code-review");
      const [running] = (yield* reviews.read(sessionId)).sources;
      assert.deepEqual(
        [running?.kind, running?.state, running?.threadId, running?.ranOn?.model],
        ["local", "reviewing", run.threadId, "claude-opus-5-5"],
      );
      const access = yield* reviews.resolveForThread({ threadId: run.threadId, groupId });
      assert.deepEqual([access.role, access.localSourceId], ["local", running?.id ?? null]);

      const done = yield* reviews.submitLocalFindings({
        sessionId,
        sourceId: running!.id,
        headSha: "abc123",
        findings: [
          {
            path: "apps/server/src/auth.ts",
            line: 12,
            title: "Null session",
            body: "Return 401.",
            slug: "null-session",
          },
          {
            path: null,
            line: null,
            title: "Stale comment",
            body: "Say app.config.ts.",
            slug: "stale-comment",
          },
        ],
      });
      assert.deepEqual([done.state, done.commentCount, done.commitSha], ["done", 2, "abc123"]);
      const comments = yield* reviews.readSourceComments({ sessionId, sourceId: done.id });
      assert.deepEqual(
        comments.map((comment) => comment.key),
        ["local:apps/server/src/auth.ts:null-session", "local::stale-comment"],
      );
    }).pipe(Effect.provide(makeReviewServiceLayer(harness)));
  },
);

it.effect("asks other providers for a plain review", () => {
  const harness = newHarness();
  harness.drivers.set("claudeAgent", "codex");
  return Effect.gen(function* () {
    const reviews = yield* service;
    const { snapshot } = yield* reviews.open(openInput);
    yield* reviews.runLocalReview({ sessionId: snapshot.session.id });
    const prompt = harness.launched[0]?.prompt ?? "";
    assert.notInclude(prompt, "/code-review");
    assert.include(prompt, "Review this branch");
  }).pipe(Effect.provide(makeReviewServiceLayer(harness)));
});

it.effect("sends Triage, Apply and rewrites to the review chat as the system", () => {
  const harness = newHarness();
  harness.read = reviewRoundRead({
    reviews: [githubReview("PRR_1", "copilot-pull-request-reviewer", { isBot: true })],
    threads: [githubThread("T1", [threadComment("PRR_1", "The cache key ignores the patch.")])],
  });
  return Effect.gen(function* () {
    const reviews = yield* service;
    const { snapshot } = yield* reviews.open(openInput);
    const sessionId = snapshot.session.id;
    yield* reviews.requestTurn({ sessionId, request: { _tag: "triage" } });
    const [triage] = harness.sent;
    assert.deepEqual(
      [triage?.threadId, triage?.createdBy, triage?.creationSource, triage?.mode],
      [reviewThreadId, "system", "server", "queue"],
    );
    assert.include(triage?.text ?? "", "Triage round 1");

    yield* reviews.importItems({
      sessionId,
      sourceIds: ["PRR_1"],
      items: [importItem("gh:T1", { shortName: "build cache key" })],
    });
    const nothingNew = yield* Effect.flip(
      reviews.requestTurn({ sessionId, request: { _tag: "triage" } }),
    );
    assert.include(nothingNew.message, "No finished review");
    const unseen = yield* Effect.flip(
      reviews.requestTurn({ sessionId, request: { _tag: "apply" } }),
    );
    assert.include(unseen.message, "View #1");

    yield* reviews.requestTurn({
      sessionId,
      request: { _tag: "rewrite-reply", number: 1, style: "shorter" },
    });
    assert.match(harness.sent[1]?.text ?? "", /^\[#1 build cache key\]\n/);

    yield* reviews.setViewed({ sessionId, number: 1, viewed: true });
    yield* reviews.requestTurn({ sessionId, request: { _tag: "apply" } });
    assert.include(harness.sent[2]?.text ?? "", "Apply round 1");
    assert.equal((yield* reviews.read(sessionId)).rounds[0]?.state, "applying");
  }).pipe(Effect.provide(makeReviewServiceLayer(harness)));
});

it.effect("moves the round back to collecting when Apply cannot reach the review chat", () => {
  const harness = newHarness();
  return Effect.gen(function* () {
    const reviews = yield* service;
    const { snapshot } = yield* reviews.open(openInput);
    const sessionId = snapshot.session.id;
    yield* reviews.importItems({ sessionId, sourceIds: [], items: [importItem("gh:T1")] });
    yield* reviews.setViewed({ sessionId, number: 1, viewed: true });
    harness.sendFails = true;
    const failed = yield* Effect.flip(
      reviews.requestTurn({ sessionId, request: { _tag: "apply" } }),
    );
    assert.include(failed.message, "could not be reached");
    assert.equal((yield* reviews.read(sessionId)).rounds[0]?.state, "collecting");
    // Nothing is stuck: the next Apply goes through.
    harness.sendFails = false;
    yield* reviews.requestTurn({ sessionId, request: { _tag: "apply" } });
    assert.equal((yield* reviews.read(sessionId)).rounds[0]?.state, "applying");
  }).pipe(Effect.provide(makeReviewServiceLayer(harness)));
});

it.effect("replaces a local review whose chat was deleted instead of showing it running", () => {
  const harness = newHarness();
  return Effect.gen(function* () {
    const reviews = yield* service;
    const { snapshot } = yield* reviews.open(openInput);
    const sessionId = snapshot.session.id;
    const first = yield* reviews.runLocalReview({ sessionId });
    harness.shells.set(
      first.threadId,
      chatShell(first.threadId, { deletedAt: DateTime.makeUnsafe(2) as DateTime.Utc }),
    );
    const second = yield* reviews.runLocalReview({ sessionId });
    assert.notEqual(second.threadId, first.threadId);
    assert.deepEqual(
      (yield* reviews.read(sessionId)).sources.map((source) => [source.threadId, source.state]),
      [[second.threadId, "reviewing"]],
    );
  }).pipe(Effect.provide(makeReviewServiceLayer(harness)));
});

it.effect("takes a local review's findings only once", () => {
  const harness = newHarness();
  return Effect.gen(function* () {
    const reviews = yield* service;
    const { snapshot } = yield* reviews.open(openInput);
    const sessionId = snapshot.session.id;
    yield* reviews.runLocalReview({ sessionId });
    const [running] = (yield* reviews.read(sessionId)).sources;
    const submit = reviews.submitLocalFindings({
      sessionId,
      sourceId: running!.id,
      headSha: "abc123",
      findings: [],
    });
    assert.deepEqual(
      [(yield* submit).state, (yield* submit.pipe(Effect.flip)).message],
      [
        "done",
        "These findings are already in. Start a new run from the Review tab for another look.",
      ],
    );
    const unknown = yield* Effect.flip(
      reviews.submitLocalFindings({
        sessionId,
        sourceId: "local:nope",
        headSha: "abc123",
        findings: [],
      }),
    );
    assert.include(unknown.message, "not running a review");
  }).pipe(Effect.provide(makeReviewServiceLayer(harness)));
});
