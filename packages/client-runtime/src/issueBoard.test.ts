import type { EnvironmentId, IssueState, IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { issueBoard } from "./issueBoard.ts";
import type { EnvironmentIssueEntry } from "./issueList.ts";

const checkout = { id: "prj_checkout", name: "Checkout" };
const todo: IssueState = { category: "open", name: "Todo", stage: "unstarted", order: 0 };
const doing: IssueState = { category: "open", name: "In Progress", stage: "started", order: 1 };
const review: IssueState = { category: "open", name: "In Review", stage: "started", order: 2 };
const done: IssueState = {
  category: "closed",
  name: "Done",
  closeReason: "completed",
  stage: "completed",
  order: 0,
};

function row(
  key: string,
  state: IssueState,
  overrides: Partial<EnvironmentIssueEntry> = {},
): EnvironmentIssueEntry {
  return {
    tracker: "linear" as IssueTrackerKind,
    host: "linear.app",
    scope: "ENG",
    key,
    displayKey: key,
    title: `Issue ${key}`,
    url: `https://linear.app/acme/issue/${key}`,
    author: null,
    state,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    projectId: "api" as ProjectId,
    projectTitle: "api",
    environmentId: "env-1" as EnvironmentId,
    trackerProject: checkout,
    ...overrides,
  };
}

const under = (key: string) => ({ parent: { key, displayKey: key, title: `Issue ${key}` } });
const keys = (cells: ReadonlyArray<ReadonlyArray<EnvironmentIssueEntry>>) =>
  cells.map((cell) => cell.map((entry) => entry.key));

describe("issueBoard", () => {
  it("gives each parent a lane of its sub-issues at every depth, by state in workflow order", () => {
    const board = issueBoard([
      row("ENG-4", review, under("ENG-2")),
      row("ENG-1", doing),
      row("ENG-2", doing, under("ENG-1")),
      row("ENG-3", done, under("ENG-1")),
      row("ENG-5", todo),
      // Another team's "in progress" shares the column.
      row("OPS-1", { ...doing, name: "in progress", order: 9 }),
    ]);

    expect(board.columns.map((column) => column.name)).toEqual([
      "Todo",
      "In Progress",
      "In Review",
      "Done",
    ]);
    const [milestone] = board.projects[0]!.milestones;
    expect(
      milestone!.lanes.map((lane) => [lane.parent?.key ?? null, lane.progress, keys(lane.cells)]),
    ).toEqual([
      ["ENG-1", { done: 1, total: 3 }, [[], ["ENG-2"], ["ENG-4"], ["ENG-3"]]],
      [null, { done: 0, total: 2 }, [["ENG-5"], ["OPS-1"], [], []]],
    ]);
    expect(board.projects[0]!.progress).toEqual({ done: 1, total: 6 });

    // Hiding closed cards keeps the lane and its full progress; a lane with nothing left goes.
    const open = issueBoard(
      [row("ENG-1", doing), row("ENG-3", done, under("ENG-1")), row("ENG-6", done)],
      (entry) => entry.state.category === "open",
    );
    expect(
      open.projects[0]!.milestones[0]!.lanes.map((lane) => [lane.parent?.key, lane.progress]),
    ).toEqual([["ENG-1", { done: 1, total: 1 }]]);
    // The closed column empties out, so it leaves the board.
    expect(open.columns.map((column) => column.name)).toEqual(["In Progress"]);
  });
});
