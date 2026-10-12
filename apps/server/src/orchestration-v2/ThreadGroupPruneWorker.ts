import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadGroupService from "./ThreadGroupService.ts";

// Deleting a thread can empty its group; archiving or unarchiving one changes
// whether the group is down to a single live chat.
const membershipEvents = ["thread.deleted", "thread.archived", "thread.unarchived"] as const;

/**
 * Re-checks a thread's group when the thread is deleted, archived or
 * unarchived: an empty group is deleted, a group of one loses its pin, snooze
 * and settle. The streams start at the sequence read before the sweep, so an
 * event that lands during the sweep, or while the server was down, still prunes.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* ThreadGroupService.ThreadGroupService;
    const eventSink = yield* EventSink.EventSinkV2;
    const afterSequence = yield* eventSink.latestSequence();
    yield* forkParked(
      service.pruneEmptyGroups.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.thread-group.prune-sweep-failed", { cause }),
        ),
        Effect.andThen(
          Stream.mergeAll(
            membershipEvents.map((eventType) => eventSink.stream({ afterSequence, eventType })),
            { concurrency: "unbounded" },
          ).pipe(
            Stream.runForEach((stored) => {
              const { event } = stored;
              const groupId =
                event.type === "thread.deleted" ||
                event.type === "thread.archived" ||
                event.type === "thread.unarchived"
                  ? event.payload.groupId
                  : null;
              return groupId == null
                ? Effect.void
                : service.pruneIfEmpty(groupId).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("orchestration-v2.thread-group.prune-failed", {
                        groupId,
                        cause,
                      }),
                    ),
                  );
            }),
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.thread-group.prune-stream-ended", { cause }),
        ),
      ),
    );
  }),
);
