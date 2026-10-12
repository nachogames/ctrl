import { CommandId, ThreadGroupId, ThreadGroupMutationError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildMoveToGroupMenuItems,
  groupWithTarget,
  workspacesDiffer,
  isThreadGroupWorkspaceMismatch,
  moveWithWorkspaceConfirm,
  parseMoveToGroupTarget,
  workspaceMismatchConfirmMessage,
} from "./moveToGroupMenu.logic";

const auth = ThreadGroupId.make("group-auth");
const docs = ThreadGroupId.make("group-docs");
const solo = ThreadGroupId.make("group-solo");
const groups = [
  { id: docs, title: "Docs", activityMs: 100, visible: true },
  { id: auth, title: "Auth refactor", activityMs: 200, visible: true },
  { id: solo, title: "Solo", activityMs: 300, visible: false },
];

const mutationError = (reason?: "workspace-mismatch" | "thread-busy") =>
  new ThreadGroupMutationError({
    commandId: CommandId.make("command-1"),
    message: "refused",
    ...(reason === undefined ? {} : { reason }),
  });

type Result = { readonly _tag: "Success" } | { readonly _tag: "Failure"; readonly error: unknown };
const success: Result = { _tag: "Success" };
const failure = (error: unknown): Result => ({ _tag: "Failure", error });

function runMove(results: ReadonlyArray<Result>, confirmed: boolean) {
  const calls: boolean[] = [];
  let confirms = 0;
  const outcome = moveWithWorkspaceConfirm({
    move: async (adopt) => {
      calls.push(adopt);
      return results[calls.length - 1]!;
    },
    failureOf: (result) => (result._tag === "Failure" ? result.error : null),
    confirm: async () => {
      confirms += 1;
      return confirmed;
    },
  });
  return { outcome, calls, confirms: () => confirms };
}

describe("move to group menu", () => {
  it("lists the project's visible groups by activity, the current one checked", () => {
    const [move, remove] = buildMoveToGroupMenuItems({ groups, currentGroupId: docs });
    expect(move?.children).toEqual([
      { id: "move-to-group:group-auth", label: "Auth refactor" },
      { id: "move-to-group:group-docs", label: "Docs", checked: true, disabled: true },
    ]);
    expect(remove).toEqual({ id: "remove-from-group", label: "Remove from group" });
  });

  it("offers no new group and no removal to a chat in a hidden group", () => {
    const items = buildMoveToGroupMenuItems({ groups, currentGroupId: solo });
    expect(items.map((item) => item.id)).toEqual(["move-to-group"]);
    expect(items[0]?.children?.map((item) => item.id)).toEqual([
      "move-to-group:group-auth",
      "move-to-group:group-docs",
    ]);
  });

  it("offers nothing to a chat in a project without visible groups", () => {
    expect(buildMoveToGroupMenuItems({ groups: [groups[2]!], currentGroupId: solo })).toEqual([]);
    expect(buildMoveToGroupMenuItems({ groups: [], currentGroupId: null })).toEqual([]);
  });

  it("reads the target group back from the action id", () => {
    expect(parseMoveToGroupTarget("move-to-group:group-auth")).toBe("group-auth");
    expect(parseMoveToGroupTarget("move-to-group")).toBeNull();
  });

  it("recognises a workspace mismatch by its reason, not its message", () => {
    expect(isThreadGroupWorkspaceMismatch(mutationError("workspace-mismatch"))).toBe(true);
    expect(isThreadGroupWorkspaceMismatch(mutationError("thread-busy"))).toBe(false);
    expect(isThreadGroupWorkspaceMismatch(mutationError())).toBe(false);
    expect(isThreadGroupWorkspaceMismatch(new Error("workspace-mismatch"))).toBe(false);
  });

  it("names the chat, the group's branch and where the chat will continue", () => {
    expect(
      workspaceMismatchConfirmMessage({
        chatTitle: "Fix login",
        group: { title: "Auth refactor", branch: "feat/auth", worktreePath: "/wt/auth" },
      }),
    ).toBe(
      "Move “Fix login” into “Auth refactor”?\nIt will switch to the group's workspace (feat/auth) and continue in /wt/auth.",
    );
    expect(
      workspaceMismatchConfirmMessage({
        chatTitle: "Fix login",
        group: { title: "Docs", branch: null, worktreePath: null },
      }),
    ).toBe(
      "Move “Fix login” into “Docs”?\nIt will switch to the group's workspace and continue in the project's main checkout.",
    );
  });
});

