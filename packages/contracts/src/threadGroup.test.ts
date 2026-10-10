import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ScopedThreadGroupRef } from "./environment.ts";
import {
  OrchestrationThreadGroupShell,
  ThreadGroupMutation,
  ThreadGroupUpdatePayload,
} from "./threadGroup.ts";

const decodeShell = Schema.decodeUnknownSync(OrchestrationThreadGroupShell);
const decodeMutation = Schema.decodeUnknownSync(ThreadGroupMutation);
const decodePatch = Schema.decodeUnknownSync(ThreadGroupUpdatePayload);
const at = "2026-10-10T00:00:00.000Z";

const shellInput = {
  id: "group-1",
  projectId: "project-1",
  title: "Auth refactor",
  goal: null,
  branch: "feat/auth-refactor",
  worktreePath: "/repo-worktrees/auth",
  pullRequest: null,
  lastHandoff: null,
  pinnedAt: null,
  snoozedUntil: null,
  settledAt: null,
  manualResources: [],
  createdAt: at,
  updatedAt: at,
};

describe("thread group contracts", () => {
  it("decodes a group shell with a registered resource and a handoff", () => {
    const shell = decodeShell({
      ...shellInput,
      lastHandoff: {
        summary: "Tests pass; wire the sidebar next.",
        fromThreadId: "thread-1",
        toThreadId: "thread-2",
        at,
      },
      manualResources: [
        { id: "api", name: "Staging API", url: "https://staging.example.test", kind: "server" },
      ],
    });
    expect(shell.lastHandoff?.toThreadId).toBe("thread-2");
    expect(shell.manualResources[0]?.kind).toBe("server");
  });

  it("rejects a resource kind outside server, container and other", () => {
    expect(() =>
      decodeShell({
        ...shellInput,
        manualResources: [{ id: "db", name: "Database", url: null, kind: "database" }],
      }),
    ).toThrow();
  });

  it("keeps absent and null apart in an update patch", () => {
    expect(decodePatch({})).toEqual({});
    expect(decodePatch({ goal: null })).toEqual({ goal: null });
    expect("goal" in decodePatch({ title: "Renamed" })).toBe(false);
  });

  it("requires at least one thread to create a group", () => {
    const create = {
      type: "thread-group.create",
      commandId: "command-1",
      groupId: "group-1",
      projectId: "project-1",
    };
    expect(() => decodeMutation({ ...create, threadIds: [] })).toThrow();
    expect(decodeMutation({ ...create, threadIds: ["thread-1"] }).type).toBe("thread-group.create");
  });

  it("scopes a group reference to its environment", () => {
    expect(
      Schema.decodeUnknownSync(ScopedThreadGroupRef)({
        environmentId: "environment-work",
        groupId: "group-1",
      }),
    ).toEqual({ environmentId: "environment-work", groupId: "group-1" });
    expect(() => Schema.decodeUnknownSync(ScopedThreadGroupRef)({ groupId: "group-1" })).toThrow();
  });

  it("detaches a thread by moving it to a null group", () => {
    expect(
      decodeMutation({
        type: "thread-group.move-thread",
        commandId: "command-2",
        threadId: "thread-1",
        groupId: null,
      }),
    ).toMatchObject({ type: "thread-group.move-thread", groupId: null });
  });
});
