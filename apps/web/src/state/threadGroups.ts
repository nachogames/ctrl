import { useAtomValue } from "@effect/atom-react";
import { threadGroupKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadGroup } from "@t3tools/client-runtime/state/models";
import {
  createEnvironmentThreadGroupAtoms,
  createThreadGroupEnvironmentAtoms,
} from "@t3tools/client-runtime/state/thread-groups";
import type { ScopedThreadGroupRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { threadEnvironment } from "./threads";

export const environmentThreadGroups = createEnvironmentThreadGroupAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
});

/** create / update / delete / moveThread. Run them with `useOrchestrationCommand`. */
export const threadGroupCommands = createThreadGroupEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_THREAD_GROUP_ATOM = Atom.make<EnvironmentThreadGroup | null>(null).pipe(
  Atom.withLabel("web-thread-group:empty"),
);

export function useThreadGroups(): ReadonlyArray<EnvironmentThreadGroup> {
  return useAtomValue(environmentThreadGroups.threadGroupsAtom);
}

export function useThreadGroup(ref: ScopedThreadGroupRef | null): EnvironmentThreadGroup | null {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_GROUP_ATOM : environmentThreadGroups.threadGroupAtom(ref),
  );
}

/** Imperative read for menus that snapshot state when they open. */
export function readThreadGroup(ref: ScopedThreadGroupRef): EnvironmentThreadGroup | null {
  return appAtomRegistry.get(environmentThreadGroups.threadGroupAtom(ref));
}

/** Keyed by `threadGroupKey`, so same-id groups on two environments stay apart. */
export function indexThreadGroups(
  groups: ReadonlyArray<EnvironmentThreadGroup>,
): ReadonlyMap<string, EnvironmentThreadGroup> {
  return new Map(
    groups.map(
      (group) =>
        [threadGroupKey({ environmentId: group.environmentId, groupId: group.id }), group] as const,
    ),
  );
}
