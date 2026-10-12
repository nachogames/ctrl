import { EnvironmentId, ProjectId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { orderThreadGroupMembers, presentThreadGroup, presentThreadShell } from "./models.ts";
import { v2ThreadGroup, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

const environmentId = EnvironmentId.make("environment-v2");

const member = (id: string, createdAt: string, overrides: Partial<typeof v2ThreadShell> = {}) => ({
  ...v2ThreadShell,
  id: ThreadId.make(id),
  createdAt: DateTime.makeUnsafe(createdAt),
  groupId: v2ThreadGroup.id,
  ...overrides,
});

describe("thread group presentation", () => {
  it("copies membership and handoff links onto the presented thread", () => {
    const shell = presentThreadShell(
      environmentId,
      member("thread-b", "2026-06-20T01:00:00.000Z", {
        handedOffFrom: ThreadId.make("thread-a"),
      }),
    );
    expect([shell.groupId, shell.handedOffFrom, shell.handedOffTo]).toEqual([
      v2ThreadGroup.id,
      "thread-a",
      null,
    ]);
    expect(presentThreadShell(environmentId, v2ThreadShell).groupId).toBeNull();
  });

  it("orders an unordered group newest first, a successor directly above its source", () => {
    const a = member("a", "2026-06-20T01:00:00.000Z");
    const c = member("c", "2026-06-20T02:00:00.000Z");
    const b = member("b", "2026-06-20T03:00:00.000Z", { handedOffFrom: a.id });
    const d = member("d", "2026-06-20T04:00:00.000Z", { handedOffFrom: b.id });
    const e = member("e", "2026-06-20T03:30:00.000Z");
    expect(orderThreadGroupMembers([d, c, b, a, e])).toEqual(["d", "b", "a", "e", "c"]);
  });

  it("lists keyed members after keyless ones", () => {
    const keyed = member("keyed", "2026-06-20T09:00:00.000Z", { groupOrderKey: "a" });
    const other = member("other", "2026-06-20T08:00:00.000Z", { groupOrderKey: "b" });
    const old = member("old", "2026-06-20T01:00:00.000Z");
    expect(orderThreadGroupMembers([other, keyed, old])).toEqual(["old", "keyed", "other"]);
  });

  it("keeps every member when handoff links loop or leave the group", () => {
    const x = member("x", "2026-06-20T01:00:00.000Z", { handedOffFrom: ThreadId.make("y") });
    const y = member("y", "2026-06-20T02:00:00.000Z", { handedOffFrom: ThreadId.make("x") });
    const z = member("z", "2026-06-20T03:00:00.000Z", { handedOffFrom: ThreadId.make("outside") });
    expect([...orderThreadGroupMembers([x, y, z])].toSorted()).toEqual(["x", "y", "z"]);
  });

  it("shows a group only from two members", () => {
    const one = member("one", "2026-06-20T01:00:00.000Z");
    const two = member("two", "2026-06-20T02:00:00.000Z");
    expect(presentThreadGroup(environmentId, v2ThreadGroup, [one]).visible).toBe(false);
    expect(presentThreadGroup(environmentId, v2ThreadGroup, [one, two]).visible).toBe(true);
  });

  it("presents only live threads of the group's project", () => {
    const kept = member("kept", "2026-06-20T01:00:00.000Z");
    const otherGroup = member("other-group", "2026-06-20T02:00:00.000Z", { groupId: null });
    const otherProject = member("other-project", "2026-06-20T03:00:00.000Z", {
      projectId: ProjectId.make("project-elsewhere"),
    });
    const deleted = member("deleted", "2026-06-20T04:00:00.000Z", {
      deletedAt: DateTime.makeUnsafe("2026-06-20T05:00:00.000Z"),
    });
    const group = presentThreadGroup(environmentId, v2ThreadGroup, [
      kept,
      otherGroup,
      otherProject,
      deleted,
    ]);
    expect(group.threadIds).toEqual(["kept"]);
    expect(group.environmentId).toBe(environmentId);
    expect(group.source).toBe(v2ThreadGroup);
  });

  it("leaves subagent threads out of the group", () => {
    const parent = member("parent", "2026-06-20T01:00:00.000Z");
    const subagent = member("parent:subagent", "2026-06-20T02:00:00.000Z", {
      lineage: {
        parentThreadId: parent.id,
        relationshipToParent: "subagent",
        rootThreadId: parent.id,
      },
    });
    const group = presentThreadGroup(environmentId, v2ThreadGroup, [parent, subagent]);
    expect(group.threadIds).toEqual(["parent"]);
  });

  it("falls back to the newest pull request a member linked when the group has none", () => {
    const link = (number: number, linkedAt: string): ThreadPullRequestLink => ({
      host: "github.com",
      repository: "t3tools/t3code",
      number,
      url: `https://github.com/t3tools/t3code/pull/${number}`,
      source: "manual",
      linkedAt,
      snapshot: null,
      stack: null,
    });
    const older = member("older", "2026-06-20T01:00:00.000Z", {
      pullRequests: [link(1, "2026-06-20T02:00:00.000Z")],
    });
    const newer = member("newer", "2026-06-20T02:00:00.000Z", {
      pullRequests: [link(2, "2026-06-20T03:00:00.000Z")],
    });
    const bare = member("bare", "2026-06-20T03:00:00.000Z");
    const groupWithout = { ...v2ThreadGroup, pullRequest: null };
    expect(
      presentThreadGroup(environmentId, groupWithout, [older, newer, bare]).pullRequest?.number,
    ).toBe(2);
    expect(presentThreadGroup(environmentId, groupWithout, [bare]).pullRequest).toBeNull();
    // A pull request stored on the group wins.
    const stored = link(9, "2026-06-20T00:00:00.000Z");
    const groupWith = { ...v2ThreadGroup, pullRequest: stored };
    expect(presentThreadGroup(environmentId, groupWith, [older, newer]).pullRequest).toBe(stored);
  });
});
