import { type ScopedThreadGroupRef, type ScopedThreadRef, WS_METHODS } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  type CreateThreadGroupInput,
  type DeleteThreadGroupInput,
  type MoveThreadToGroupInput,
  type RecreateThreadGroupWorktreeInput,
  type RemoveThreadGroupResourceInput,
  type UpdateThreadGroupInput,
  createThreadGroup,
  deleteThreadGroup,
  moveThreadToGroup,
  recreateThreadGroupWorktree,
  removeThreadGroupResource,
  updateThreadGroup,
} from "../operations/commands.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export type {
  CreateThreadGroupInput,
  DeleteThreadGroupInput,
  MoveThreadToGroupInput,
  RecreateThreadGroupWorktreeInput,
  RemoveThreadGroupResourceInput,
  UpdateThreadGroupInput,
} from "../operations/commands.ts";

export function createThreadGroupEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  // Commands for one group, or moves of one thread, run in order.
  const groupConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { groupId: string } }) =>
      JSON.stringify([environmentId, input.groupId]),
  };
  const resources = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:thread-group:resources",
    tag: WS_METHODS.threadGroupsSubscribeResources,
    // The server scans while this is subscribed, so stop with the last reader.
    idleTtlMs: 0,
  });
  return {
    /** A group's, or a lone chat's, running resources, live while a component reads it. */
    resources: (ref: ScopedThreadGroupRef | ScopedThreadRef) =>
      resources({
        environmentId: ref.environmentId,
        input: "groupId" in ref ? { groupId: ref.groupId } : { threadId: ref.threadId },
      }),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread-group:create",
      execute: (input: CreateThreadGroupInput) => createThreadGroup(input),
      scheduler,
      concurrency: groupConcurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread-group:update",
      execute: (input: UpdateThreadGroupInput) => updateThreadGroup(input),
      scheduler,
      concurrency: groupConcurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread-group:delete",
      execute: (input: DeleteThreadGroupInput) => deleteThreadGroup(input),
      scheduler,
      concurrency: groupConcurrency,
    }),
    recreateWorktree: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread-group:recreate-worktree",
      execute: (input: RecreateThreadGroupWorktreeInput) => recreateThreadGroupWorktree(input),
      scheduler,
      concurrency: groupConcurrency,
    }),
    removeResource: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread-group:remove-resource",
      execute: (input: RemoveThreadGroupResourceInput) => removeThreadGroupResource(input),
      scheduler,
      concurrency: groupConcurrency,
    }),
    moveThread: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread-group:move-thread",
      execute: (input: MoveThreadToGroupInput) => moveThreadToGroup(input),
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
          JSON.stringify([environmentId, input.threadId]),
      },
    }),
  };
}
