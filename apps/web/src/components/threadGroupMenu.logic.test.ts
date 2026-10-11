import { describe, expect, it } from "vite-plus/test";

import { buildThreadGroupMenuItems, type ThreadGroupMenuState } from "./threadGroupMenu.logic";

const baseState: ThreadGroupMenuState = {
  canOperate: true,
  isPinned: false,
  isSnoozed: false,
  isSettled: false,
  supports: { settlement: true, snooze: true },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

const ids = (state: ThreadGroupMenuState) =>
  buildThreadGroupMenuItems(state).map((item) => item.id);

describe("buildThreadGroupMenuItems", () => {
  it("offers the forward actions for an active group", () => {
    expect(ids(baseState)).toEqual([
      "new-chat-in-group",
      "rename-group",
      "pin-group",
      "snooze-group",
      "settle-group",
      "open-group-panel",
      "ungroup",
    ]);
    const snooze = buildThreadGroupMenuItems(baseState).find((item) => item.id === "snooze-group");
    expect(snooze?.children?.map((child) => child.id)).toEqual([
      "snooze-group:hour",
      "snooze-group:custom",
    ]);
  });

  it("offers the way back for a pinned, snoozed and settled group", () => {
    expect(ids({ ...baseState, isPinned: true, isSnoozed: true, isSettled: true })).toEqual([
      "new-chat-in-group",
      "rename-group",
      "unpin-group",
      "unsnooze-group",
      "unsettle-group",
      "open-group-panel",
      "ungroup",
    ]);
  });

  it("hides settle and snooze where the environment cannot settle or snooze chats", () => {
    expect(ids({ ...baseState, supports: { settlement: false, snooze: false } })).toEqual([
      "new-chat-in-group",
      "rename-group",
      "pin-group",
      "open-group-panel",
      "ungroup",
    ]);
  });

  it("asks before ungrouping", () => {
    const ungroup = buildThreadGroupMenuItems(baseState).find((item) => item.id === "ungroup");
    expect(ungroup?.destructive).toBe(true);
  });

  it("disables every change for a read-only connection but still opens the panel", () => {
    const items = buildThreadGroupMenuItems({ ...baseState, canOperate: false });
    expect(items.filter((item) => !item.disabled).map((item) => item.id)).toEqual([
      "open-group-panel",
    ]);
    const snooze = items.find((item) => item.id === "snooze-group");
    expect(snooze?.children?.every((child) => child.disabled)).toBe(true);
  });
});
