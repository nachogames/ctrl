import type { ContextMenuItem } from "@t3tools/contracts";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";

import {
  buildMoveToGroupMenuItems,
  type MoveToGroupCandidate,
  type MoveToGroupMenuId,
} from "./moveToGroupMenu.logic";
import { groupSnoozeChildren } from "./threadGroupMenu.logic";

/** Sent to the open chat by "Hand off to new chat"; its agent writes the summary. */
export const THREAD_HANDOFF_PROMPT =
  "Hand this chat off to a new chat in its group. Call the t3_group_handoff tool with a summary covering: the current state, the next steps, and anything the next chat must not touch. Then stop.";

/** Context menus cannot show tooltips, so a disabled handoff says why in its label. */
export const THREAD_HANDOFF_BUSY_HINT = "Wait for the turn to finish";

export type ThreadActionMenuId =
  | "new-thread-on-branch"
  | "handoff"
  | MoveToGroupMenuId
  | "filter-by-project"
  | "turn-into-project"
  | "project-settings"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "auto-settle"
  | "auto-settle:enabled"
  | "auto-settle:disabled"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "pin-group"
  | "unpin-group"
  | "snooze-group"
  | `snooze-group:${string}`
  | "unsnooze-group"
  | "open-group-panel"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "share-guest"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread"
  | "copy-thread-id"
  | "archive"
  | "delete";

export type DraftActionMenuId =
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "project-settings"
  | "discard";

export function buildDraftActionMenuItems(options: {
  readonly hasPath: boolean;
  readonly hasBranch: boolean;
  readonly hasProject: boolean;
}): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  return [
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath ? [{ id: "copy-path" as const, label: "Path", icon: "folder" }] : []),
        ...(options.hasBranch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
      ],
    },
    ...(options.hasProject
      ? [{ id: "project-settings" as const, label: "Project settings", icon: "settings" }]
      : []),
    {
      id: "discard",
      label: "Discard draft",
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export interface ThreadActionMenuState {
  readonly canOperate: boolean;
  readonly branch: string | null;
  readonly projectFilter: {
    readonly label: string;
    readonly isActive: boolean;
  } | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly autoSettleEnabled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects attached providers, so disable it while running. */
  readonly isRunning: boolean;
  /** Subagents belong to their parent thread: no handoff. */
  readonly isSubagent?: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly autoSettleOptOut: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
    /** Server runs chat groups; without it no group action shows. */
    readonly threadGroups: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  /**
   * The chat's known group. Membership places the chat, so Pin and Snooze act
   * on the group instead; Settle still acts on the chat.
   */
  readonly group?: {
    readonly isPinned: boolean;
    readonly isSnoozed: boolean;
  } | null;
  /**
   * Groups of the chat's project for "Move to group…", and the chat's current
   * one. Null hides the move items (subagents, surfaces without groups).
   */
  readonly moveToGroup?: {
    readonly groups: ReadonlyArray<MoveToGroupCandidate>;
    readonly currentGroupId: MoveToGroupCandidate["id"] | null;
  } | null;
  /** Guest links need their own grant, so the caller checks it instead of `canOperate`. */
  readonly canShareWithGuest?: boolean;
  /** A No project thread with its own folder, on a server that can promote it. */
  readonly canTurnIntoProject?: boolean;
}

/** Local navigation, read markers, and copying remain available to read-only clients. */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  return ![
    "new-thread-on-branch",
    "project-settings",
    "open-group-panel",
    "mark-unread",
    "share-guest",
    "copy",
    "copy-path",
    "copy-branch",
    "copy-thread",
    "copy-thread-id",
  ].includes(action);
}

