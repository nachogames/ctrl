import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import * as GeminiLive from "../voiceFront/GeminiLive.ts";
import * as VoiceFront from "../voiceFront/VoiceFront.ts";
import * as VoiceFrontContext from "../voiceFront/VoiceFrontContext.ts";
import * as FleetService from "./FleetService.ts";
import * as HomeForwardedLaunches from "./HomeForwardedLaunches.ts";
import * as HomeService from "./HomeService.ts";

/** Home's services and Shift's front voice, shared by the WebSocket and MCP transports. */
export const HomeLayer = Layer.mergeAll(
  FleetService.layer,
  // Watches the threads Shift launches on linked machines.
  HomeForwardedLaunches.layer,
  VoiceFront.layer.pipe(
    Layer.provide(GeminiLive.layer),
    // Shift's front voice lists linked machines' threads as Shift.
    Layer.provide(VoiceFrontContext.layer),
    Layer.provide(ProcessRunner.layer),
  ),
).pipe(Layer.provideMerge(HomeService.layer));
