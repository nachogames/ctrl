import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Spoken-reply atoms for every environment. Install and remove run one at a
 * time per environment; synthesize calls queue on the server's native permit.
 */
export function createSpeechEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  return {
    /** Server-pushed settings, voice download progress, and readiness for one environment. */
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:speech:state",
      tag: WS_METHODS.subscribeSpeechState,
    }),
    install: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:speech:install",
      tag: WS_METHODS.speechInstall,
      scheduler,
      concurrency,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:speech:remove",
      tag: WS_METHODS.speechRemove,
      scheduler,
      concurrency,
    }),
    /** Speaks one sentence; returns base64 WAV. */
    synthesize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:speech:synthesize",
      tag: WS_METHODS.speechSynthesize,
    }),
    /** Whether the front voice can answer on this environment, for settings. */
    frontStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:voice-front:status",
      tag: WS_METHODS.voiceFrontStatus,
    }),
    /** The front voice's reply to one voice turn; each value carries the whole reply so far. */
    frontReply: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:voice-front:reply",
      tag: WS_METHODS.voiceFrontRespond,
      completeWhen: (reply) => reply.done,
      idleTtlMs: 0,
      sensitiveInput: true,
    }),
  };
}
