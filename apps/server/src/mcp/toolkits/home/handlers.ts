import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as HomeService from "../../../home/HomeService.ts";
import { callerIsHome, readHomeChangeCaller } from "../../homeRouting.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { HomeToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(HomeToolkit, {
  t3_thread_watch: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      if (!(yield* callerIsHome()))
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only Shift can watch threads.",
        });
      const { scope } = yield* readHomeChangeCaller();
      const homeThreadId = scope.thread?.threadId;
      if (homeThreadId === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only Shift can watch threads.",
        });
      const home = yield* HomeService.HomeService;
      const environmentId = input.environmentId ?? scope.environmentId;
      const { threadId } = input;
      if ((input.action === "watch" || input.action === "unwatch") && threadId === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `${input.action} needs threadId.`,
        });
      const next = yield* home
        .updateWatches(homeThreadId, (current) => {
          switch (input.action) {
            case "watch_all":
              return { ...current, watchAll: true };
            case "unwatch_all":
              return { ...current, watchAll: false };
            case "watch":
              return HomeService.addWatch(current, {
                environmentId,
                threadId: threadId!,
                reason: "requested",
              });
            case "unwatch":
              return HomeService.removeWatch(current, { environmentId, threadId: threadId! });
          }
        })
        .pipe(Effect.mapError(unavailable));
      return { watchAll: next.watchAll, watches: next.watches };
    }),
  ),
});
