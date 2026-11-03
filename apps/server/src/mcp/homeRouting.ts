import {
  type FleetInput,
  type FleetOperation,
  type FleetRequest,
  type FleetResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as FleetService from "../home/FleetService.ts";
import * as HomeService from "../home/HomeService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { assertFullAccess, assertLiveCaller, readCaller } from "./threadAccess.ts";

/**
 * Whether the calling thread is Home. Read on every call. A credential that
 * cannot control threads, or a client outside a thread, is never Home, so the
 * tool's own capability check still runs first.
 */
export const callerIsHome = Effect.fn("mcp.callerIsHome")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has("orchestration") || scope.thread === undefined) return false;
  // Optional, as upstream's toolkits are built without Home: no Home service, no Home caller.
  const home = yield* Effect.serviceOption(HomeService.HomeService);
  return Option.isSome(home) && (yield* home.value.isHome(scope.thread.threadId));
});

/** Whether each operation changes state. A new operation must pick a side. */
const CHANGES_STATE = {
  "requests.list": false,
  "requests.read": false,
  "threads.organize": true,
  "requests.respond": true,
} satisfies Record<FleetOperation, boolean>;

/**
 * Reads the caller for a change Home makes. A change needs a live Home run in
 * full-access/default mode, so switching Home to plan or a narrower runtime
 * mode makes it read-only everywhere.
 */
export const readHomeChangeCaller = Effect.fn("mcp.readHomeChangeCaller")(function* () {
  const context = yield* readCaller();
  yield* assertLiveCaller(context);
  yield* assertFullAccess(context, "Shift makes changes only in full-access/default mode.");
  return context;
});

/**
 * Runs an operation as Home in this environment, with the user's reach over
 * every project. Home reaches other environments through linked environments,
 * which forward the tool call before it gets here.
 */
const runAsHome = Effect.fn("mcp.runAsHome")(function* <Op extends FleetOperation>(
  op: Op,
  input: FleetInput<Op>,
) {
  const { scope } = CHANGES_STATE[op] ? yield* readHomeChangeCaller() : yield* readCaller();
  // Checked again here, right before acting: Home may have been turned off or
  // started fresh while the tool did earlier work.
  if (scope.thread === undefined || !(yield* callerIsHome())) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Only Shift can act with the user's reach.",
    });
  }
  const fleet = yield* Effect.serviceOption(FleetService.FleetService);
  if (Option.isNone(fleet)) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Only Shift can act with the user's reach.",
    });
  }
  const result = yield* fleet.value.execute({
    actor: { environmentId: scope.environmentId, threadId: scope.thread.threadId },
    // The pairing of op and input is what FleetInput<Op> guarantees.
    request: { op, input } as FleetRequest,
  });
  return result as FleetResult<Op>;
});

/** Runs a tool call from Home with Home's reach; None for any other caller. */
export const routeHome = Effect.fn("mcp.routeHome")(function* <Op extends FleetOperation>(
  op: Op,
  input: FleetInput<Op>,
) {
  if (!(yield* callerIsHome())) return Option.none<FleetResult<Op>>();
  return Option.some(yield* runAsHome(op, input));
});
