import type {
  EnvironmentThreadGroup,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { ThreadGroupId, ThreadId } from "@t3tools/contracts";

type SuggestionThread = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "projectId" | "worktreePath" | "archivedAt" | "deletedAt" | "groupId"
> & {
  readonly lineage: Pick<EnvironmentThreadShell["lineage"], "relationshipToParent">;
};

/**
 * The other chats a solo chat could group with: live, non-subagent chats of
 * its project on the same dedicated worktree (never the project root) that are
 * not in a visible group. Empty when there is nothing to suggest.
 */
export function worktreeGroupSuggestion(
  thread: Pick<SuggestionThread, "id" | "environmentId" | "projectId" | "worktreePath">,
  projectThreads: ReadonlyArray<SuggestionThread>,
  groupsById: ReadonlyMap<ThreadGroupId, Pick<EnvironmentThreadGroup, "visible">>,
  projectRoot: string | null,
): ReadonlyArray<ThreadId> {
  const worktreePath = thread.worktreePath;
  if (worktreePath === null || worktreePath === projectRoot) return [];
  return projectThreads.flatMap((other) =>
    other.id !== thread.id &&
    other.environmentId === thread.environmentId &&
    other.projectId === thread.projectId &&
    other.worktreePath === worktreePath &&
    other.archivedAt === null &&
    other.deletedAt === null &&
    other.lineage.relationshipToParent !== "subagent" &&
    (other.groupId === null || groupsById.get(other.groupId)?.visible !== true)
      ? [other.id]
      : [],
  );
}
