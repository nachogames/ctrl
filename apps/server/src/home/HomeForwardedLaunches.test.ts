import { expect, it } from "@effect/vitest";
import {
  DEFAULT_HOME_SETTINGS,
  EnvironmentId,
  type HomeSettings,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ForwardedCalls from "../mcp/ForwardedCalls.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as HomeForwardedLaunches from "./HomeForwardedLaunches.ts";
import * as HomeService from "./HomeService.ts";

const homeThreadId = ThreadId.make("home:shift");
const studio = EnvironmentId.make("studio");

const scope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("laptop"),
  requestNamespace: "session",
  thread: {
    threadId,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
});

const setup = () => {
  let settings: HomeSettings = { ...DEFAULT_HOME_SETTINGS, threadId: homeThreadId };
  const layer = HomeForwardedLaunches.layer.pipe(
    Layer.provide(
      Layer.mock(HomeService.HomeService)({
        available: true,
        isHome: (threadId) => Effect.succeed(threadId === homeThreadId),
        updateWatches: (_threadId, update) =>
          Effect.sync(() => {
            settings = update(settings);
            return settings;
          }),
      }),
    ),
  );
  return { layer, watches: () => settings.watches };
};

it.effect("watches a thread Shift launched on a linked machine", () => {
  const { layer, watches } = setup();
  return Effect.gen(function* () {
    const calls = yield* ForwardedCalls.ForwardedCalls;
    yield* calls.succeeded({
      scope: scope(homeThreadId),
      toolName: "t3_thread_launch",
      environmentId: studio,
      result: { threadId: "remote-thread", projectId: "p" },
    });
    expect(watches()).toEqual([
      { environmentId: studio, threadId: ThreadId.make("remote-thread"), reason: "launched" },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("leaves other threads' launches and Shift's other tools alone", () => {
  const { layer, watches } = setup();
  return Effect.gen(function* () {
    const calls = yield* ForwardedCalls.ForwardedCalls;
    yield* calls.succeeded({
      scope: scope(ThreadId.make("worker")),
      toolName: "t3_thread_launch",
      environmentId: studio,
      result: { threadId: "remote-thread" },
    });
    yield* calls.succeeded({
      scope: scope(homeThreadId),
      toolName: "t3_thread_send",
      environmentId: studio,
      result: { threadId: "remote-thread" },
    });
    expect(watches()).toEqual([]);
  }).pipe(Effect.provide(layer));
});
