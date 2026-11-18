import { createConnectionOfferCommands } from "@t3tools/client-runtime/state/connectionOffers";

import { connectionAtomRuntime } from "../connection/runtime";

export const connectionOffers = createConnectionOfferCommands(connectionAtomRuntime);
