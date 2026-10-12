import type { EnvironmentId, ProjectId, ThreadGroupId } from "@t3tools/contracts";

/** A draft that may carry a group from "New chat in group". */
export interface DraftGroupTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly groupId?: ThreadGroupId | undefined;
}

interface GroupWorkspace {
  readonly id: ThreadGroupId;
  readonly projectId: ProjectId;
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

/**
 * The draft's group while it still exists in the draft's project. `group` is
 * the lookup of the draft's `groupId`; a group that has gone (or moved
 * project) means the draft launches ungrouped.
 */
export function liveDraftGroup<Group extends GroupWorkspace>(
  draft: DraftGroupTarget | null | undefined,
  group: Group | null,
): Group | null {
  return group !== null && draft?.groupId === group.id && draft.projectId === group.projectId
    ? group
    : null;
}

/**
 * The workspace a draft's first send launches into. A chat joining a group
 * uses the group's branch and worktree, never the draft's, so it never
 * prepares a worktree of its own.
 */
export function resolveDraftLaunchWorkspace(input: {
  readonly draft: { readonly branch: string | null; readonly worktreePath: string | null };
  readonly group: GroupWorkspace | null;
}): {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly groupId?: ThreadGroupId;
} {
  const { draft, group } = input;
  return group === null
    ? { branch: draft.branch, worktreePath: draft.worktreePath }
    : { branch: group.branch, worktreePath: group.worktreePath, groupId: group.id };
}
