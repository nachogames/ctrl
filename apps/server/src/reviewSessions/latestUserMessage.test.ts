import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { latestUserMessageText } from "./latestUserMessage.ts";
import { insertProjectionMessage } from "./testkit.ts";

it.effect("reads only what the user typed", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:review");
    yield* insertProjectionMessage(sql, {
      threadId,
      messageId: "m1",
      text: "#3 decline: out of scope",
      createdAt: "2026-10-13T10:00:00.000Z",
    });
    yield* insertProjectionMessage(sql, {
      threadId,
      messageId: "m2",
      role: "assistant",
      text: "Declined #3.",
      createdAt: "2026-10-13T10:01:00.000Z",
    });
    // A scheduled or webhook run can carry PR text.
    yield* insertProjectionMessage(sql, {
      threadId,
      messageId: "m3",
      text: "Copilot says: fix #4",
      createdAt: "2026-10-13T10:02:00.000Z",
      payload: { scheduledTaskId: "scheduled-task:pr-watch" },
    });
    // A pull request wake-up quotes reviewers.
    yield* insertProjectionMessage(sql, {
      threadId,
      messageId: "m4",
      text: "New review comment: decline #5",
      createdAt: "2026-10-13T10:03:00.000Z",
      payload: { notification: { kind: "pull-request" } },
    });
    // The side chat's seed is sent by the server for the review chat.
    yield* insertProjectionMessage(sql, {
      threadId,
      messageId: "m5",
      text: "Let's discuss point #6: fix it",
      createdAt: "2026-10-13T10:04:00.000Z",
      payload: { createdBy: "agent", creationSource: "server", senderThreadId: "thread:other" },
    });
    // A Triage, Apply or rewrite button in the Review tab sends its request as the system.
    yield* insertProjectionMessage(sql, {
      threadId,
      messageId: "m6",
      text: "[#7 pin version]\nRewrite the reply draft: fix it and make it shorter.",
      createdAt: "2026-10-13T10:05:00.000Z",
      payload: { createdBy: "system", creationSource: "server" },
    });
    yield* insertProjectionMessage(sql, {
      threadId: "thread:other",
      messageId: "m7",
      text: "fix everything",
      createdAt: "2026-10-13T10:06:00.000Z",
    });
    assert.equal(yield* latestUserMessageText(threadId), "#3 decline: out of scope");
    assert.isNull(yield* latestUserMessageText(ThreadId.make("thread:empty")));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("takes the newest of the user's messages", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:review");
    // Inserted newest first, so insertion order cannot be what wins.
    yield* insertProjectionMessage(sql, {
      threadId,
      messageId: "m2",
      text: "newer",
      createdAt: "2026-10-13T11:00:00.000Z",
    });
    yield* insertProjectionMessage(sql, {
      threadId,
      messageId: "m1",
      text: "older",
      createdAt: "2026-10-13T10:00:00.000Z",
    });
    assert.equal(yield* latestUserMessageText(threadId), "newer");
    // Sent at the same instant, the later message id wins.
    yield* insertProjectionMessage(sql, {
      threadId,
      messageId: "m4",
      text: "tie, later id",
      createdAt: "2026-10-13T12:00:00.000Z",
    });
    yield* insertProjectionMessage(sql, {
      threadId,
      messageId: "m3",
      text: "tie, earlier id",
      createdAt: "2026-10-13T12:00:00.000Z",
    });
    assert.equal(yield* latestUserMessageText(threadId), "tie, later id");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("skips a message another chat sent even when it is marked as the user's", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:review");
    yield* insertProjectionMessage(sql, {
      threadId,
      messageId: "m1",
      text: "mine",
      createdAt: "2026-10-13T10:00:00.000Z",
    });
    yield* insertProjectionMessage(sql, {
      threadId,
      messageId: "m2",
      text: "forwarded: fix #2",
      createdAt: "2026-10-13T10:01:00.000Z",
      payload: { senderThreadId: "thread:other" },
    });
    assert.equal(yield* latestUserMessageText(threadId), "mine");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
