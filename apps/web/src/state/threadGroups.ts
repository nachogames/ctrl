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
import { liveDraftGroup, type DraftGroupTarget } from "../lib/draftGroupLaunch";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { threadEnvironment } from "./threads";

export const environmentThreadGroups = createEnvironmentThreadGroupAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
});

/** create / update / delete / moveThread / removeResource / recreateWorktree. Run them with `useOrchestrationCommand`. */
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

/** Every known group, for menus that snapshot state when they open. */
export function readThreadGroups(): ReadonlyArray<EnvironmentThreadGroup> {
  return appAtomRegistry.get(environmentThreadGroups.threadGroupsAtom);
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

function draftGroupRef(draft: DraftGroupTarget | null | undefined): ScopedThreadGroupRef | null {
  return draft?.groupId ? { environmentId: draft.environmentId, groupId: draft.groupId } : null;
}

/** See `liveDraftGroup`: a draft whose group has gone launches ungrouped. */
export function readLiveDraftGroup(
  draft: DraftGroupTarget | null | undefined,
): EnvironmentThreadGroup | null {
  const ref = draftGroupRef(draft);
  return ref === null ? null : liveDraftGroup(draft, readThreadGroup(ref));
}

export function useLiveDraftGroup(
  draft: DraftGroupTarget | null | undefined,
): EnvironmentThreadGroup | null {
  return liveDraftGroup(draft, useThreadGroup(draftGroupRef(draft)));
}
