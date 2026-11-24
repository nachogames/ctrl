import type { IssueGroupRef } from "@t3tools/contracts";

import type { EnvironmentIssueEntry } from "./issueList.ts";

export interface IssueTreeNode {
  readonly entry: EnvironmentIssueEntry;
  readonly children: ReadonlyArray<IssueTreeNode>;
}

export interface IssueTreeMilestone {
  /** Null holds the project's issues in no milestone. */
  readonly milestone: IssueGroupRef | null;
  readonly roots: ReadonlyArray<IssueTreeNode>;
}

export interface IssueTreeProject {
  /** Null holds the issues in no tracker project. */
  readonly project: IssueGroupRef | null;
  readonly milestones: ReadonlyArray<IssueTreeMilestone>;
  readonly count: number;
}

const issueId = (entry: Pick<EnvironmentIssueEntry, "tracker" | "host" | "key">) =>
  `${entry.tracker} ${entry.host.toLowerCase()} ${entry.key}`;

const byName = (left: IssueGroupRef | null, right: IssueGroupRef | null) =>
  left === null
    ? right === null
      ? 0
      : 1
    : right === null
      ? -1
      : left.name.localeCompare(right.name);

/** Whether a node or any issue under it passes the filter, so filtering keeps the path to it. */
export function treeHasVisible(
  node: IssueTreeNode,
  visible: (entry: EnvironmentIssueEntry) => boolean,
): boolean {
  return visible(node.entry) || node.children.some((child) => treeHasVisible(child, visible));
}

/**
 * Nests rows as tracker project, then milestone, then parent issue. A sub-issue sits under its
 * parent wherever the parent is listed, so the parent's project and milestone place it; one whose
 * parent is not listed is a root of its own. Rows keep the order they arrive in.
 */
export function issueTree(rows: ReadonlyArray<EnvironmentIssueEntry>): IssueTreeProject[] {
  const listed = new Map(rows.map((row) => [issueId(row), row]));
  const children = new Map<string, EnvironmentIssueEntry[]>();
  const roots: EnvironmentIssueEntry[] = [];
  for (const row of rows) {
    const parentId = row.parent ? issueId({ ...row, key: row.parent.key }) : null;
    if (parentId !== null && parentId !== issueId(row) && listed.has(parentId)) {
      children.set(parentId, [...(children.get(parentId) ?? []), row]);
    } else {
      roots.push(row);
    }
  }

  // Trackers refuse cycles, but a listing read across pages can still disagree with itself.
  const placed = new Set<string>();
  const node = (entry: EnvironmentIssueEntry): IssueTreeNode => {
    placed.add(issueId(entry));
    return {
      entry,
      children: (children.get(issueId(entry)) ?? [])
        .filter((child) => !placed.has(issueId(child)))
        .map(node),
    };
  };
  const nodes = roots.map(node);
  for (const row of rows) if (!placed.has(issueId(row))) nodes.push(node(row));

  const projects = new Map<
    string,
    {
      project: IssueGroupRef | null;
      milestones: Map<string, IssueTreeMilestone & { roots: IssueTreeNode[] }>;
      count: number;
    }
  >();
  const size = (tree: IssueTreeNode): number =>
    1 + tree.children.reduce((sum, child) => sum + size(child), 0);
  for (const tree of nodes) {
    const { entry } = tree;
    const project = entry.trackerProject ?? null;
    const projectKey =
      project === null ? "" : `${entry.tracker} ${entry.host.toLowerCase()} ${project.id}`;
    const group = projects.get(projectKey) ?? { project, milestones: new Map(), count: 0 };
    projects.set(projectKey, group);
    const milestone = entry.milestone ?? null;
    const milestoneKey = milestone?.id ?? "";
    const holder = group.milestones.get(milestoneKey) ?? { milestone, roots: [] };
    group.milestones.set(milestoneKey, holder);
    holder.roots.push(tree);
    group.count += size(tree);
  }

  return [...projects.values()]
    .map((group) => ({
      project: group.project,
      count: group.count,
      milestones: [...group.milestones.values()].sort((a, b) => byName(a.milestone, b.milestone)),
    }))
    .sort((a, b) => byName(a.project, b.project));
}
