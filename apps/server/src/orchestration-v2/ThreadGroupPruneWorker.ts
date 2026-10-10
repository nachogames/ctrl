import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadGroupService from "./ThreadGroupService.ts";

/**
 * Deletes a group once its last live thread is deleted. The stream starts at the
 * sequence read before the sweep, so a delete that lands during the sweep, or
 * while the server was down, still prunes.
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
          eventSink.stream({ afterSequence, eventType: "thread.deleted" }).pipe(
            Stream.runForEach((stored) => {
              const groupId =
                stored.event.type === "thread.deleted" ? stored.event.payload.groupId : null;
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
