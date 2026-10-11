import type { ContextMenuItem, ThreadGroupId } from "@t3tools/contracts";

/**
 * Ids for a chat's "Move to group…" submenu and "Remove from group". A target
 * group dispatches as `move-to-group:<groupId>`; group ids are unique within
 * the chat's environment, which is the only one the submenu lists.
 */
export type MoveToGroupMenuId =
  | "move-to-group"
  | `move-to-group:${string}`
  | "move-to-new-group"
  | "remove-from-group";

export interface MoveToGroupCandidate {
  readonly id: ThreadGroupId;
  readonly title: string;
  /** Newest member activity; the submenu lists the most active group first. */
  readonly activityMs: number;
}

/**
 * "Move to group…" lists the chat's project groups (the current one checked
 * and disabled), then "New group with this chat". "Remove from group" follows
 * for a grouped chat only.
 */
export function buildMoveToGroupMenuItems(input: {
  readonly groups: ReadonlyArray<MoveToGroupCandidate>;
  readonly currentGroupId: ThreadGroupId | null;
}): ReadonlyArray<ContextMenuItem<MoveToGroupMenuId>> {
  const groups = input.groups.toSorted((left, right) => right.activityMs - left.activityMs);
  return [
    {
      id: "move-to-group",
      label: "Move to group…",
      children: [
        ...groups.map((group) => {
          const current = group.id === input.currentGroupId;
          return {
            id: `move-to-group:${group.id}` as const,
            label: group.title,
            ...(current ? { checked: true, disabled: true } : {}),
          };
        }),
        {
          id: "move-to-new-group" as const,
          label: "New group with this chat",
          ...(groups.length > 0 ? { separatorBefore: true } : {}),
        },
      ],
    },
    ...(input.currentGroupId !== null
      ? [{ id: "remove-from-group" as const, label: "Remove from group" }]
      : []),
  ];
}

/** The target group of a `move-to-group:<groupId>` action; null for any other id. */
export function parseMoveToGroupTarget(action: string): string | null {
  const prefix = "move-to-group:";
  return action.startsWith(prefix) && action.length > prefix.length
    ? action.slice(prefix.length)
    : null;
}

/** The server refused a move because the chat works in another workspace than the group. */
export function isThreadGroupWorkspaceMismatch(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ThreadGroupMutationError" &&
    "reason" in error &&
    error.reason === "workspace-mismatch"
  );
}

export function workspaceMismatchConfirmMessage(input: {
  readonly chatTitle: string;
  readonly group: {
    readonly title: string;
    readonly branch: string | null;
    readonly worktreePath: string | null;
  };
}): string {
  const { group } = input;
  const branch = group.branch === null ? "" : ` (${group.branch})`;
  const where = group.worktreePath ?? "the project's main checkout";
  return `Move “${input.chatTitle}” to ${group.title}'s workspace${branch}? The chat will continue in ${where}.`;
}

export type MoveWithWorkspaceConfirmOutcome<R> =
  | { readonly kind: "moved" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly result: R };

/**
 * Moves a chat into a group. When the server reports a workspace mismatch it
 * asks the user, then retries once adopting the group's workspace. Any other
 * failure, or a failure of the retry, is returned for the caller to report.
 */
export async function moveWithWorkspaceConfirm<R extends { readonly _tag: string }>(input: {
  readonly move: (adoptGroupWorkspace: boolean) => Promise<R>;
  readonly failureOf: (result: R) => unknown;
  readonly confirm: () => Promise<boolean>;
}): Promise<MoveWithWorkspaceConfirmOutcome<R>> {
  const first = await input.move(false);
  if (first._tag === "Success") return { kind: "moved" };
  if (!isThreadGroupWorkspaceMismatch(input.failureOf(first))) {
    return { kind: "failed", result: first };
  }
  if (!(await input.confirm())) return { kind: "cancelled" };
  const retry = await input.move(true);
  return retry._tag === "Success" ? { kind: "moved" } : { kind: "failed", result: retry };
}
