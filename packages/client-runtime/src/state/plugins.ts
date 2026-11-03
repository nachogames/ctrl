import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Local plugins on an environment, what they draw, and their commands. */
export function createPluginEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    /** Every plugin with its state, plus thread statuses and recent toasts. */
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:plugins",
      tag: WS_METHODS.pluginsSubscribe,
    }),
    /** The bands above one thread's composer, live while that thread is open. */
    bands: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:plugins:bands",
      tag: WS_METHODS.pluginsBandsSubscribe,
      idleTtlMs: 0,
    }),
    view: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:plugins:view",
      tag: WS_METHODS.pluginsViewRead,
    }),
    callView: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:plugins:view-call",
      tag: WS_METHODS.pluginsViewCall,
    }),
    pressBand: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:plugins:band-press",
      tag: WS_METHODS.pluginsBandPress,
    }),
    runCommand: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:plugins:command-run",
      tag: WS_METHODS.pluginsCommandRun,
    }),
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:plugins:set-enabled",
      tag: WS_METHODS.pluginsSetEnabled,
    }),
    reload: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:plugins:reload",
      tag: WS_METHODS.pluginsReload,
    }),
  };
}