export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  // A group only places the chat where the server can act on groups.
  const group = state.supports.threadGroups ? (state.group ?? null) : null;
  const items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: `New thread on ${state.branch}`,
            icon: "message-square-plus",
          },
        ]
      : []),
    // Disabled mid-turn: the prompt would queue behind work the summary must cover.
    ...(state.isSubagent || !state.supports.threadGroups
      ? []
      : [
          {
            id: "handoff" as const,
            label: state.isRunning
              ? `Hand off to new chat (${THREAD_HANDOFF_BUSY_HINT.toLowerCase()})`
              : "Hand off to new chat",
            icon: "message-square-plus",
            disabled: state.isRunning,
          },
        ]),
    ...(group
      ? [
          group.isPinned
            ? { id: "unpin-group" as const, label: "Unpin group", icon: "pin-off" }
            : { id: "pin-group" as const, label: "Pin group", icon: "pin" },
        ]
      : state.supports.pinning
        ? [
            state.isPinned
              ? { id: "unpin" as const, label: "Unpin thread", icon: "pin-off" }
              : { id: "pin" as const, label: "Pin thread", icon: "pin" },
          ]
        : []),
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: "Un-settle thread", icon: "circle-check" }
            : { id: "settle" as const, label: "Settle thread", icon: "circle-check" },
        ]
      : []),
    ...(state.supports.snooze && group
      ? [
          group.isSnoozed
            ? { id: "unsnooze-group" as const, label: "Wake group", icon: "clock" }
            : {
                id: "snooze-group" as const,
                label: "Snooze group",
                icon: "clock",
                children: groupSnoozeChildren(state.snoozePresets),
              },
        ]
      : []),
    // A chat snoozed before it joined keeps its own snooze; let it be cancelled.
    ...(state.supports.snooze && group && state.isSnoozed
      ? [{ id: "unsnooze" as const, label: "Wake chat", icon: "clock" }]
      : []),
    ...(state.supports.snooze && !group
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: "Wake thread", icon: "clock" }
            : {
                id: "snooze" as const,
                label: "Snooze",
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: `${preset.label} (${preset.whenLabel})`,
                  })),
                  {
                    id: "snooze:custom" as const,
                    label: "Custom…",
                    separatorBefore: state.snoozePresets.length > 0,
                  },
                ],
              },
        ]
      : []),
    ...(group ? [{ id: "open-group-panel" as const, label: "Open group panel" }] : []),
    ...(state.moveToGroup && state.supports.threadGroups
      ? buildMoveToGroupMenuItems(state.moveToGroup)
      : []),
    { id: "rename", label: "Rename thread", icon: "pencil", separatorBefore: true },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    { id: "mark-unread", label: "Mark unread", icon: "mail-open" },
    ...(state.canShareWithGuest
      ? [{ id: "share-guest" as const, label: "Share with guest", icon: "user-plus" }]
      : []),
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? "Show all projects"
              : `Filter by ${state.projectFilter.label}`,
            icon: "folder-tree",
          },
        ]
      : []),
    ...(state.canTurnIntoProject
      ? [
          {
            id: "turn-into-project" as const,
            label: "Turn into project",
            icon: "folder-plus",
            disabled: state.isRunning,
          },
        ]
      : []),
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: "Auto-settle behavior",
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: "Enabled",
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: "Disabled",
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      separatorBefore: true,
      children: [
        { id: "copy-path", label: "Path", icon: "folder" },
        ...(state.branch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
        { id: "copy-thread", label: "Thread", icon: "message-square" },
        { id: "copy-thread-id", label: "Thread ID", icon: "hash" },
      ],
    },
    { id: "project-settings", label: "Project settings", icon: "settings" },
    {
      id: "archive",
      label: "Archive thread",
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: "Delete",
      destructive: true,
      icon: "trash",
    },
  ];
  return state.canOperate
    ? items
    : items.map((item) =>
        threadActionRequiresOperate(item.id)
          ? {
              ...item,
              disabled: true,
              ...(item.children
                ? { children: item.children.map((child) => ({ ...child, disabled: true })) }
                : {}),
            }
          : item,
      );
}
