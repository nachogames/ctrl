import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ConnectionOffers from "./ConnectionOffers.ts";

const offerFrom = (id: string, url: string, expiresInMinutes: number) =>
  Effect.map(DateTime.now, (now) => ({
    environmentId: EnvironmentId.make(id),
    label: `Machine ${id}`,
    pairingUrl: url,
    expiresAt: DateTime.add(now, { minutes: expiresInMinutes }),
  }));

it.effect("hands each machine's latest live offer out once", () =>
  Effect.gen(function* () {
    const offers = yield* ConnectionOffers.ConnectionOffers;
    yield* offers.offer(yield* offerFrom("laptop", "https://laptop/pair#token=OLD", 60));
    yield* offers.offer(yield* offerFrom("laptop", "https://laptop/pair#token=NEW", 60));
    yield* offers.offer(yield* offerFrom("vps", "https://vps/pair#token=SOON", 1));
    yield* TestClock.adjust(Duration.minutes(2));

    // The newer offer from the same machine replaces the older; the lapsed code is dropped.
    expect((yield* offers.take).map((offer) => offer.pairingUrl)).toEqual([
      "https://laptop/pair#token=NEW",
    ]);
    expect(yield* offers.take).toEqual([]);
  }).pipe(Effect.provide(Layer.merge(ConnectionOffers.layer, TestClock.layer()))),
);
