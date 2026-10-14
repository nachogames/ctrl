import type { ContextMenuItem } from "@t3tools/contracts";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";

/** Ids for a chat group's right-click menu. Snooze presets dispatch as `snooze-group:<presetId>`. */
export type ThreadGroupMenuId =
  | "move-group-up"
  | "move-group-down"
  | "new-chat-in-group"
  | "rename-group"
  | "pin-group"
  | "unpin-group"
  | "snooze-group"
  | `snooze-group:${string}`
  | "unsnooze-group"
  | "settle-group"
  | "unsettle-group"
  | "open-group-panel"
  | "ungroup";

export interface ThreadGroupMenuState {
  readonly canOperate: boolean;
  readonly isPinned: boolean;
  /** `snoozedUntil` is still in the future. */
  readonly isSnoozed: boolean;
  /** The group sits in Settled: stamped, or every visible member settled. */
  readonly isSettled: boolean;
  readonly supports: {
    /** Settling a group settles its chats, so it needs thread settlement. */
    readonly settlement: boolean;
    /** Same presets as chats; hidden where chats cannot snooze either. */
    readonly snooze: boolean;
    /** Server runs chat groups. Without it a group still shows, but only its panel opens. */
    readonly threadGroups: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
}

/** A group is snoozed while its wake time is still ahead. */
export function isThreadGroupSnoozed(
  group: { readonly snoozedUntil: string | null },
  nowMs: number,
): boolean {
  if (group.snoozedUntil === null) return false;
  const wakeMs = Date.parse(group.snoozedUntil);
  return !Number.isNaN(wakeMs) && wakeMs > nowMs;
}

/** Snooze presets as a submenu, shared by the group menu and a grouped chat's menu. */
export function groupSnoozeChildren(
  presets: ReadonlyArray<SnoozePreset>,
): ReadonlyArray<ContextMenuItem<`snooze-group:${string}`>> {
  return [
    ...presets.map((preset) => ({
      id: `snooze-group:${preset.id}` as const,
      label: `${preset.label} (${preset.whenLabel})`,
    })),
    { id: "snooze-group:custom" as const, label: "Custom…", separatorBefore: true },
  ];
}

export function buildThreadGroupMenuItems(
  state: ThreadGroupMenuState,
): ReadonlyArray<ContextMenuItem<ThreadGroupMenuId>> {
  if (!state.supports.threadGroups) return [{ id: "open-group-panel", label: "Open group panel" }];
  const items: ReadonlyArray<ContextMenuItem<ThreadGroupMenuId>> = [
    { id: "new-chat-in-group", label: "New chat in group", icon: "message-square-plus" },
    { id: "rename-group", label: "Rename…", icon: "pencil", separatorBefore: true },
    state.isPinned
      ? { id: "unpin-group", label: "Unpin group", icon: "pin-off" }
      : { id: "pin-group", label: "Pin group", icon: "pin" },
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze-group" as const, label: "Wake group", icon: "clock" }
            : {
                id: "snooze-group" as const,
                label: "Snooze group",
                icon: "clock",
                children: groupSnoozeChildren(state.snoozePresets),
              },
        ]
      : []),
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle-group" as const, label: "Unsettle group", icon: "circle-check" }
            : { id: "settle-group" as const, label: "Settle group", icon: "circle-check" },
        ]
      : []),
    // Icons come from a closed set (contextMenuFallback.ts); these two have none.
    { id: "open-group-panel", label: "Open group panel" },
    { id: "ungroup", label: "Ungroup", destructive: true, separatorBefore: true },
  ];
  return state.canOperate
    ? items
    : items.map((item) =>
        item.id === "open-group-panel"
          ? item
          : {
              ...item,
              disabled: true,
              ...(item.children
                ? { children: item.children.map((child) => ({ ...child, disabled: true })) }
                : {}),
            },
      );
}
