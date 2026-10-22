import type { ThreadGroupId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
    threadGroups: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

function allIds(state: ThreadActionMenuState): string[] {
  const flatten = (items: ReturnType<typeof buildThreadActionMenuItems>): string[] =>
    items.flatMap((item) => [item.id, ...(item.children ? flatten(item.children) : [])]);
  return flatten(buildThreadActionMenuItems(state));
}

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "handoff",
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "handoff",
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });

  it("acts on the group for pin and snooze when the chat is in a group", () => {
    const lifecycle = (state: ThreadActionMenuState) =>
      ids(state).filter((id) => /pin|snooze|settle|group/.test(id) && id !== "auto-settle");
    expect(lifecycle({ ...baseState, group: { isPinned: false, isSnoozed: false } })).toEqual([
      "pin-group",
      "settle",
      "snooze-group",
      "open-group-panel",
    ]);
    expect(
      lifecycle({
        ...baseState,
        isPinned: true,
        isSettled: true,
        group: { isPinned: true, isSnoozed: true },
      }),
    ).toEqual(["unpin-group", "unsettle", "unsnooze-group", "open-group-panel"]);
    expect(allIds({ ...baseState, group: { isPinned: false, isSnoozed: false } })).toContain(
      "snooze-group:hour",
    );
  });

  it("hands off to a new chat, but not while the chat is running a turn", () => {
    const idle = buildThreadActionMenuItems(baseState).find((item) => item.id === "handoff");
    expect(idle).toMatchObject({ label: "Hand off to new chat" });
    expect(idle?.disabled).toBe(false);
    const busy = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "handoff",
    );
    expect(busy?.disabled).toBe(true);
    expect(busy?.label).toContain("wait for the turn to finish");
  });

  it("offers no handoff on a subagent chat", () => {
    expect(ids({ ...baseState, isSubagent: true })).not.toContain("handoff");
  });

  it("offers moving between groups only where the surface supplies the project's groups", () => {
    expect(ids(baseState)).not.toContain("move-to-group");
    const groupId = "group-auth" as ThreadGroupId;
    const grouped = ids({
      ...baseState,
      group: { isPinned: false, isSnoozed: false },
      moveToGroup: {
        groups: [{ id: groupId, title: "Auth", activityMs: 1, visible: true }],
        currentGroupId: groupId,
      },
    });
    expect(grouped.slice(grouped.indexOf("open-group-panel"))).toEqual(
      expect.arrayContaining(["open-group-panel", "move-to-group", "remove-from-group"]),
    );
    expect(ids({ ...baseState, moveToGroup: { groups: [], currentGroupId: null } })).not.toContain(
      "remove-from-group",
    );
  });

  it("keeps Wake chat for a grouped chat's own earlier snooze", () => {
    const group = { isPinned: false, isSnoozed: false };
    expect(ids({ ...baseState, group, isSnoozed: true })).toContain("unsnooze");
    expect(ids({ ...baseState, group, isSnoozed: false })).not.toContain("unsnooze");
    expect(
      buildThreadActionMenuItems({ ...baseState, group, isSnoozed: true }).find(
        (item) => item.id === "unsnooze",
      )?.label,
    ).toBe("Wake chat");
  });

  it("offers no group action where the server cannot run groups", () => {
    const groupId = "group-auth" as ThreadGroupId;
    const state: ThreadActionMenuState = {
      ...baseState,
      group: { isPinned: false, isSnoozed: false },
      moveToGroup: {
        groups: [{ id: groupId, title: "Auth", activityMs: 1, visible: true }],
        currentGroupId: groupId,
      },
    };
    const groupActions = [
      "handoff",
      "move-to-group",
      "remove-from-group",
      "pin-group",
      "snooze-group",
    ];
    expect(ids(state)).toEqual(expect.arrayContaining(groupActions));
    const unsupported = ids({ ...state, supports: { ...state.supports, threadGroups: false } });
    for (const id of groupActions) expect(unsupported).not.toContain(id);
    // Pin and snooze fall back to the chat itself.
    expect(unsupported).toEqual(expect.arrayContaining(["pin", "snooze"]));
  });

  it("keeps the group panel reachable for read-only connections", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      group: { isPinned: false, isSnoozed: false },
    });
    expect(items.find((item) => item.id === "open-group-panel")?.disabled).toBeUndefined();
    expect(items.find((item) => item.id === "pin-group")?.disabled).toBe(true);
  });
});
