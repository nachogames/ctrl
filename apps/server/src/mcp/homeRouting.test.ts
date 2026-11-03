import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type FleetInvokeInput,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as FleetService from "../home/FleetService.ts";
import * as HomeService from "../home/HomeService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { routeHome } from "./homeRouting.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const hub = EnvironmentId.make("hub");
const callerId = ThreadId.make("caller");
const target = ThreadId.make("target");
const result = { requestIds: [] };

const liveCaller = {
  id: callerId,
  deletedAt: null,
  archivedAt: null,
  activeRunId: "run",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access",
  interactionMode: "default",
};

const context = Layer.mergeAll(
  Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId: hub,
    requestNamespace: "session",
    thread: {
      threadId: callerId,
      providerSessionId: "session",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    issuedAt: 0,
    capabilities: new Set(["orchestration" as const]),
  }),
);

const setup = (isHome: boolean, caller: Partial<typeof liveCaller> = {}) => {
  const local: Array<FleetInvokeInput> = [];
  const layer = Layer.mergeAll(
    context,
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed({ ...liveCaller, ...caller } as unknown as OrchestrationV2ThreadShell),
    }),
    Layer.mock(HomeService.HomeService)({ available: true, isHome: () => Effect.succeed(isHome) }),
    Layer.mock(FleetService.FleetService)({
      execute: (input) => {
        local.push(input);
        return Effect.succeed(result);
      },
    }),
  );
  return { layer, local };
};

it.effect("leaves other threads to the tool's own handling", () => {
  const { layer, local } = setup(false);
  return Effect.gen(function* () {
    expect(Option.isNone(yield* routeHome("requests.list", { threadId: target }))).toBe(true);
    expect(local).toHaveLength(0);
  }).pipe(Effect.provide(layer));
});

it.effect("treats no caller as Home where Home's services are absent", () =>
  Effect.gen(function* () {
    expect(Option.isNone(yield* routeHome("requests.list", { threadId: target }))).toBe(true);
  }).pipe(
    Effect.provide(Layer.merge(context, Layer.mock(ThreadManagement.ThreadManagementService)({}))),
  ),
);

it.effect("runs Home's calls here as Home", () => {
  const { layer, local } = setup(true);
  return Effect.gen(function* () {
    yield* routeHome("requests.list", { threadId: target });
    const actor = { environmentId: hub, threadId: callerId };
    expect(local).toEqual([
      { actor, request: { op: "requests.list", input: { threadId: target } } },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("lets Home read but not change anything outside full-access/default mode", () => {
  const { layer, local } = setup(true, { interactionMode: "plan" });
  return Effect.gen(function* () {
    yield* routeHome("requests.list", { threadId: target });
    const error = yield* routeHome("threads.organize", { threadId: target, action: "pin" }).pipe(
      Effect.flip,
    );
    expect(error.code).toBe("capability_denied");
    expect(local).toHaveLength(1);
  }).pipe(Effect.provide(layer));
});
