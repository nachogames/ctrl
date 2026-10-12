import { assert, describe, it } from "@effect/vitest";
import { CommandId, EventId, ProjectId, ThreadGroupId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import {
  defaultThreadGroupTitle,
  humanizeBranchName,
  planThreadGroupCommand,
  type ThreadGroupCommand,
} from "./ThreadGroupCommands.ts";
import type { ThreadGroupRow } from "./ThreadGroupStore.ts";

const now = DateTime.makeUnsafe("2026-10-10T05:00:00.000Z");
const groupId = ThreadGroupId.make("group:planner");
const projectId = ProjectId.make("project:planner");
const commandId = CommandId.make("command:planner");

const row = (overrides: Partial<ThreadGroupRow> = {}): ThreadGroupRow => ({
  groupId,
  projectId,
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
  links: [],
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

const plan = (command: ThreadGroupCommand, group?: ThreadGroupRow) =>
  planThreadGroupCommand({
    command,
    state: { group },
    eventId: EventId.make("event:planned"),
    now,
  });

const failureTag = (result: ReturnType<typeof plan>) =>
  Result.isFailure(result) ? result.failure._tag : assert.fail("expected a rejection");

describe("thread group titles", () => {
  it("humanizes the last branch segment", () => {
    assert.equal(humanizeBranchName("feat/auth-refactor"), "Auth refactor");
    assert.equal(humanizeBranchName("fix/ws_reconnect"), "Ws reconnect");
    assert.equal(humanizeBranchName("main"), "Main");
  });

  it("prefers the chat title, then the branch, then a placeholder", () => {
    assert.equal(defaultThreadGroupTitle({ branch: "feat/x", fallback: "  Chat  " }), "Chat");
    assert.equal(defaultThreadGroupTitle({ branch: "feat/x-y", fallback: "  " }), "X y");
    assert.equal(defaultThreadGroupTitle({ branch: null, fallback: "  " }), "Untitled group");
  });
});

describe("planThreadGroupCommand", () => {
  const create: ThreadGroupCommand = {
    type: "thread-group.create",
    commandId,
    groupId,
    projectId,
    title: "Auth refactor",
    goal: null,
    branch: "feat/auth-refactor",
    worktreePath: "/repo-worktrees/auth",
    pullRequest: null,
  };

  it("creates a group stamped with the command time", () => {
    const result = plan(create);
    assert.isTrue(Result.isSuccess(result));
    const event = Result.getOrThrow(result);
    assert.equal(event.type, "thread-group.created");
    assert.equal(event.aggregateKind, "thread-group");
    assert.deepInclude(event.payload, {
      groupId,
      createdAt: "2026-10-10T05:00:00.000Z",
      updatedAt: "2026-10-10T05:00:00.000Z",
    });
  });

  it("refuses to create a group id that was ever used", () => {
    assert.equal(
      failureTag(plan(create, row({ deletedAt: "2026-10-10T01:00:00.000Z" }))),
      "ThreadGroupCommandInvariantError",
    );
  });

  it("carries only the patch keys in a meta update", () => {
    const event = Result.getOrThrow(
      plan({ type: "thread-group.meta.update", commandId, groupId, patch: { goal: null } }, row()),
    );
    assert.deepEqual(event.payload, { groupId, goal: null, updatedAt: "2026-10-10T05:00:00.000Z" });
  });

  it("rejects an empty patch and duplicate resource or link ids", () => {
    assert.equal(
      failureTag(plan({ type: "thread-group.meta.update", commandId, groupId, patch: {} }, row())),
      "ThreadGroupCommandInvariantError",
    );
    const resource = { id: "api", name: "API", url: null, kind: "server" as const };
    assert.equal(
      failureTag(
        plan(
          {
            type: "thread-group.meta.update",
            commandId,
            groupId,
            patch: { manualResources: [resource, { ...resource, name: "Other" }] },
          },
          row(),
        ),
      ),
      "ThreadGroupCommandInvariantError",
    );
    const link = { id: "link:1", url: "https://linear.app/acme/issue/ENG-1", label: "ENG-1" };
    assert.equal(
      failureTag(
        plan(
          {
            type: "thread-group.meta.update",
            commandId,
            groupId,
            patch: { links: [link, { ...link, label: "Other" }] },
          },
          row(),
        ),
      ),
      "ThreadGroupCommandInvariantError",
    );
  });

  it("treats a deleted group as missing for updates and deletes", () => {
    const deleted = row({ deletedAt: "2026-10-10T01:00:00.000Z" });
    assert.equal(
      failureTag(
        plan(
          { type: "thread-group.meta.update", commandId, groupId, patch: { title: "X" } },
          deleted,
        ),
      ),
      "ThreadGroupCommandMissingGroupError",
    );
    assert.equal(
      failureTag(plan({ type: "thread-group.delete", commandId, groupId }, deleted)),
      "ThreadGroupCommandMissingGroupError",
    );
    assert.equal(
      Result.getOrThrow(plan({ type: "thread-group.delete", commandId, groupId }, row())).type,
      "thread-group.deleted",
    );
  });
});
