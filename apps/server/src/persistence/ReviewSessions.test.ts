import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ReviewSessionId,
  ThreadGroupId,
  ThreadId,
  type ReviewItem,
  type ReviewSession,
  type ReviewSource,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { runMigrations } from "./Migrations.ts";
import * as ReviewSessions from "./ReviewSessions.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const at = "2026-10-13T10:00:00.000Z";

const session: ReviewSession = {
  id: ReviewSessionId.make("review:1"),
  projectId: ProjectId.make("project"),
  pullRequest: { host: "github.com", repository: "nachogames/ctrl", number: 23 },
  url: "https://github.com/nachogames/ctrl/pull/23",
  groupId: ThreadGroupId.make("group:review"),
  reviewThreadId: ThreadId.make("thread:review"),
  phase: "self-review",
  round: 1,
  headSha: "abc123",
  nextNumber: 2,
  createdAt: at,
  updatedAt: at,
};

const copilot: ReviewSource = {
  id: "PRR_copilot",
  round: 1,
  kind: "copilot",
  state: "done",
  author: "copilot-pull-request-reviewer",
  isBot: true,
  commitSha: "abc123",
  commentCount: 1,
  triaged: false,
  threadId: null,
  ranOn: null,
  url: null,
  updatedAt: at,
};

const local: ReviewSource = {
  ...copilot,
  id: "local:run-1",
  kind: "local",
  author: null,
  isBot: false,
  threadId: ThreadId.make("thread:local"),
  ranOn: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
};

const comment = (key: string, body: string) => ({
  key,
  threadId: key.startsWith("gh:") ? key.slice(3) : null,
  path: "apps/server/src/auth.ts",
  line: 12,
  body,
  url: null,
  diffHunk: null,
});

const item: ReviewItem = {
  number: 1,
  round: 1,
  lastSeenRound: 1,
  sourceKeys: ["gh:T1"],
  sources: ["copilot"],
  sourceIds: [],
  githubThreadIds: ["T1"],
  githubState: null,
  path: "apps/server/src/auth.ts",
  line: 12,
  summary: "Null session crashes login",
  shortName: "null session",
  problem: "session can be null after expiry.",
  impact: "Login crashes for expired users.",
  solution: "Return 401 when the session is missing.",
  skipReason: "None.",
  excerpt: null,
  recommendation: null,
  suggestedDecision: "fix",
  alreadyFixedIn: null,
  decision: "needs-call",
  decidedBy: null,
  reason: null,
  conclusion: null,
  draftReply: null,
  draftReplyRevision: 0,
  draftReplyBy: null,
  applyState: "pending",
  stale: false,
  viewed: false,
  sideThreadId: null,
  updatedAt: at,
};

const repository = Effect.gen(function* () {
  return yield* ReviewSessions.ReviewSessionRepository;
});

it.effect("links one point to every review that raised it", () =>
  Effect.gen(function* () {
    const repo = yield* repository;
    yield* repo.insertSession(session);
    yield* repo.upsertSource(session.id, copilot, [comment("gh:T1", "Null session crashes.")]);
    yield* repo.upsertSource(session.id, local, [
      comment("local:apps/server/src/auth.ts:null-session", "session may be null"),
    ]);
    yield* repo.upsertItem(session.id, item);
    yield* repo.upsertItem(session.id, {
      ...item,
      sourceKeys: ["gh:T1", "local:apps/server/src/auth.ts:null-session"],
      sources: ["copilot", "local-review"],
    });
    const [stored] = yield* repo.listItems(session.id);
    assert.deepEqual(stored?.sourceKeys, ["gh:T1", "local:apps/server/src/auth.ts:null-session"]);
    assert.deepEqual(stored?.sourceIds, ["PRR_copilot", "local:run-1"]);
    assert.deepEqual(
      Option.getOrNull(
        yield* repo.findItemNumberByKeys(session.id, [
          "local:apps/server/src/auth.ts:null-session",
        ]),
      ),
      1,
    );
    // Sync re-files the review: the triage mark and the round survive.
    yield* repo.markSourcesTriaged(session.id, ["PRR_copilot"]);
    yield* repo.upsertSource(session.id, { ...copilot, round: 2, commentCount: 2 }, null);
    const sources = yield* repo.listSources(session.id);
    const filed = sources.find((source) => source.id === "PRR_copilot");
    assert.deepEqual([filed?.round, filed?.triaged, filed?.commentCount], [1, true, 2]);
    assert.equal((yield* repo.listSourceComments(session.id, "PRR_copilot")).length, 1);
    // Sync owns the GitHub state; a later item write leaves it alone.
    yield* repo.setItemGithubState(session.id, 1, "resolved");
    yield* repo.upsertItem(session.id, { ...item, viewed: true });
    assert.equal((yield* repo.listItems(session.id))[0]?.githubState, "resolved");
    assert.deepEqual(
      Option.getOrNull(yield* repo.findLocalSourceByThread(ThreadId.make("thread:local"))),
      { sessionId: session.id, sourceId: "local:run-1" },
    );
  }).pipe(
    Effect.provide(ReviewSessions.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  ),
);

it.effect("keeps a point key with the first point that raised it", () =>
  Effect.gen(function* () {
    const repo = yield* repository;
    yield* repo.insertSession(session);
    yield* repo.upsertItem(session.id, item);
    yield* repo.upsertItem(session.id, { ...item, number: 2, sourceKeys: ["gh:T1", "gh:T2"] });
    assert.deepEqual(Option.getOrNull(yield* repo.findItemNumberByKeys(session.id, ["gh:T1"])), 1);
    assert.deepEqual(
      (yield* repo.listItems(session.id)).map((stored) => stored.sourceKeys),
      [["gh:T1"], ["gh:T2"]],
    );
  }).pipe(
    Effect.provide(ReviewSessions.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  ),
);

it.effect("keeps the review across a restart", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "ctrl-review-sessions-",
    });
    // Each provide builds and closes its own connection, like a server start and stop.
    const database = ReviewSessions.layer.pipe(
      Layer.provideMerge(Layer.effectDiscard(runMigrations())),
      Layer.provideMerge(
        NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") }),
      ),
    );
    yield* Effect.gen(function* () {
      const repo = yield* repository;
      yield* repo.insertSession(session);
      yield* repo.upsertRound(session.id, {
        round: 1,
        headSha: "abc123",
        state: "collecting",
        appliedSha: null,
        createdAt: at,
        updatedAt: at,
      });
      yield* repo.upsertItem(session.id, {
        ...item,
        decision: "decline",
        decidedBy: "chat",
        reason: "Out of scope",
        viewed: true,
        draftReply: "Out of scope for this fix.",
        draftReplyRevision: 2,
        draftReplyBy: "panel",
      });
    }).pipe(Effect.provide(database));
    const restored = yield* repository.pipe(
      Effect.flatMap((repo) =>
        Effect.all([repo.listItems(session.id), repo.listRounds(session.id)]),
      ),
      Effect.provide(database),
    );
    const [items, rounds] = restored;
    assert.deepEqual(
      items.map((stored) => [stored.number, stored.decision, stored.viewed, stored.draftReplyBy]),
      [[1, "decline", true, "panel"]],
    );
    assert.deepEqual(
      rounds.map((round) => [round.round, round.state]),
      [[1, "collecting"]],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
