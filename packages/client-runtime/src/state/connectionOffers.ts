import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/** Leaving a machine a link back, and taking the links machines left here. */
export function createConnectionOfferCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    offer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:connection-offers:offer",
      tag: WS_METHODS.connectionOffersOffer,
    }),
    take: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:connection-offers:take",
      tag: WS_METHODS.connectionOffersTake,
    }),
  };
}
