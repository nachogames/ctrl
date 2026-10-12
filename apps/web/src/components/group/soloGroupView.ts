import type {
  EnvironmentThreadGroup,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { ThreadGroupId } from "@t3tools/contracts";
import { resolveNewestCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";

/**
 * What the glance cards and script runner read: a visible group as it is, or a
 * solo chat's view from `soloGroupView`.
 */
export type GroupWorkspaceSource = Pick<
  EnvironmentThreadGroup,
  "environmentId" | "projectId" | "branch" | "worktreePath" | "pullRequest" | "links" | "threadIds"
> & {
  /** The group that stores links and owns the worktree; null for a chat without one yet. */
  readonly id: ThreadGroupId | null;
  /**
   * The group whose own worktree `worktreePath` is, so recreating it has
   * something to recreate. Unset means `id`; null when the path is the chat's.
   */
  readonly worktreeGroupId?: ThreadGroupId | null;
};

/**
 * A chat with no visible group, shaped as its own group: branch, worktree and
 * pull request from the chat (the hidden group's win when set), tickets from
 * the hidden group. A worktree on the project root is no worktree of its own.
 */
export function soloGroupView(
  thread: Pick<
    EnvironmentThreadShell,
    "environmentId" | "id" | "projectId" | "branch" | "worktreePath" | "pullRequests"
  > &
    Partial<Pick<EnvironmentThreadShell, "linkedPullRequest">>,
  hiddenGroup: Pick<
    EnvironmentThreadGroup,
    "id" | "branch" | "worktreePath" | "pullRequest" | "links"
  > | null,
  project: { readonly workspaceRoot: string } | null,
): GroupWorkspaceSource {
  const worktreePath = hiddenGroup?.worktreePath ?? thread.worktreePath;
  const ownWorktree = worktreePath !== project?.workspaceRoot ? worktreePath : null;
  return {
    id: hiddenGroup?.id ?? null,
    environmentId: thread.environmentId,
    projectId: thread.projectId,
    branch: hiddenGroup?.branch ?? thread.branch,
    worktreePath: ownWorktree,
    pullRequest: hiddenGroup?.pullRequest ?? resolveNewestCurrentPullRequestLink([thread]),
    links: hiddenGroup?.links ?? [],
    threadIds: [thread.id],
    worktreeGroupId:
      hiddenGroup !== null && ownWorktree !== null && hiddenGroup.worktreePath === ownWorktree
        ? hiddenGroup.id
        : null,
  };
}
