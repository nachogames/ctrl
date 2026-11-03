import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createRemoteMcpEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  return {
    servers: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:remote-mcp:servers",
      tag: WS_METHODS.remoteMcpSubscribe,
    }),
    add: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:remote-mcp:add",
      tag: WS_METHODS.remoteMcpAdd,
      scheduler,
      concurrency,
    }),
    // A sign-in waits on the remote server, so it does not hold up the others.
    authorize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:remote-mcp:authorize",
      tag: WS_METHODS.remoteMcpAuthorize,
    }),
    reconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:remote-mcp:reconnect",
      tag: WS_METHODS.remoteMcpReconnect,
      scheduler,
      concurrency,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:remote-mcp:remove",
      tag: WS_METHODS.remoteMcpRemove,
      scheduler,
      concurrency,
    }),
  };
}
