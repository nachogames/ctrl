/**
 * Watches the threads Shift launches on a linked machine. Only that machine
 * knows the id, so the watch is saved when the forwarded launch returns.
 * See docs/internals/home.md.
 */
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ForwardedCalls from "../mcp/ForwardedCalls.ts";
import * as HomeService from "./HomeService.ts";

const decodeLaunch = Schema.decodeUnknownOption(Schema.Struct({ threadId: ThreadId }));

export const layer = Layer.effect(
  ForwardedCalls.ForwardedCalls,
  Effect.gen(function* () {
    const home = yield* HomeService.HomeService;
    return ForwardedCalls.ForwardedCalls.of({
      succeeded: Effect.fn("HomeForwardedLaunches.succeeded")(function* (call) {
        const homeThreadId = call.scope.thread?.threadId;
        if (call.toolName !== "t3_thread_launch" || homeThreadId === undefined) return;
        if (!call.scope.capabilities.has("orchestration")) return;
        if (!(yield* home.isHome(homeThreadId))) return;
        const launched = decodeLaunch(call.result);
        if (Option.isNone(launched)) return;
        // The thread already runs there, so a failed watch is logged, not reported as a failed launch.
        yield* home
          .updateWatches(homeThreadId, (current) =>
            HomeService.addWatch(current, {
              environmentId: call.environmentId,
              threadId: launched.value.threadId,
              reason: "launched",
            }),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Shift could not watch a thread it launched on another machine.", {
                cause,
              }),
            ),
          );
      }),
    });
  }),
);
