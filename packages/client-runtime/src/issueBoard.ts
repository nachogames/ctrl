import type { IssueGroupRef, IssueStateStage } from "@t3tools/contracts";

import type { EnvironmentIssueEntry } from "./issueList.ts";
import { issueTree, type IssueTreeNode } from "./issueTree.ts";

export interface IssueProgress {
  readonly done: number;
  readonly total: number;
}

export interface IssueBoardColumn {
  /** A state's name; teams that share a name share a column. */
  readonly name: string;
  readonly closed: boolean;
}

export interface IssueBoardLane {
  /** Null holds the issues with no listed parent. */
  readonly parent: EnvironmentIssueEntry | null;
  /** Of the issues in the lane, not counting the parent. */
  readonly progress: IssueProgress;
  /** One list per board column, in column order. */
  readonly cells: ReadonlyArray<ReadonlyArray<EnvironmentIssueEntry>>;
}

export interface IssueBoardProject {
  readonly project: IssueGroupRef | null;
  readonly progress: IssueProgress;
  readonly milestones: ReadonlyArray<{
    readonly milestone: IssueGroupRef | null;
    readonly lanes: ReadonlyArray<IssueBoardLane>;
  }>;
}

const STAGE_RANK: Record<IssueStateStage, number> = {
  backlog: 0,
  unstarted: 1,
  started: 2,
  completed: 3,
  canceled: 4,
};

const columnKey = (entry: EnvironmentIssueEntry) => entry.state.name.toLowerCase();

const rank = (entry: EnvironmentIssueEntry) =>
  [
    entry.state.stage === undefined
      ? entry.state.category === "closed"
        ? 3
        : 2
      : STAGE_RANK[entry.state.stage],
    entry.state.order ?? 0,
  ] as const;

const descendants = (node: IssueTreeNode): EnvironmentIssueEntry[] =>
  node.children.flatMap((child) => [child.entry, ...descendants(child)]);

export const progressOf = (entries: ReadonlyArray<EnvironmentIssueEntry>): IssueProgress => ({
  done: entries.filter((entry) => entry.state.category === "closed").length,
  total: entries.length,
});

/** How many of a tree node's sub-issues, at any depth, are closed. Null for a leaf. */
export function nodeProgress(node: IssueTreeNode): IssueProgress | null {
  return node.children.length === 0 ? null : progressOf(descendants(node));
}

/**
 * Lays rows out as a board: tracker project, then milestone, then one lane per top-level parent
 * issue holding its sub-issues at every depth, by state. Columns are the states the rows are in,
 * in workflow order.
 */
export function issueBoard(
  rows: ReadonlyArray<EnvironmentIssueEntry>,
  /** Cards to show. Progress still counts every row; a lane shows while its parent or a card does. */
  visible: (entry: EnvironmentIssueEntry) => boolean = () => true,
): {
  readonly columns: ReadonlyArray<IssueBoardColumn>;
  readonly projects: ReadonlyArray<IssueBoardProject>;
} {
  const byKey = new Map<string, EnvironmentIssueEntry>();
  for (const row of rows) {
    const current = byKey.get(columnKey(row));
    if (current === undefined) {
      byKey.set(columnKey(row), row);
      continue;
    }
    const [a, b] = rank(row);
    const [c, d] = rank(current);
    if (a < c || (a === c && b < d)) byKey.set(columnKey(row), row);
  }
  const ordered = [...byKey.values()].sort((left, right) => {
    const [a, b] = rank(left);
    const [c, d] = rank(right);
    return a - c || b - d || left.state.name.localeCompare(right.state.name);
  });
  const columns = ordered.map((entry) => ({
    name: entry.state.name,
    closed: entry.state.category === "closed",
  }));
  const index = new Map(ordered.map((entry, position) => [columnKey(entry), position]));
  const cellsOf = (entries: ReadonlyArray<EnvironmentIssueEntry>) => {
    const cells = columns.map((): EnvironmentIssueEntry[] => []);
    for (const entry of entries) {
      if (visible(entry)) cells[index.get(columnKey(entry))!]!.push(entry);
    }
    return cells;
  };
  const shows = (lane: IssueBoardLane) =>
    (lane.parent !== null && visible(lane.parent)) || lane.cells.some((cell) => cell.length > 0);

  const projects = issueTree(rows).map((group) => {
    const all: EnvironmentIssueEntry[] = [];
    const milestones = group.milestones.map(({ milestone, roots }) => {
      const loose: EnvironmentIssueEntry[] = [];
      const lanes: IssueBoardLane[] = [];
      for (const root of roots) {
        all.push(root.entry);
        if (root.children.length === 0) {
          loose.push(root.entry);
          continue;
        }
        const items = descendants(root);
        all.push(...items);
        lanes.push({ parent: root.entry, progress: progressOf(items), cells: cellsOf(items) });
      }
      if (loose.length > 0) {
        lanes.push({ parent: null, progress: progressOf(loose), cells: cellsOf(loose) });
      }
      return { milestone, lanes: lanes.filter(shows) };
    });
    return {
      project: group.project,
      progress: progressOf(all),
      milestones: milestones.filter((milestone) => milestone.lanes.length > 0),
    };
  });
  // A closed state with nothing shown in it is noise once closed cards are hidden.
  const shownProjects = projects.filter((project) => project.milestones.length > 0);
  const lanes = shownProjects.flatMap((project) =>
    project.milestones.flatMap((milestone) => milestone.lanes),
  );
  const keep = columns.map(
    (column, position) => !column.closed || lanes.some((lane) => lane.cells[position]!.length > 0),
  );
  if (keep.every(Boolean)) return { columns, projects: shownProjects };
  const trim = <T>(items: ReadonlyArray<T>) => items.filter((_, position) => keep[position]);
  return {
    columns: trim(columns),
    projects: shownProjects.map((project) => ({
      ...project,
      milestones: project.milestones.map((milestone) => ({
        ...milestone,
        lanes: milestone.lanes.map((lane) => ({ ...lane, cells: trim(lane.cells) })),
      })),
    })),
  };
}
