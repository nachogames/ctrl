import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A machine that just paired with this one, offering the connection back: a pairing link to
 * itself. This machine's app redeems it, so one pairing connects both ways.
 */
export const ConnectionOffer = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  /** A pairing link to the offering machine, carrying its address and a one-time code. */
  pairingUrl: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type ConnectionOffer = typeof ConnectionOffer.Type;

export const ConnectionOfferList = Schema.Struct({
  offers: Schema.Array(ConnectionOffer),
});
export type ConnectionOfferList = typeof ConnectionOfferList.Type;
