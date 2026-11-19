import type { PullRequestStackMembership } from "@t3tools/contracts";

export interface StackablePullRequestEntry {
  readonly environmentId: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly stack?: PullRequestStackMembership | undefined;
}

export type NestedPullRequestRow<E> =
  | { readonly kind: "entry"; readonly entry: E }
  | {
      readonly kind: "stack";
      readonly key: string;
      readonly membership: PullRequestStackMembership;
      /** Ordered bottom layer first. */
      readonly entries: ReadonlyArray<E>;
    };

/** Stack numbers are per repository, so the key carries where the stack lives. */
function pullRequestStackKey(entry: StackablePullRequestEntry): string | null {
  return entry.stack === undefined
    ? null
    : `${entry.environmentId}|${entry.host.toLowerCase()}|${entry.repository}|${entry.stack.number}`;
}

/**
 * Nests entries that share a stack under one block, placed where the first of them was.
 * A stack with a single entry here stays a plain row.
 */
export function nestPullRequestStacks<E extends StackablePullRequestEntry>(
  entries: ReadonlyArray<E>,
): ReadonlyArray<NestedPullRequestRow<E>> {
  const members = new Map<string, E[]>();
  for (const entry of entries) {
    const key = pullRequestStackKey(entry);
    if (key === null) continue;
    const list = members.get(key);
    if (list) list.push(entry);
    else members.set(key, [entry]);
  }
  const rows: NestedPullRequestRow<E>[] = [];
  const placed = new Set<string>();
  for (const entry of entries) {
    const key = pullRequestStackKey(entry);
    const stackEntries = key === null ? undefined : members.get(key);
    if (key === null || entry.stack === undefined || !stackEntries || stackEntries.length < 2) {
      rows.push({ kind: "entry", entry });
      continue;
    }
    if (placed.has(key)) continue;
    placed.add(key);
    rows.push({
      kind: "stack",
      key,
      membership: entry.stack,
      entries: [...stackEntries].sort(
        (left, right) => (left.stack?.position ?? 0) - (right.stack?.position ?? 0),
      ),
    });
  }
  return rows;
}
