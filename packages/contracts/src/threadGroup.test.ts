import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ScopedThreadGroupRef } from "./environment.ts";
import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2Command,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadLaunchInput,
} from "./orchestrationV2.ts";
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

const decodeAppThreadJson = Schema.decodeUnknownSync(OrchestrationV2AppThreadJson);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeLaunchInput = Schema.decodeUnknownSync(OrchestrationV2ThreadLaunchInput);
const decodeShellSnapshot = Schema.decodeUnknownSync(OrchestrationV2ShellSnapshot);
const decodeShellStreamItem = Schema.decodeUnknownSync(OrchestrationV2ShellStreamItem);

const persistedThread = {
  createdBy: "user",
  creationSource: "web",
  id: "thread-1",
  projectId: "project-1",
  title: "Thread",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};

describe("thread group membership on threads", () => {
  it("decodes a thread persisted before groups with no membership", () => {
    const thread = decodeAppThreadJson(persistedThread);
    expect(thread.groupId).toBeUndefined();
    expect(thread.handedOffFrom).toBeUndefined();
    expect(thread.handedOffTo).toBeUndefined();
  });

  it("decodes membership and handoff links", () => {
    const thread = decodeAppThreadJson({
      ...persistedThread,
      groupId: "group-1",
      handedOffFrom: "thread-0",
      handedOffTo: null,
    });
    expect(thread.groupId).toBe("group-1");
    expect(thread.handedOffFrom).toBe("thread-0");
    expect(thread.handedOffTo).toBeNull();
  });

  it("clears a group with a null metadata update and keeps absent links absent", () => {
    const command = decodeCommand({
      type: "thread.metadata.update",
      commandId: "command-1",
      threadId: "thread-1",
      groupId: null,
    });
    expect(command).toMatchObject({ type: "thread.metadata.update", groupId: null });
    expect("handedOffFrom" in command).toBe(false);
  });

  it("launches a thread into a group", () => {
    const input = decodeLaunchInput({
      commandId: "command-2",
      projectId: "project-1",
      title: "New chat",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      groupId: "group-1",
    });
    expect(input.groupId).toBe("group-1");
  });

  it("decodes a shell snapshot from before groups", () => {
    const snapshot = decodeShellSnapshot({
      schemaVersion: 1,
      snapshotSequence: 4,
      projects: [],
      threads: [],
      archivedThreads: [],
    });
    expect(snapshot.groups).toBeUndefined();
  });

  it("decodes group shell deltas", () => {
    expect(
      decodeShellStreamItem({ kind: "thread-group.removed", sequence: 5, groupId: "group-1" }),
    ).toMatchObject({ kind: "thread-group.removed", groupId: "group-1" });
    expect(
      decodeShellStreamItem({ kind: "thread-group.updated", sequence: 6, group: shellInput }),
    ).toMatchObject({ kind: "thread-group.updated", group: { id: "group-1" } });
  });
});