describe("moving with a workspace confirm", () => {
  it("moves without asking when the workspaces already match", async () => {
    const run = runMove([success], true);
    expect(await run.outcome).toEqual({ kind: "moved" });
    expect(run.calls).toEqual([false]);
    expect(run.confirms()).toBe(0);
  });

  it("asks on a mismatch and retries adopting the group's workspace", async () => {
    const run = runMove([failure(mutationError("workspace-mismatch")), success], true);
    expect(await run.outcome).toEqual({ kind: "moved" });
    expect(run.calls).toEqual([false, true]);
    expect(run.confirms()).toBe(1);
  });

  it("leaves the chat where it was when the user declines", async () => {
    const run = runMove([failure(mutationError("workspace-mismatch"))], false);
    expect(await run.outcome).toEqual({ kind: "cancelled" });
    expect(run.calls).toEqual([false]);
  });

  it("reports other failures without asking", async () => {
    const busy = failure(mutationError("thread-busy"));
    const run = runMove([busy], true);
    expect(await run.outcome).toEqual({ kind: "failed", result: busy });
    expect(run.confirms()).toBe(0);
  });

  it("reports a failed retry", async () => {
    const dirty = failure(mutationError());
    const run = runMove([failure(mutationError("workspace-mismatch")), dirty], true);
    expect(await run.outcome).toEqual({ kind: "failed", result: dirty });
  });
});

describe("grouping with a dropped-on chat", () => {
  function run(input: { needsWorkspaceSwitch: boolean; confirmed?: boolean; moves?: boolean }) {
    const calls: string[] = [];
    const outcome = groupWithTarget({
      needsWorkspaceSwitch: input.needsWorkspaceSwitch,
      confirm: async () => {
        calls.push("confirm");
        return input.confirmed ?? true;
      },
      create: async () => {
        calls.push("create");
        return "group-new";
      },
      move: async (group, adopt) => {
        calls.push(`move:${group}:${adopt}`);
        return input.moves ?? true;
      },
      deleteGroup: async (group) => {
        calls.push(`delete:${group}`);
        return true;
      },
    });
    return { outcome, calls };
  }

  it("creates nothing when the user declines the workspace switch", async () => {
    const { outcome, calls } = run({ needsWorkspaceSwitch: true, confirmed: false });
    expect(await outcome).toEqual({ kind: "cancelled" });
    expect(calls).toEqual(["confirm"]);
  });

  it("asks first, then groups and adopts the target's workspace", async () => {
    const { outcome, calls } = run({ needsWorkspaceSwitch: true });
    expect(await outcome).toEqual({ kind: "grouped", group: "group-new" });
    expect(calls).toEqual(["confirm", "create", "move:group-new:true"]);
  });

  it("groups without asking when the workspaces match", async () => {
    const { outcome, calls } = run({ needsWorkspaceSwitch: false });
    expect(await outcome).toEqual({ kind: "grouped", group: "group-new" });
    expect(calls).toEqual(["create", "move:group-new:false"]);
  });

  it("deletes the new group again when the move fails", async () => {
    const { outcome, calls } = run({ needsWorkspaceSwitch: false, moves: false });
    expect(await outcome).toEqual({ kind: "move-failed", cleanedUp: true });
    expect(calls).toEqual(["create", "move:group-new:false", "delete:group-new"]);
  });

  it("does not move when the group could not be created", async () => {
    const calls: string[] = [];
    const outcome = await groupWithTarget({
      needsWorkspaceSwitch: false,
      confirm: async () => true,
      create: async () => null,
      move: async () => {
        calls.push("move");
        return true;
      },
      deleteGroup: async () => true,
    });
    expect(outcome).toEqual({ kind: "create-failed" });
    expect(calls).toEqual([]);
  });

  it("treats a different branch or worktree as a different workspace", () => {
    const at = (branch: string | null, worktreePath: string | null) => ({ branch, worktreePath });
    expect(workspacesDiffer(at("main", null), at("main", null))).toBe(false);
    expect(workspacesDiffer(at("main", null), at("feat/x", null))).toBe(true);
    expect(workspacesDiffer(at("feat/x", "/wt/a"), at("feat/x", "/wt/b"))).toBe(true);
  });
});
