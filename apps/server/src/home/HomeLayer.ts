import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GeminiLive from "../voiceFront/GeminiLive.ts";
import * as VoiceFront from "../voiceFront/VoiceFront.ts";
import * as VoiceFrontContext from "../voiceFront/VoiceFrontContext.ts";
import * as FleetBroker from "./FleetBroker.ts";
import * as FleetService from "./FleetService.ts";
import * as HomeService from "./HomeService.ts";

/** Home and fleet services, and Shift's front voice, shared by the WebSocket and MCP transports. */
export const HomeLayer = Layer.mergeAll(
  HomeService.layer,
  FleetService.layer.pipe(Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry)),
  VoiceFront.layer.pipe(
    Layer.provide(GeminiLive.layer),
    // Shift's front voice lists other machines' threads through the same broker.
    Layer.provide(VoiceFrontContext.layer),
    Layer.provide(ProcessRunner.layer),
  ),
).pipe(Layer.provideMerge(FleetBroker.layer));
