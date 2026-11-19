import { nestPullRequestStacks } from "@t3tools/client-runtime/pull-request-stack-nesting";
import type { PullRequestStackMembership } from "@t3tools/contracts";

import {
  pullRequestListRowsAreEqual,
  scopedPullRequestListKey,
  type EnvironmentPullRequestListEntry,
} from "./pullRequestList";

/** One row of the PR list: a PR, or the header of two or more PRs from one stack. */
export type PullRequestListItem =
  | {
      readonly kind: "entry";
      readonly entry: EnvironmentPullRequestListEntry;
      /** Shown under a stack header. */
      readonly nested: boolean;
    }
  | {
      readonly kind: "stack";
      readonly key: string;
      readonly membership: PullRequestStackMembership;
      /** Bottom layer first. */
      readonly entries: ReadonlyArray<EnvironmentPullRequestListEntry>;
      readonly open: boolean;
    };

/** Flattens nested stacks for a flat list; a folded stack keeps only its header. */
export function pullRequestListItems(
  entries: ReadonlyArray<EnvironmentPullRequestListEntry>,
  collapsedStacks: ReadonlySet<string>,
  selectedKey: string | null | undefined,
): ReadonlyArray<PullRequestListItem> {
  return nestPullRequestStacks(entries).flatMap((row): PullRequestListItem[] => {
    if (row.kind === "entry") return [{ kind: "entry", entry: row.entry, nested: false }];
    // The selected PR never hides inside a folded stack.
    const open =
      !collapsedStacks.has(row.key) ||
      row.entries.some((entry) => scopedPullRequestListKey(entry) === selectedKey);
    return [
      { kind: "stack", key: row.key, membership: row.membership, entries: row.entries, open },
      ...(open
        ? row.entries.map((entry) => ({ kind: "entry" as const, entry, nested: true }))
        : []),
    ];
  });
}

export const pullRequestListItemKey = (item: PullRequestListItem) =>
  item.kind === "stack" ? `stack:${item.key}` : scopedPullRequestListKey(item.entry);

export function pullRequestListItemsAreEqual(
  previous: PullRequestListItem,
  next: PullRequestListItem,
): boolean {
  if (previous.kind === "entry" && next.kind === "entry") {
    return (
      previous.nested === next.nested && pullRequestListRowsAreEqual(previous.entry, next.entry)
    );
  }
  if (previous.kind === "stack" && next.kind === "stack") {
    return (
      previous.key === next.key &&
      previous.open === next.open &&
      previous.membership.size === next.membership.size &&
      previous.membership.base === next.membership.base &&
      previous.entries.length === next.entries.length
    );
  }
  return false;
}

/** The PRs a list row shows, for visibility tracking. */
export const pullRequestListItemEntries = (item: PullRequestListItem) =>
  item.kind === "entry" ? [item.entry] : [];
