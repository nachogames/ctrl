import type { ReviewSessionId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/**
 * "This review changed", from every writer (the review service and the GitHub sync), so a
 * subscriber re-reads only the review it shows.
 */
export class ReviewSessionChanges extends Context.Service<
  ReviewSessionChanges,
  {
    readonly publish: (sessionId: ReviewSessionId) => Effect.Effect<void>;
    readonly subscribe: Effect.Effect<Stream.Stream<ReviewSessionId>, never, Scope.Scope>;
  }
>()("t3/reviewSessions/ReviewSessionChanges") {}

export const layer = Layer.effect(
  ReviewSessionChanges,
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<ReviewSessionId>();
    return ReviewSessionChanges.of({
      publish: (sessionId) => PubSub.publish(changes, sessionId).pipe(Effect.asVoid),
      subscribe: PubSub.subscribe(changes).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    });
  }),
);
