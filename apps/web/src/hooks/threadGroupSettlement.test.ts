import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { applyThreadGroupSettlement } from "./threadGroupSettlement";

const ok = () => AsyncResult.success(undefined);
const failed = () => AsyncResult.failure(Cause.fail(new Error("rejected")));

function harness(options: { failGroup?: boolean; failMember?: string } = {}) {
  const calls: string[] = [];
  return {
    calls,
    patchSettledAt: async (settledAt: string | null) => {
      calls.push(`group:${settledAt}`);
      return options.failGroup ? failed() : ok();
    },
    setMemberSettled: async (threadId: ThreadId, settled: boolean) => {
      calls.push(`${settled ? "settle" : "unsettle"}:${threadId}`);
      return threadId === options.failMember ? failed() : ok();
    },
  };
}

const members = [
  { id: ThreadId.make("a"), settledOverride: null },
  { id: ThreadId.make("b"), settledOverride: "settled" as const },
  { id: ThreadId.make("c"), settledOverride: "active" as const },
];

describe("applyThreadGroupSettlement", () => {
  it("settles the group first, then only the members that differ, and undoes both", async () => {
    const deps = harness();
    const outcome = await applyThreadGroupSettlement({
      settled: true,
      now: "NOW",
      previousSettledAt: null,
      members,
      settleMembers: true,
      ...deps,
    });
    expect(deps.calls).toEqual(["group:NOW", "settle:a", "settle:c"]);
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") return;
    expect(outcome.memberFailure).toBeNull();
    deps.calls.length = 0;
    expect((await outcome.undo())._tag).toBe("Success");
    // b was already settled before, so undo leaves it settled.
    expect(deps.calls).toEqual(["group:null", "unsettle:a", "unsettle:c"]);
  });

  it("un-settling restores the previous stamp and re-settles on undo", async () => {
    const deps = harness();
    const outcome = await applyThreadGroupSettlement({
      settled: false,
      now: "NOW",
      previousSettledAt: "BEFORE",
      members,
      settleMembers: true,
      ...deps,
    });
    expect(deps.calls).toEqual(["group:null", "unsettle:b"]);
    if (outcome.kind !== "applied") throw new Error("expected applied");
    deps.calls.length = 0;
    await outcome.undo();
    expect(deps.calls).toEqual(["group:BEFORE", "settle:b"]);
  });

  it("leaves the members alone when the group change fails", async () => {
    const deps = harness({ failGroup: true });
    const outcome = await applyThreadGroupSettlement({
      settled: true,
      now: "NOW",
      previousSettledAt: null,
      members,
      settleMembers: true,
      ...deps,
    });
    expect(outcome.kind).toBe("group-failed");
    expect(deps.calls).toEqual(["group:NOW"]);
  });

  it("reports a member that did not move and undoes only the ones that did", async () => {
    const deps = harness({ failMember: "a" });
    const outcome = await applyThreadGroupSettlement({
      settled: true,
      now: "NOW",
      previousSettledAt: null,
      members,
      settleMembers: true,
      ...deps,
    });
    if (outcome.kind !== "applied") throw new Error("expected applied");
    expect(outcome.memberFailure?._tag).toBe("Failure");
    deps.calls.length = 0;
    await outcome.undo();
    expect(deps.calls).toEqual(["group:null", "unsettle:c"]);
  });

  it("changes only the group where chats cannot be settled", async () => {
    const deps = harness();
    await applyThreadGroupSettlement({
      settled: true,
      now: "NOW",
      previousSettledAt: null,
      members,
      settleMembers: false,
      ...deps,
    });
    expect(deps.calls).toEqual(["group:NOW"]);
  });
});
