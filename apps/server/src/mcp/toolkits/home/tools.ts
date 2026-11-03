import { EnvironmentId, HomeWatch, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as FleetService from "../../../home/FleetService.ts";
import * as HomeService from "../../../home/HomeService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HomeService.HomeService,
    FleetService.FleetService,
  ],
};

const ThreadWatchTool = Tool.make("t3_thread_watch", {
  ...shared,
  description:
    "Shift only. Choose which threads wake Shift. watch/unwatch one thread (threadId, optional environmentId), or watch_all/unwatch_all for every thread in every environment the desktop app is connected to. Threads Shift launches are already watched. A watch ends when its thread is settled or archived. Returns what Shift now watches.",
  parameters: Schema.Struct({
    action: Schema.Literals(["watch", "unwatch", "watch_all", "unwatch_all"]),
    // Not a linked-environment target: the watch is kept here, whichever machine the thread is on.
    environmentId: Schema.optional(
      EnvironmentId.annotate({ description: "The thread's environment. Omit for this one." }),
    ),
    threadId: Schema.optional(ThreadId),
  }),
  success: Schema.Struct({ watchAll: Schema.Boolean, watches: Schema.Array(HomeWatch) }),
}).annotate(Tool.Destructive, false);

export const HomeToolkit = Toolkit.make(ThreadWatchTool);
