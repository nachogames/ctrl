import {
  EnvironmentId,
  ProjectId,
  ThreadGroupId,
  ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { soloGroupView } from "./soloGroupView";

const ROOT = "/repo";

function pullRequest(number: number): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "pingdotgg/t3code",
    number,
    url: `https://github.com/pingdotgg/t3code/pull/${number}`,
    source: "manual",
    linkedAt: `2026-10-12T00:00:${String(number).padStart(2, "0")}.000Z`,
    snapshot: null,
    stack: null,
  };
}

function thread(overrides: Partial<Parameters<typeof soloGroupView>[0]> = {}) {
  return {
    environmentId: EnvironmentId.make("env"),
    id: ThreadId.make("chat"),
    projectId: ProjectId.make("project"),
    branch: "feat/solo",
    worktreePath: "/worktrees/solo",
    pullRequests: [pullRequest(1)],
    ...overrides,
  };
}

function hiddenGroup(overrides: Partial<NonNullable<Parameters<typeof soloGroupView>[1]>> = {}) {
  return {
    id: ThreadGroupId.make("group"),
    branch: null,
    worktreePath: null,
    pullRequest: null,
    links: [{ id: "link:1", url: "https://linear.app/t3/issue/T3-1", label: "T3-1" }],
    ...overrides,
  };
}

describe("soloGroupView", () => {
  it("reads the workspace from the chat when there is no hidden group", () => {
    expect(soloGroupView(thread(), null, { workspaceRoot: ROOT })).toEqual({
      id: null,
      environmentId: EnvironmentId.make("env"),
      projectId: ProjectId.make("project"),
      branch: "feat/solo",
      worktreePath: "/worktrees/solo",
      pullRequest: pullRequest(1),
      links: [],
      threadIds: [ThreadId.make("chat")],
      worktreeGroupId: null,
    });
  });

  it("names the hidden group as the worktree's owner only when the worktree is its own", () => {
    // The chat's own worktree: the hidden group cannot recreate it.
    expect(soloGroupView(thread(), hiddenGroup(), { workspaceRoot: ROOT }).worktreeGroupId).toBe(
      null,
    );
    expect(
      soloGroupView(thread(), hiddenGroup({ worktreePath: "/worktrees/group" }), {
        workspaceRoot: ROOT,
      }).worktreeGroupId,
    ).toBe(ThreadGroupId.make("group"));
  });

  it("takes tickets from the hidden group and keeps the chat's values where it has none", () => {
    const view = soloGroupView(thread(), hiddenGroup(), { workspaceRoot: ROOT });
    expect(view.id).toBe(ThreadGroupId.make("group"));
    expect(view.links).toEqual(hiddenGroup().links);
    expect(view.branch).toBe("feat/solo");
    expect(view.worktreePath).toBe("/worktrees/solo");
    expect(view.pullRequest).toEqual(pullRequest(1));
  });

  it("lets the hidden group's values win when set", () => {
    const view = soloGroupView(
      thread(),
      hiddenGroup({
        branch: "feat/group",
        worktreePath: "/worktrees/group",
        pullRequest: pullRequest(7),
      }),
      { workspaceRoot: ROOT },
    );
    expect(view.branch).toBe("feat/group");
    expect(view.worktreePath).toBe("/worktrees/group");
    expect(view.pullRequest).toEqual(pullRequest(7));
  });

  it("treats a chat on the project root as having no worktree of its own", () => {
    expect(
      soloGroupView(thread({ worktreePath: ROOT }), null, { workspaceRoot: ROOT }).worktreePath,
    ).toBeNull();
    expect(soloGroupView(thread({ worktreePath: null }), null, null).worktreePath).toBeNull();
    expect(
      soloGroupView(thread({ worktreePath: ROOT }), hiddenGroup({ worktreePath: ROOT }), {
        workspaceRoot: ROOT,
      }).worktreePath,
    ).toBeNull();
  });

  it("has no pull request when the chat has none", () => {
    expect(soloGroupView(thread({ pullRequests: [] }), null, null).pullRequest).toBeNull();
  });
});
