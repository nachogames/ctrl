import { describe, expect, it } from "vite-plus/test";

import { orderGroupMembers } from "./groupOrder.ts";

const item = (
  id: string,
  createdAtMs: number,
  overrides: { handedOffFrom?: string | null; groupOrderKey?: string | null } = {},
) => ({ id, createdAtMs, handedOffFrom: null, groupOrderKey: null, ...overrides });

describe("orderGroupMembers", () => {
  it("reads an unordered group newest first", () => {
    expect(orderGroupMembers([item("a", 1), item("c", 3), item("b", 2)])).toEqual(["c", "b", "a"]);
  });

  it("puts a handoff successor directly above its source despite a newer unrelated chat", () => {
    const a = item("a", 1);
    const b = item("b", 2, { handedOffFrom: "a" });
    const c = item("c", 3);
    expect(orderGroupMembers([a, b, c])).toEqual(["c", "b", "a"]);
    const d = item("d", 4, { handedOffFrom: "b" });
    const e = item("e", 3.5);
    expect(orderGroupMembers([a, b, c, d, e])).toEqual(["d", "b", "a", "e", "c"]);
  });

  it("keeps a chain together when an unrelated chat is newer than its source", () => {
    const a = item("a", 1);
    const x = item("x", 2);
    const b = item("b", 3, { handedOffFrom: "a" });
    expect(orderGroupMembers([a, x, b])).toEqual(["b", "a", "x"]);
  });

  it("lists keyed members after keyless ones, ascending by key then id", () => {
    expect(
      orderGroupMembers([
        item("k2", 9, { groupOrderKey: "b" }),
        item("old", 1),
        item("k1", 1, { groupOrderKey: "a" }),
        item("k3", 5, { groupOrderKey: "b" }),
        item("new", 2),
      ]),
    ).toEqual(["new", "old", "k1", "k2", "k3"]);
  });

  it("sorts a keyless successor of a keyed chat by time among keyless; the source stays in the keyed tail", () => {
    expect(
      orderGroupMembers([
        item("k", 1, { groupOrderKey: "a" }),
        item("s", 2, { handedOffFrom: "k" }),
        item("n", 3),
      ]),
    ).toEqual(["n", "s", "k"]);
  });

  it("keeps everyone when handoff links loop or leave the group", () => {
    const x = item("x", 1, { handedOffFrom: "y" });
    const y = item("y", 2, { handedOffFrom: "x" });
    const z = item("z", 3, { handedOffFrom: "outside" });
    const self = item("s", 4, { handedOffFrom: "s" });
    const result = orderGroupMembers([x, y, z, self]);
    expect([...result].toSorted()).toEqual(["s", "x", "y", "z"]);
    expect(result[0]).toBe("s");
  });
});
