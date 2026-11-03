import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type * as McpInvocationContext from "./McpInvocationContext.ts";

/**
 * Ctrl: told about each tool call forwarded to a linked environment, once it
 * succeeds there. Optional: `McpToolAccess` forwards the same way without it.
 * Shift uses it to watch the threads it launches on another machine, whose
 * ids only that machine knows.
 */
export class ForwardedCalls extends Context.Service<
  ForwardedCalls,
  {
    readonly succeeded: (call: {
      readonly scope: McpInvocationContext.McpInvocationScope;
      readonly toolName: string;
      readonly environmentId: EnvironmentId;
      readonly result: unknown;
    }) => Effect.Effect<void>;
  }
>()("t3/mcp/ForwardedCalls") {}
