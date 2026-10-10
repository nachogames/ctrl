import * as Crypto from "effect/Crypto";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  type CreateThreadGroupInput,
  type DeleteThreadGroupInput,
  type MoveThreadToGroupInput,
  type UpdateThreadGroupInput,
  createThreadGroup,
  deleteThreadGroup,
  moveThreadToGroup,
  updateThreadGroup,
} from "../operations/commands.ts";
import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";

export type {
  CreateThreadGroupInput,
  DeleteThreadGroupInput,
  MoveThreadToGroupInput,
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
  return {
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
