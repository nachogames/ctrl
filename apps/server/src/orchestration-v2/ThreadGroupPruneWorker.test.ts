import { assert, it } from "@effect/vitest";
import { type OrchestrationV2StoredEvent, ThreadGroupId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as EventSink from "./EventSink.ts";
import * as ThreadGroupPruneWorker from "./ThreadGroupPruneWorker.ts";
import * as ThreadGroupService from "./ThreadGroupService.ts";

const threadDeleted = (sequence: number, threadId: string, groupId: string | null) =>
  ({
    sequence,
    commandId: null,
    event: { type: "thread.deleted", threadId, payload: { id: threadId, groupId } },
  }) as unknown as OrchestrationV2StoredEvent;

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
              return Stream.make(
                threadDeleted(8, "thread-a", null),
                threadDeleted(9, "thread-b", groupId),
              );
            },
          }),
        ),
      ),
    );

    yield* Deferred.await(pruned).pipe(Effect.provide(layer));
    assert.deepEqual(calls, ["sweep", groupId]);
    assert.deepEqual(streamedAfter, [7]);
  }),
);
