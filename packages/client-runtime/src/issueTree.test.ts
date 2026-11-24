import type { EnvironmentId, IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentIssueEntry } from "./issueList.ts";
import { issueTree, type IssueTreeNode } from "./issueTree.ts";

const checkout = { id: "prj_checkout", name: "Checkout" };
const auth = { id: "prj_auth", name: "Auth" };
const beta = { id: "ms_beta", name: "Beta" };

function row(key: string, overrides: Partial<EnvironmentIssueEntry> = {}): EnvironmentIssueEntry {
  return {
    tracker: "linear" as IssueTrackerKind,
    host: "linear.app",
    scope: "ENG",
    key,
    displayKey: key,
    title: `Issue ${key}`,
    url: `https://linear.app/acme/issue/${key}`,
    author: null,
    state: { category: "open", name: "Todo" },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    projectId: "api" as ProjectId,
    projectTitle: "api",
    environmentId: "env-1" as EnvironmentId,
    ...overrides,
  };
}

const parentOf = (key: string) => ({ key, displayKey: key, title: `Issue ${key}` });
const keys = (nodes: ReadonlyArray<IssueTreeNode>): unknown[] =>
  nodes.map((node) =>
    node.children.length ? [node.entry.key, keys(node.children)] : node.entry.key,
  );

describe("issueTree", () => {
  it("nests issues by project, milestone and parent, with ungrouped issues last", () => {
    const tree = issueTree([
      row("ENG-5", { trackerProject: checkout, milestone: beta, parent: parentOf("ENG-1") }),
      row("ENG-4"),
      row("ENG-3", { trackerProject: auth }),
      row("ENG-2", { trackerProject: checkout }),
      // Its project is the parent's, even where the child names none.
      row("ENG-6", { parent: parentOf("ENG-5") }),
      row("ENG-1", { trackerProject: checkout, milestone: beta }),
    ]);

    expect(
      tree.map((project) => [
        project.project?.name ?? null,
        project.count,
        project.milestones.map((m) => [m.milestone?.name ?? null, keys(m.roots)]),
      ]),
    ).toEqual([
      ["Auth", 1, [[null, ["ENG-3"]]]],
      [
        "Checkout",
        4,
        [
          ["Beta", [["ENG-1", [["ENG-5", ["ENG-6"]]]]]],
          [null, ["ENG-2"]],
        ],
      ],
      [null, 1, [[null, ["ENG-4"]]]],
    ]);
  });

  it("keeps a sub-issue whose parent is not listed, and survives a cycle", () => {
    const tree = issueTree([
      row("ENG-7", { parent: parentOf("ENG-99") }),
      row("ENG-8", { parent: parentOf("ENG-9") }),
      row("ENG-9", { parent: parentOf("ENG-8") }),
    ]);
    expect(tree.flatMap((p) => p.milestones.flatMap((m) => keys(m.roots)))).toEqual([
      "ENG-7",
      ["ENG-8", ["ENG-9"]],
    ]);
    expect(tree[0]?.count).toBe(3);
  });
});
