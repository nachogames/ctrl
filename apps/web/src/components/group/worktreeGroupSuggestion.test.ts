import { EnvironmentId, ProjectId, ThreadGroupId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { worktreeGroupSuggestion } from "./worktreeGroupSuggestion";

const ROOT = "/repo";
const WORKTREE = "/worktrees/auth";
const visibleGroup = ThreadGroupId.make("visible");
const hiddenGroup = ThreadGroupId.make("hidden");
const groupsById = new Map([
  [visibleGroup, { visible: true }],
  [hiddenGroup, { visible: false }],
]);

type Chat = Parameters<typeof worktreeGroupSuggestion>[1][number];

function chat(id: string, overrides: Partial<Chat> = {}): Chat {
  return {
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make("env"),
    projectId: ProjectId.make("project"),
    worktreePath: WORKTREE,
    archivedAt: null,
    deletedAt: null,
    groupId: null,
    lineage: { relationshipToParent: null },
    ...overrides,
  };
}

function suggest(current: Chat, others: ReadonlyArray<Chat>, projectRoot: string | null = ROOT) {
  return worktreeGroupSuggestion(current, [current, ...others], groupsById, projectRoot);
}

describe("worktreeGroupSuggestion", () => {
  it("lists the other chats on the same worktree", () => {
    expect(suggest(chat("current"), [chat("a"), chat("b")])).toEqual([
      ThreadId.make("a"),
      ThreadId.make("b"),
    ]);
  });

  it("suggests nothing for a chat on the project root or without a worktree", () => {
    expect(
      suggest(chat("current", { worktreePath: ROOT }), [chat("a", { worktreePath: ROOT })]),
    ).toEqual([]);
    expect(
      suggest(chat("current", { worktreePath: null }), [chat("a", { worktreePath: null })]),
    ).toEqual([]);
  });

  it("skips chats on another worktree, in another project, or on another environment", () => {
    expect(
      suggest(chat("current"), [
        chat("other-worktree", { worktreePath: "/worktrees/billing" }),
        chat("other-project", { projectId: ProjectId.make("elsewhere") }),
        chat("other-environment", { environmentId: EnvironmentId.make("remote") }),
      ]),
    ).toEqual([]);
  });

  it("excludes members of a visible group and includes members of a hidden one", () => {
    expect(
      suggest(chat("current"), [
        chat("grouped", { groupId: visibleGroup }),
        chat("alone", { groupId: hiddenGroup }),
      ]),
    ).toEqual([ThreadId.make("alone")]);
  });

  it("excludes archived, deleted and subagent chats", () => {
    expect(
      suggest(chat("current"), [
        chat("archived", { archivedAt: "2026-10-12T00:00:00.000Z" }),
        chat("deleted", { deletedAt: "2026-10-12T00:00:00.000Z" }),
        chat("subagent", { lineage: { relationshipToParent: "subagent" } }),
      ]),
    ).toEqual([]);
  });
});
