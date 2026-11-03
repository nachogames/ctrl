import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

/** Home, the agent thread a desktop-hosted server runs, and the watch reports its renderer sends. */
export function createHomeEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const reportScheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  return {
    enable: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:home:enable",
      tag: WS_METHODS.homeEnable,
      scheduler: lifecycleScheduler,
      concurrency: serialPerEnvironment,
    }),
    disable: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:home:disable",
      tag: WS_METHODS.homeDisable,
      scheduler: lifecycleScheduler,
      concurrency: serialPerEnvironment,
    }),
    startFresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:home:start-fresh",
      tag: WS_METHODS.homeStartFresh,
      scheduler: lifecycleScheduler,
      concurrency: serialPerEnvironment,
    }),
    reportWatchEvents: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:home:report-watch-events",
      tag: WS_METHODS.homeReportWatchEvents,
      scheduler: reportScheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}
