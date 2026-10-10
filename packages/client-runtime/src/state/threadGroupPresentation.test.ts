import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
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

  it("orders each handoff chain before later unrelated chats", () => {
    const a = member("a", "2026-06-20T01:00:00.000Z");
    const c = member("c", "2026-06-20T02:00:00.000Z");
    const b = member("b", "2026-06-20T03:00:00.000Z", { handedOffFrom: a.id });
    const d = member("d", "2026-06-20T04:00:00.000Z", { handedOffFrom: b.id });
    expect(orderThreadGroupMembers([d, c, b, a])).toEqual(["a", "b", "d", "c"]);
  });

  it("keeps every member when handoff links loop or leave the group", () => {
    const x = member("x", "2026-06-20T01:00:00.000Z", { handedOffFrom: ThreadId.make("y") });
    const y = member("y", "2026-06-20T02:00:00.000Z", { handedOffFrom: ThreadId.make("x") });
    const z = member("z", "2026-06-20T03:00:00.000Z", { handedOffFrom: ThreadId.make("outside") });
    expect(orderThreadGroupMembers([x, y, z])).toEqual(["z", "x", "y"]);
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
});
