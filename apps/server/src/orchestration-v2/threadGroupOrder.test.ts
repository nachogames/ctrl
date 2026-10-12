import { assert, describe, it } from "@effect/vitest";
import { orderGroupMembers } from "@t3tools/shared/groupOrder";

import { planGroupInsertAbove, planGroupJoinKey } from "./threadGroupOrder.ts";

const member = (
  id: string,
  createdAtMs: number,
  overrides: { handedOffFrom?: string | null; groupOrderKey?: string | null } = {},
) => ({ id, createdAtMs, handedOffFrom: null, groupOrderKey: null, ...overrides });

/** The members after applying a plan, in display order. */
const applied = (
  members: ReadonlyArray<ReturnType<typeof member>>,
  plan: ReadonlyArray<{ readonly threadId: string; readonly key: string }>,
) => {
  const keys = new Map(plan.map((entry) => [entry.threadId, entry.key]));
  return orderGroupMembers(
    members.map((item) =>
      keys.has(item.id) ? { ...item, groupOrderKey: keys.get(item.id) ?? null } : item,
    ),
  );
};

describe("planGroupJoinKey", () => {
  it("leaves a joiner of an unordered group keyless", () => {
    assert.isNull(planGroupJoinKey([member("a", 1), member("b", 2)]));
  });

  it("puts a joiner of a keyed group before its first key", () => {
    const members = [
      member("a", 1, { groupOrderKey: "m" }),
      member("b", 2, { groupOrderKey: "f" }),
    ];
    const key = planGroupJoinKey(members);
    assert.isNotNull(key);
    assert.deepEqual(applied([...members, member("new", 3)], [{ threadId: "new", key: key! }]), [
      "new",
      "b",
      "a",
    ]);
  });

  it("returns null instead of throwing on a corrupt key", () => {
    assert.isNull(planGroupJoinKey([member("a", 1, { groupOrderKey: "A!" })]));
  });
});

describe("planGroupInsertAbove", () => {
  it("writes nothing in an unordered group", () => {
    const members = [member("a", 1), member("new", 2, { handedOffFrom: "a" })];
    assert.deepEqual(planGroupInsertAbove(members, "a", "new"), []);
  });

  it("keys the successor between the source and the chat above it", () => {
    const members = [
      member("a", 1, { groupOrderKey: "d" }),
      member("b", 2, { groupOrderKey: "m" }),
      member("c", 3, { groupOrderKey: "t" }),
      member("new", 4, { handedOffFrom: "b" }),
    ];
    const plan = planGroupInsertAbove(members, "b", "new");
    assert.equal(plan.length, 1);
    assert.equal(plan[0]?.threadId, "new");
    assert.deepEqual(applied(members, plan), ["a", "new", "b", "c"]);
  });

  it("keys the successor above a source that is first", () => {
    const members = [
      member("a", 1, { groupOrderKey: "d" }),
      member("b", 2, { groupOrderKey: "m" }),
      member("new", 3, { handedOffFrom: "a" }),
    ];
    const plan = planGroupInsertAbove(members, "a", "new");
    assert.equal(plan.length, 1);
    assert.deepEqual(applied(members, plan), ["new", "a", "b"]);
  });

  it("materializes keys when the source is keyless but others are keyed", () => {
    const members = [
      member("a", 1, { groupOrderKey: "m" }),
      member("b", 2),
      member("c", 3),
      member("new", 4, { handedOffFrom: "b" }),
    ];
    const plan = planGroupInsertAbove(members, "b", "new");
    assert.sameMembers(
      plan.map((entry) => entry.threadId),
      ["a", "b", "c", "new"],
    );
    assert.deepEqual(applied(members, plan), ["new", "b", "c", "a"]);
  });

  it("materializes instead of throwing when keys are corrupt", () => {
    const members = [
      member("a", 1, { groupOrderKey: "Z!" }),
      member("b", 2, { groupOrderKey: "zz" }),
      member("new", 3, { handedOffFrom: "b" }),
    ];
    const plan = planGroupInsertAbove(members, "b", "new");
    assert.deepEqual(applied(members, plan), ["a", "new", "b"]);
  });

  it("writes nothing for a successor that already has a key", () => {
    const members = [
      member("a", 1, { groupOrderKey: "m" }),
      member("new", 2, { handedOffFrom: "a", groupOrderKey: "f" }),
    ];
    assert.deepEqual(planGroupInsertAbove(members, "a", "new"), []);
  });
});
