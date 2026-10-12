import type { EnvironmentId, ProjectId, ThreadGroupId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { liveDraftGroup, resolveDraftLaunchWorkspace } from "./draftGroupLaunch";

const projectId = "project-1" as ProjectId;
const groupId = "group-1" as ThreadGroupId;
const draft = {
  environmentId: "environment-1" as EnvironmentId,
  projectId,
  groupId,
  branch: "feature/drifted",
  worktreePath: "/worktrees/drifted",
};
const group = {
  id: groupId,
  projectId,
  branch: "feature/group",
  worktreePath: "/worktrees/group",
};

describe("liveDraftGroup", () => {
  it("keeps a draft's group only while it exists in the draft's project", () => {
    expect(liveDraftGroup(draft, group)).toBe(group);
    expect(liveDraftGroup(draft, null)).toBeNull();
    expect(liveDraftGroup(draft, { ...group, projectId: "project-2" as ProjectId })).toBeNull();
    expect(liveDraftGroup({ ...draft, groupId: undefined }, group)).toBeNull();
  });
});

describe("resolveDraftLaunchWorkspace", () => {
  it("launches a grouped draft into the group's workspace", () => {
    expect(resolveDraftLaunchWorkspace({ draft, group })).toEqual({
      branch: "feature/group",
      worktreePath: "/worktrees/group",
      groupId,
    });
    expect(resolveDraftLaunchWorkspace({ draft, group: { ...group, worktreePath: null } })).toEqual(
      { branch: "feature/group", worktreePath: null, groupId },
    );
  });

  it("launches a draft whose group has gone in its own workspace, ungrouped", () => {
    expect(resolveDraftLaunchWorkspace({ draft, group: liveDraftGroup(draft, null) })).toEqual({
      branch: "feature/drifted",
      worktreePath: "/worktrees/drifted",
    });
  });
});
