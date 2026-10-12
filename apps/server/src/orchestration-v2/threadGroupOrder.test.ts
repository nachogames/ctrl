import { assert, describe, it } from "@effect/vitest";
import { orderGroupMembers } from "@t3tools/shared/groupOrder";

import { planGroupInsertAbove, planGroupJoin } from "./threadGroupOrder.ts";

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

describe("planGroupJoin", () => {
  it("writes nothing for the newest chat joining an unordered group", () => {
    const members = [member("a", 1), member("b", 2)];
    assert.deepEqual(planGroupJoin(members, member("new", 3)), []);
  });

  it("puts an older chat joining an unordered group first", () => {
    const members = [member("a", 2), member("b", 3)];
    const joiner = member("old", 1);
    const plan = planGroupJoin(members, joiner);
    assert.equal(plan.at(-1)?.threadId, "old");
    assert.deepEqual(applied([...members, joiner], plan), ["old", "b", "a"]);
  });

  it("puts a joiner of a partly keyed group above its keyless chats", () => {
    const members = [member("a", 1, { groupOrderKey: "m" }), member("b", 3)];
    const joiner = member("old", 2);
    const plan = planGroupJoin(members, joiner);
    assert.deepEqual(applied([...members, joiner], plan), ["old", "b", "a"]);
  });

  it("gives a joiner of a fully keyed group one key before the first", () => {
    const members = [
      member("a", 1, { groupOrderKey: "m" }),
      member("b", 2, { groupOrderKey: "f" }),
    ];
    const joiner = member("new", 3);
    const plan = planGroupJoin(members, joiner);
    assert.equal(plan.length, 1);
    assert.deepEqual(applied([...members, joiner], plan), ["new", "b", "a"]);
  });

  it("materializes instead of throwing on a corrupt first key", () => {
    const members = [
      member("a", 1, { groupOrderKey: "A!" }),
      member("b", 2, { groupOrderKey: "m" }),
    ];
    const joiner = member("new", 3);
    assert.deepEqual(applied([...members, joiner], planGroupJoin(members, joiner)), [
      "new",
      "a",
      "b",
    ]);
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
