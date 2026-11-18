import type { ConnectionOffer, EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

// A machine pairs with a handful of others at most; this only bounds a misbehaving caller.
const MAX_OFFERS = 32;

/**
 * Pairing links other machines left so this machine connects back to them. Held in memory: an
 * offer that a restart drops costs one more pairing, and its code expires on its own anyway.
 */
export class ConnectionOffers extends Context.Service<
  ConnectionOffers,
  {
    /** Replaces any earlier offer from the same machine. */
    readonly offer: (offer: ConnectionOffer) => Effect.Effect<void>;
    /** The live offers, each handed out once. */
    readonly take: Effect.Effect<ReadonlyArray<ConnectionOffer>>;
  }
>()("t3/connectionOffers/ConnectionOffers") {}

const make = Effect.gen(function* () {
  const offers = yield* Ref.make(new Map<EnvironmentId, ConnectionOffer>());

  const live = (current: ReadonlyMap<EnvironmentId, ConnectionOffer>, now: DateTime.Utc) =>
    [...current.values()].filter((offer) => DateTime.isGreaterThan(offer.expiresAt, now));

  const offer: ConnectionOffers["Service"]["offer"] = Effect.fn("ConnectionOffers.offer")(
    function* (next) {
      const now = yield* DateTime.now;
      yield* Ref.update(offers, (current) => {
        const kept = live(current, now).filter(
          (existing) => existing.environmentId !== next.environmentId,
        );
        return new Map(
          [...kept, next].slice(-MAX_OFFERS).map((entry) => [entry.environmentId, entry] as const),
        );
      });
    },
  );

  const take: ConnectionOffers["Service"]["take"] = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const current = yield* Ref.getAndSet(offers, new Map());
    return live(current, now);
  }).pipe(Effect.withSpan("ConnectionOffers.take"));

  return ConnectionOffers.of({ offer, take });
});

export const layer = Layer.effect(ConnectionOffers, make);
