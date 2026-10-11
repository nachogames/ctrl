import { CommandId, ThreadGroupId, ThreadGroupMutationError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildMoveToGroupMenuItems,
  isThreadGroupWorkspaceMismatch,
  moveWithWorkspaceConfirm,
  parseMoveToGroupTarget,
  workspaceMismatchConfirmMessage,
} from "./moveToGroupMenu.logic";

const auth = ThreadGroupId.make("group-auth");
const docs = ThreadGroupId.make("group-docs");
const groups = [
  { id: docs, title: "Docs", activityMs: 100 },
  { id: auth, title: "Auth refactor", activityMs: 200 },
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
  it("lists the project's groups by activity, the current one checked, then a new group", () => {
    const [move, remove] = buildMoveToGroupMenuItems({ groups, currentGroupId: docs });
    expect(move?.children).toEqual([
      { id: "move-to-group:group-auth", label: "Auth refactor" },
      { id: "move-to-group:group-docs", label: "Docs", checked: true, disabled: true },
      { id: "move-to-new-group", label: "New group with this chat", separatorBefore: true },
    ]);
    expect(remove).toEqual({ id: "remove-from-group", label: "Remove from group" });
  });

  it("offers only a new group, and no removal, to an ungrouped chat in a project without groups", () => {
    const items = buildMoveToGroupMenuItems({ groups: [], currentGroupId: null });
    expect(items).toHaveLength(1);
    expect(items[0]?.children).toEqual([
      { id: "move-to-new-group", label: "New group with this chat" },
    ]);
  });

  it("reads the target group back from the action id", () => {
    expect(parseMoveToGroupTarget("move-to-group:group-auth")).toBe("group-auth");
    expect(parseMoveToGroupTarget("move-to-group")).toBeNull();
    expect(parseMoveToGroupTarget("move-to-new-group")).toBeNull();
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
      "Move “Fix login” to Auth refactor's workspace (feat/auth)? The chat will continue in /wt/auth.",
    );
    expect(
      workspaceMismatchConfirmMessage({
        chatTitle: "Fix login",
        group: { title: "Docs", branch: null, worktreePath: null },
      }),
    ).toBe(
      "Move “Fix login” to Docs's workspace? The chat will continue in the project's main checkout.",
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
