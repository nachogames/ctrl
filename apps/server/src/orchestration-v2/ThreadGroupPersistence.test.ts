import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ThreadGroupId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import { toShellApplicationEvent } from "./ShellStream.ts";
import * as ThreadGroupStore from "./ThreadGroupStore.ts";
import { threadGroupCreatedEvent } from "./testkit/threadGroupFixtures.ts";

const layerTest = Layer.mergeAll(
  RuntimeLayer.layerEventSink,
  RuntimeLayer.layerEventInfrastructure,
  ThreadGroupStore.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const acceptedAt = DateTime.makeUnsafe("2026-10-10T00:00:00.000Z");

it.layer(layerTest)("thread group persistence", (it) => {
  it.effect("commits a group command once and replays its receipt", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;
      const groupId = ThreadGroupId.make("group:persistence:once");
      const commandId = CommandId.make("command:persistence:once");
      const event = {
        ...threadGroupCreatedEvent({ groupId, projectId: ProjectId.make("project:persistence") }),
        commandId,
        correlationId: commandId,
      };
      const commit = sink.commitThreadGroupCommand({
        commandId,
        groupId,
        commandType: "thread-group.create",
        acceptedAt,
        event,
      });

      const first = yield* commit;
      const second = yield* commit;
      assert.isTrue(first.committed);
      assert.equal(first.receipt.status, "accepted");
      assert.isFalse(second.committed);
      assert.equal(second.receipt.resultSequence, first.receipt.resultSequence);
      assert.equal(Option.getOrThrow(yield* groups.get(groupId)).title, "Auth refactor");
    }),
  );

  it.effect("replays thread group events through the application log", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const groupId = ThreadGroupId.make("group:persistence:replay");
      const commandId = CommandId.make("command:persistence:replay");
      const baseline = yield* store.latestApplicationSequence;
      yield* sink.commitThreadGroupCommand({
        commandId,
        groupId,
        commandType: "thread-group.create",
        acceptedAt,
        event: threadGroupCreatedEvent({
          groupId,
          projectId: ProjectId.make("project:persistence"),
        }),
      });
      const highWater = yield* store.latestApplicationSequence;

      const replayed = yield* store
        .readApplicationEvents({ afterSequence: baseline, throughSequence: highWater })
        .pipe(Stream.runCollect);
      const shellEvents = Array.from(replayed, toShellApplicationEvent);
      assert.deepEqual(shellEvents, [
        {
          aggregateKind: "thread-group",
          aggregateId: groupId,
          type: "thread-group.created",
          sequence: highWater,
        },
      ]);
    }),
  );

  it.effect("records a rejection once", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const groupId = ThreadGroupId.make("group:persistence:rejected");
      const reject = (error: string) =>
        sink.commitRejectedThreadGroupCommand({
          commandId: CommandId.make("command:persistence:rejected"),
          groupId,
          commandType: "thread-group.delete",
          rejectedAt: acceptedAt,
          error,
        });
      const first = yield* reject("first");
      const second = yield* reject("second");
      assert.equal(first.status, "rejected");
      assert.equal(second.error, "first");
    }),
  );
});
