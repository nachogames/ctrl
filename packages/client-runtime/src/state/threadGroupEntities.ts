import type {
  EnvironmentId,
  OrchestrationV2ShellSnapshot,
  ScopedThreadGroupRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import { arrayElementsEqual, parseThreadGroupKey, threadGroupKey } from "./entities.ts";
import { type EnvironmentThreadGroup, presentThreadGroup } from "./models.ts";

const EMPTY_GROUPS: ReadonlyArray<EnvironmentThreadGroup> = Object.freeze([]);

export function createEnvironmentThreadGroupAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationV2ShellSnapshot | null>;
}) {
  // One list per environment: a group's members come only from its own
  // environment's shell, so same-id groups on two servers never mix.
  // Thread shells change on every streamed batch. A group keeps its object
  // until its own shell or its member list changes, so rows do not re-render.
  const environmentThreadGroupsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<EnvironmentThreadGroup> = EMPTY_GROUPS;
    return Atom.make((get): ReadonlyArray<EnvironmentThreadGroup> => {
      const snapshot = get(input.snapshotAtom(environmentId));
      const groups = snapshot?.groups ?? [];
      if (groups.length === 0) {
        previous = EMPTY_GROUPS;
        return previous;
      }
      const priorById = new Map(previous.map((group) => [group.id, group] as const));
      const next = groups.map((group) => {
        const presented = presentThreadGroup(environmentId, group, snapshot?.threads ?? []);
        const prior = priorById.get(group.id);
        return prior !== undefined &&
          prior.source === group &&
          arrayElementsEqual(prior.threadIds, presented.threadIds)
          ? prior
          : presented;
      });
      if (arrayElementsEqual(previous, next)) return previous;
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-thread-groups:${environmentId}`));
  });

  const threadGroupAtomFamily = Atom.family((key: string) => {
    const { environmentId, groupId } = parseThreadGroupKey(key);
    return Atom.make(
      (get): EnvironmentThreadGroup | null =>
        get(environmentThreadGroupsAtom(environmentId)).find((group) => group.id === groupId) ??
        null,
    ).pipe(Atom.withLabel(`environment-thread-group:${key}`));
  });

  let previousGroups: ReadonlyArray<EnvironmentThreadGroup> = EMPTY_GROUPS;
  const threadGroupsAtom = Atom.make((get) => {
    const next: Array<EnvironmentThreadGroup> = [];
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      next.push(...get(environmentThreadGroupsAtom(environmentId)));
    }
    if (arrayElementsEqual(previousGroups, next)) return previousGroups;
    previousGroups = next;
    return previousGroups;
  }).pipe(Atom.withLabel("environment-thread-group-list"));

  return {
    environmentThreadGroupsAtom,
    threadGroupAtom: (ref: ScopedThreadGroupRef) => threadGroupAtomFamily(threadGroupKey(ref)),
    threadGroupsAtom,
  };
}
