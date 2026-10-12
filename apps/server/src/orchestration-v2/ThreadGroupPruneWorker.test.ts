import { assert, it } from "@effect/vitest";
import { type OrchestrationV2StoredEvent, ThreadGroupId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as EventSink from "./EventSink.ts";
import * as ThreadGroupPruneWorker from "./ThreadGroupPruneWorker.ts";
import * as ThreadGroupService from "./ThreadGroupService.ts";

const threadEvent = (
  type: "thread.deleted" | "thread.archived" | "thread.unarchived",
  sequence: number,
  threadId: string,
  groupId: string | null,
) =>
  ({
    sequence,
    commandId: null,
    event: { type, threadId, payload: { id: threadId, groupId } },
  }) as unknown as OrchestrationV2StoredEvent;
const threadDeleted = (sequence: number, threadId: string, groupId: string | null) =>
  threadEvent("thread.deleted", sequence, threadId, groupId);

it.effect("prunes the group of a deleted thread after the startup sweep", () =>
  Effect.gen(function* () {
    const groupId = ThreadGroupId.make("group:prune-worker");
    const calls: Array<string> = [];
    const streamedAfter: Array<number | undefined> = [];
    const pruned = yield* Deferred.make<void>();
    const layer = ThreadGroupPruneWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadGroupService.ThreadGroupService)({
            pruneEmptyGroups: Effect.sync(() => {
              calls.push("sweep");
            }),
            pruneIfEmpty: (id) =>
              Effect.sync(() => {
                calls.push(id);
              }).pipe(Effect.andThen(Deferred.succeed(pruned, undefined)), Effect.asVoid),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            latestSequence: () => Effect.succeed(7),
            stream: (input) => {
              streamedAfter.push(input?.afterSequence);
              return input?.eventType === "thread.deleted"
                ? Stream.make(
                    threadDeleted(8, "thread-a", null),
                    threadDeleted(9, "thread-b", groupId),
                  )
                : Stream.empty;
            },
          }),
        ),
      ),
    );

    yield* Deferred.await(pruned).pipe(Effect.provide(layer));
    assert.deepEqual(calls, ["sweep", groupId]);
    assert.deepEqual(streamedAfter, [7, 7, 7]);
  }),
);

it.effect("re-checks the group of an archived or unarchived thread", () =>
  Effect.gen(function* () {
    const archivedGroup = ThreadGroupId.make("group:archived");
    const unarchivedGroup = ThreadGroupId.make("group:unarchived");
    const calls: Array<string> = [];
    const both = yield* Deferred.make<void>();
    const layer = ThreadGroupPruneWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadGroupService.ThreadGroupService)({
            pruneEmptyGroups: Effect.void,
            pruneIfEmpty: (id) =>
              Effect.suspend(() => {
                calls.push(id);
                return calls.length === 2 ? Deferred.succeed(both, undefined) : Effect.void;
              }).pipe(Effect.asVoid),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            latestSequence: () => Effect.succeed(0),
            stream: (input) => {
              switch (input?.eventType) {
                case "thread.archived":
                  return Stream.make(threadEvent("thread.archived", 1, "thread-a", archivedGroup));
                case "thread.unarchived":
                  return Stream.make(
                    threadEvent("thread.unarchived", 2, "thread-b", unarchivedGroup),
                  );
                default:
                  return Stream.empty;
              }
            },
          }),
        ),
      ),
    );

    yield* Deferred.await(both).pipe(Effect.provide(layer));
    assert.sameMembers(calls, [archivedGroup, unarchivedGroup]);
  }),
);
