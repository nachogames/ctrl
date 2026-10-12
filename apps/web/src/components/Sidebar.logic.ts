import {
  resolveThreadWorkingStartedAt,
  type EnvironmentThreadGroup,
} from "@t3tools/client-runtime/state/models";
import { threadGroupKey } from "@t3tools/client-runtime/state/entities";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";
import * as React from "react";
import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { defaultAnimateLayoutChanges, type AnimateLayoutChanges } from "@dnd-kit/sortable";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import type { ContextMenuItem, EnvironmentId, ThreadGroupId, ThreadId } from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import type { AsyncResult } from "effect/reactivity";
import { planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";
import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "../lib/threadSort";
import type { SidebarThreadSummary, Thread } from "../types";
import { cn, normalizeSearchText } from "../lib/utils";
import { isLatestRunSettled } from "../session-logic";
import { resolveServerBackedAppStageLabel } from "../branding.logic";

export function shouldNavigateAfterThreadPark(input: {
  readonly threadKey: string;
  readonly currentThreadKey: string | null;
  readonly action: "settle" | "snooze";
  readonly now: string;
  readonly thread: (ThreadSnoozeShell & Pick<SidebarThreadSummary, "settledOverride">) | null;
}): boolean {
  return (
    input.threadKey === input.currentThreadKey &&
    input.thread !== null &&
    (input.action === "settle"
      ? input.thread.settledOverride === "settled"
      : effectiveSnoozed(input.thread, { now: input.now }))
  );
}

const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 200;

export function resolveSidebarRowAccessibility(input: {
  readonly title: string;
  readonly statusLabel: string | null;
  readonly projectDisplayName: string | null;
  readonly isActive: boolean;
}): { readonly label: string; readonly current: "page" | undefined } {
  return {
    // The title is the row's identity and must lead when users scan tasks.
    // Only static context belongs here; nested action labels remain separate controls.
    label: [input.title, input.statusLabel, input.projectDisplayName].filter(Boolean).join(", "),
    current: input.isActive ? "page" : undefined,
  };
}

// Visible sidebar rows are prewarmed into the thread-detail cache so opening a
// nearby thread usually reuses an already-hot subscription. Each prewarmed
// thread holds a live, fully hydrated detail subscription (all messages and
// activities, growing as agents work) for as long as the row stays visible,
// so this limit is a direct renderer-heap and server-load multiplier — keep
// it small; cold opens still render instantly from the cached snapshot.
const SIDEBAR_THREAD_PREWARM_LIMIT = 3;
// A small buffer keeps the next few rows warm without leasing every row that
// content-visibility leaves mounted below the scroll viewport.
const SIDEBAR_ROW_SUBSCRIPTION_OVERSCAN_PX = 160;

export function useSidebarRowSubscriptionLease(isActive: boolean): {
  readonly leaseLiveStatus: boolean;
  readonly rowRef: React.Dispatch<React.SetStateAction<HTMLElement | null>>;
} {
  const [row, setRow] = React.useState<HTMLElement | null>(null);
  const [isNearViewport, setIsNearViewport] = React.useState(isActive);

  React.useEffect(() => {
    if (isActive) {
      setIsNearViewport(true);
      return;
    }
    if (row === null) return;
    if (typeof IntersectionObserver === "undefined") {
      setIsNearViewport(true);
      return;
    }

    const scrollRoot = row.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const observer = new IntersectionObserver(
      ([entry]) => setIsNearViewport(entry?.isIntersecting === true),
      {
        root: scrollRoot,
        rootMargin: `${SIDEBAR_ROW_SUBSCRIPTION_OVERSCAN_PX}px 0px`,
      },
    );
    observer.observe(row);
    return () => observer.disconnect();
  }, [isActive, row]);

  return {
    leaseLiveStatus: isActive || isNearViewport,
    rowRef: setRow,
  };
}

// A row keeps the last live value it rendered so a released lease never
// blanks its badge. The value is bound to `key`, so a different worktree or
// linked pull request cannot reuse the previous one.
export function useRetainedValue<T>(key: string | null, value: T | null): T | null {
  const retained = React.useRef<{ readonly key: string; readonly value: T } | null>(null);
  if (key !== null && value !== null) {
    retained.current = { key, value };
  }
  if (value !== null) return value;
  return key !== null && retained.current?.key === key ? retained.current.value : null;
}

// Sidebar.motion handles ordinary section changes. Sortable transforms own
// dragging; replaying their committed DOM order would animate the drop twice.
export const animateSidebarLayoutChanges: AnimateLayoutChanges = (args) =>
  args.isSorting ? defaultAnimateLayoutChanges(args) : false;

// Rows and section markers share one sortable list. The separators resolve
// the lifecycle action; Sidebar.drag previews the resulting layout. Pinned
// and active threads keep the dragged position; settled threads use time
// order. Snoozed rows can leave the shelf, but dropping into it is not
// supported because snoozing requires a wake time. The Working shelf (beta)
// follows live status, so it is neither a drag source nor a destination.

export type SidebarSection = "pinned" | "active" | "working" | "snoozed" | "settled";

/** Resolve the shelf a visible thread belongs to. Snooze is temporary and
 * wins until its wake boundary; settlement then wins over a stale pin. */
export function resolveSidebarThreadSection(input: {
  readonly snoozed: boolean;
  readonly settled: boolean;
  readonly pinned: boolean;
}): SidebarSection {
  if (input.snoozed) return "snoozed";
  if (input.settled) return "settled";
  if (input.pinned) return "pinned";
  return "active";
}

/** Sortable ids: thread rows use their scoped key; structural items use a
    colon-free prefix: scoped thread keys always contain a colon. */
const SIDEBAR_MARKER_PREFIX = "sidebar-marker-";

export type SidebarListMarker =
  /** The top boundary is also a landing target when there are no pins. */
  | "pinned-header"
  /** Stand-in rows so an empty section has somewhere for the gap to open. */
  | "active-placeholder"
  | "settled-placeholder"
  /** The boundary between pinned and active rows. */
  | "pinned-divider"
  | "working-header"
  | "snoozed-header"
  | "settled-header";

export function sidebarMarkerId(marker: SidebarListMarker): string {
  return `${SIDEBAR_MARKER_PREFIX}${marker}`;
}

/** Structural rows sit beside thread rows in the one flat list. Grouped
    thread rows carry their group's key; they follow their group row and
    never take part in the manual Active order. */
export type SidebarListItem =
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly section: SidebarSection;
      readonly groupKey?: string | null;
    }
  | { readonly kind: "group"; readonly key: string; readonly section: SidebarGroupSection }
  | { readonly kind: "project-heading"; readonly key: string }
  | { readonly kind: "marker"; readonly marker: SidebarListMarker };

export function sidebarListItemId(item: SidebarListItem): string {
  switch (item.kind) {
    case "thread":
      return item.key;
    case "group":
      return `sidebar-group-${item.key}`;
    case "project-heading":
      return `sidebar-project-${item.key}`;
    case "marker":
      return sidebarMarkerId(item.marker);
  }
}

/** The section a slot belongs to, read off the markers around it: from
    the top down, everything before the pinned divider is pinned, then the
    inbox until the first shelf header, each shelf until the next header,
    then settled. */
function sectionAtSidebarSlot(items: readonly SidebarListItem[], index: number): SidebarSection {
  let section: SidebarSection = "pinned";
  for (let i = 0; i < index && i < items.length; i += 1) {
    const item = items[i]!;
    if (item.kind !== "marker") continue;
    if (item.marker === "pinned-divider") section = "active";
    else if (item.marker === "working-header") section = "working";
    else if (item.marker === "snoozed-header") section = "snoozed";
    else if (item.marker === "settled-header") section = "settled";
  }
  return section;
}

/** Resolve the destination section and manual order from an arrayMove across
 * the separators. The working and snoozed shelves are never destinations. */
export type SidebarDropTarget = {
  readonly section: "pinned" | "active" | "settled";
  readonly pinnedOrder: readonly string[];
  readonly activeOrder: readonly string[];
};

export function resolveSidebarDropTarget(
  items: readonly SidebarListItem[],
  activeKey: string,
  overId: string,
): SidebarDropTarget | null {
  const activeIndex = items.findIndex((item) => sidebarListItemId(item) === activeKey);
  const overIndex = items.findIndex((item) => sidebarListItemId(item) === overId);
  if (activeIndex === -1 || overIndex === -1 || items[activeIndex]?.kind !== "thread") return null;
  const moved = items.filter((_, index) => index !== activeIndex);
  moved.splice(overIndex, 0, items[activeIndex]!);
  const section = sectionAtSidebarSlot(moved, overIndex);
  if (section === "working" || section === "snoozed") return null;
  const pinnedOrder: string[] = [];
  const activeOrder: string[] = [];
  let currentSection: SidebarSection = "pinned";
  for (const item of moved) {
    if (item.kind === "marker") {
      if (item.marker === "pinned-divider") currentSection = "active";
      else if (
        item.marker === "working-header" ||
        item.marker === "snoozed-header" ||
        item.marker === "settled-header"
      )
        break;
      continue;
    }
    // Groups, headings and grouped rows have no manual order of their own.
    if (item.kind !== "thread" || (item.groupKey ?? null) !== null) continue;
    if (currentSection === "pinned") pinnedOrder.push(item.key);
    else activeOrder.push(item.key);
  }
  return { section, pinnedOrder, activeOrder };
}

/** Dropping a chat into a group: join a group, or group a lone Active chat first and then join. */
export type SidebarGroupDropTarget =
  | { readonly kind: "join"; readonly groupKey: string }
  | { readonly kind: "create-with"; readonly threadKey: string };

interface SidebarGroupDropThread {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly lineage: { readonly relationshipToParent: "fork" | "subagent" | null };
  readonly groupId?: ThreadGroupId | null;
}

/**
 * What dropping `activeThread` on `overItem` does to its group, or null when
 * the drop is not a group drop. A group row in any section takes the chat. An
 * Active-tree chat row takes it into its group, or groups with it when lone; a
 * lone chat that is the last member of a hidden group takes it into that group.
 * Pinned, Settled and shelf chat rows keep their pin and settle drops, and so
 * does an ungrouped chat dragged in from a shelf (its drop into Active means
 * unpin, un-settle or wake). Targets in another project, the chat's own group
 * and subagents never are group drops, nor is any drop where the chat's
 * server cannot run groups.
 */
export function resolveSidebarGroupDropTarget(input: {
  readonly activeThread: SidebarGroupDropThread & {
    readonly key: string;
    readonly section: SidebarSection;
    readonly groupKey: string | null;
  };
  readonly overItem: SidebarListItem | undefined;
  readonly groups: ReadonlyMap<string, Pick<EnvironmentThreadGroup, "environmentId" | "projectId">>;
  readonly threads: ReadonlyMap<string, SidebarGroupDropThread>;
  /** The chat's environment advertises `threadGroups`. */
  readonly supportsGroups: boolean;
}): SidebarGroupDropTarget | null {
  const { activeThread: active, overItem } = input;
  if (!input.supportsGroups) return null;
  const isSubagent = (thread: SidebarGroupDropThread) =>
    thread.lineage.relationshipToParent === "subagent";
  if (isSubagent(active) || overItem === undefined) return null;
  const sameProject = (target: Pick<SidebarGroupDropThread, "environmentId" | "projectId">) =>
    target.environmentId === active.environmentId && target.projectId === active.projectId;
  if (overItem.kind === "group") {
    const group = input.groups.get(overItem.key);
    if (group === undefined || !sameProject(group) || overItem.key === active.groupKey) {
      return null;
    }
    return { kind: "join", groupKey: overItem.key };
  }
  if (overItem.kind !== "thread" || overItem.key === active.key) return null;
  if (overItem.section !== "active") return null;
  if (active.groupKey === null && active.section !== "active") return null;
  const target = input.threads.get(overItem.key);
  if (target === undefined || isSubagent(target) || !sameProject(target)) return null;
  const targetGroupKey = overItem.groupKey ?? null;
  if (targetGroupKey !== null) {
    return targetGroupKey === active.groupKey ? null : { kind: "join", groupKey: targetGroupKey };
  }
  const hiddenGroupKey =
    target.groupId == null
      ? null
      : threadGroupKey({ environmentId: target.environmentId, groupId: target.groupId });
  const hiddenGroup = hiddenGroupKey === null ? undefined : input.groups.get(hiddenGroupKey);
  if (hiddenGroupKey === null || hiddenGroup === undefined || !sameProject(hiddenGroup)) {
    return { kind: "create-with", threadKey: overItem.key };
  }
  return hiddenGroupKey === active.groupKey ? null : { kind: "join", groupKey: hiddenGroupKey };
}

/**
 * The group whose chats a drop reorders: a member dropped on another member of
 * its own expanded group. Null for any other drop, or where the chat's server
 * cannot store the order.
 */
export function resolveSidebarGroupReorder(input: {
  readonly activeItem: SidebarListItem | undefined;
  readonly overItem: SidebarListItem | undefined;
  /** The chat's environment advertises `threadGroupReorder`. */
  readonly supportsReorder: boolean;
}): string | null {
  const { activeItem, overItem } = input;
  if (!input.supportsReorder || activeItem?.kind !== "thread" || overItem?.kind !== "thread") {
    return null;
  }
  const groupKey = activeItem.groupKey ?? null;
  if (groupKey === null || overItem.key === activeItem.key) return null;
  return overItem.groupKey === groupKey ? groupKey : null;
}

/**
 * Order keys for a reorder inside a group: the Pinned rule, over the group's
 * chats. Write them in the returned order, which runs bottom-up: keyless chats
 * sort above keyed ones in a group, so each write lands in its planned place
 * and a failure partway leaves the asked-for order, not a reshuffle.
 */
export function planGroupMemberReorder(input: {
  /** Member ids in the order after the move. */
  readonly orderedIds: readonly string[];
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly movedId: string;
}): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> {
  const position = new Map(input.orderedIds.map((id, index) => [id, index]));
  return planPinnedReorder(input).toSorted(
    (left, right) => (position.get(right.id) ?? -1) - (position.get(left.id) ?? -1),
  );
}

export type SidebarThreadDropPlan =
  | { readonly kind: "none" }
  /** Within the pinned block: the existing key writes. */
  | {
      readonly kind: "reorder-pinned";
      readonly order: readonly string[];
      readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
    }
  /** From another section into the pinned block. Fresh pins take `orderKey`
      on the pin command. `extraAssignments` land afterward, including the
      moved row when it was already pinned beneath a snooze. */
  | {
      readonly kind: "pin";
      readonly order: readonly string[];
      readonly orderKey: string | undefined;
      readonly extraAssignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
    }
  | {
      readonly kind: "move-active";
      /** Null when the inbox is time-ordered: the drop has no placement. */
      readonly order: readonly string[] | null;
      readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
      readonly unpin: boolean;
      readonly unsettle: boolean;
      readonly unsnooze: boolean;
    }
  | { readonly kind: "settle" };

/** What dropping in `to` does to a thread lifted from `from`, for the badge
    on the lifted row. Null while reordering inside one section and for the
    working and snoozed shelves, which cannot be drop targets. */
export type SidebarDropVerb = "pin" | "unpin" | "settle" | "unsettle" | "wake";

export function resolveSidebarDropVerb(
  from: SidebarSection,
  to: SidebarSection | null,
): SidebarDropVerb | null {
  if (to === null || to === from || to === "working" || to === "snoozed") return null;
  if (to === "pinned") return "pin";
  if (to === "settled") return "settle";
  if (from === "pinned") return "unpin";
  if (from === "settled") return "unsettle";
  return "wake";
}

/** Eligible rows between the pressed action and the pointer, in sidebar order. */
export function resolveSidebarSweepKeys(
  orderedKeys: readonly string[],
  originKey: string,
  targetKey: string,
  canApply: (key: string) => boolean,
): string[] {
  const origin = orderedKeys.indexOf(originKey);
  const target = orderedKeys.indexOf(targetKey);
  if (origin === -1 || target === -1) return [];
  return orderedKeys.slice(Math.min(origin, target), Math.max(origin, target) + 1).filter(canApply);
}

/** The thread row at a pointer height, clamped to the rows visible in the
    sidebar's scroll viewport. A gap between rows resolves to the row above
    it. Rows carry their key in data-thread-item, which departing motion
    clones drop. */
export function sidebarThreadKeyAtY(list: HTMLElement, y: number): string | null {
  const viewport = list.closest('[data-slot="scroll-area-viewport"]')?.getBoundingClientRect();
  const visibleY = viewport ? Math.min(Math.max(y, viewport.top), viewport.bottom - 1) : y;
  let key: string | null = null;
  for (const row of list.querySelectorAll<HTMLElement>("li[data-thread-item]")) {
    if (key !== null && row.getBoundingClientRect().top > visibleY) break;
    key = row.dataset.threadItem ?? null;
  }
  return key;
}

export function planSidebarThreadDrop(input: {
  readonly activeKey: string;
  readonly activeSection: SidebarSection;
  /** Snoozed threads can retain pinning and settlement beneath the shelf. */
  readonly activePinned?: boolean;
  readonly activeSettled?: boolean;
  readonly supportsSettlement?: boolean;
  readonly target: SidebarDropTarget;
  /** All pinned keys in displayed order before the drop. */
  readonly pinnedOrder: readonly string[];
  readonly pinnedKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly reorderableKeys?: ReadonlySet<string>;
  readonly activeOrder: readonly string[];
  readonly activeKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly activeReorderableKeys?: ReadonlySet<string>;
  /** Working beta: the inbox sorts by time, so drops only change lifecycle. */
  readonly activeTimeOrdered?: boolean;
}): SidebarThreadDropPlan {
  const {
    activeKey,
    activeSection,
    activePinned = activeSection === "pinned",
    activeSettled = activeSection === "settled",
    target,
    pinnedOrder,
    pinnedKeysById,
    reorderableKeys,
    activeOrder,
    activeKeysById,
    activeReorderableKeys,
  } = input;
  if (input.supportsSettlement === false && (target.section === "settled" || activeSettled)) {
    return { kind: "none" };
  }
  // Rows whose server cannot store an order (an older server, or a machine
  // that is offline) are never written. Keyless ones sort outside the keyed
  // run, so they leave the plan; keyed ones stay as bounds. Before, one keyless row
  // refused every drop that needed fresh keys for its neighbors.
  const arrange = (
    order: readonly string[],
    keysById: ReadonlyMap<string, string | null | undefined>,
    writable: ReadonlySet<string> | undefined,
  ) => {
    if (!writable) return planPinnedReorder({ orderedIds: order, keysById, movedId: activeKey });
    if (!writable.has(activeKey)) return null;
    const assignments = planPinnedReorder({
      orderedIds: order.filter((key) => writable.has(key) || keysById.get(key) != null),
      keysById,
      movedId: activeKey,
    });
    return assignments.every(({ id }) => writable.has(id)) ? assignments : null;
  };
  switch (target.section) {
    case "active": {
      // Like the settled tail: threads can enter a time-ordered inbox, but
      // not be arranged inside it.
      if (input.activeTimeOrdered) {
        return activeSection === "active"
          ? { kind: "none" }
          : {
              kind: "move-active",
              order: null,
              assignments: [],
              unpin: activePinned,
              unsettle: activeSettled,
              unsnooze: activeSection === "snoozed",
            };
      }
      const order = target.activeOrder;
      if (
        activeSection === "active" &&
        order.length === activeOrder.length &&
        order.every((key, index) => key === activeOrder[index])
      ) {
        return { kind: "none" };
      }
      const assignments = arrange(order, activeKeysById, activeReorderableKeys);
      if (assignments === null) return { kind: "none" };
      return {
        kind: "move-active",
        order,
        assignments,
        unpin: activePinned,
        unsettle: activeSettled,
        unsnooze: activeSection === "snoozed",
      };
    }
    case "settled":
      return activeSection === "settled" ? { kind: "none" } : { kind: "settle" };
    case "pinned": {
      const order = target.pinnedOrder;
      // Dropped back where it started: nothing to write.
      if (
        activeSection === "pinned" &&
        order.length === pinnedOrder.length &&
        order.every((key, index) => key === pinnedOrder[index])
      ) {
        return { kind: "none" };
      }
      const assignments = arrange(order, pinnedKeysById, reorderableKeys);
      if (assignments === null) return { kind: "none" };
      if (activeSection === "pinned") {
        return assignments.length === 0
          ? { kind: "none" }
          : { kind: "reorder-pinned", order, assignments };
      }
      return {
        kind: "pin",
        order,
        orderKey: assignments.find((assignment) => assignment.id === activeKey)?.orderKey,
        extraAssignments: activePinned
          ? assignments
          : assignments.filter((assignment) => assignment.id !== activeKey),
      };
    }
  }
}

/** Project a drop's lifecycle fields before sorting its destination. Reusing
    the server's re-entry rules keeps the preview in place when events arrive. */
export function applySidebarThreadDrop<
  T extends Pick<
    SidebarThreadSummary,
    | "pinnedAt"
    | "pinOrderKey"
    | "activeOrderKey"
    | "snoozedAt"
    | "snoozedUntil"
    | "settledAt"
    | "settledOverride"
    | "unsettledAt"
  >,
>(thread: T, section: "pinned" | "active" | "settled", now: string, orderKey?: string): T {
  const wasSettled = thread.settledOverride === "settled";
  const awake = { ...thread, snoozedAt: null, snoozedUntil: null };
  if (section === "settled") {
    return {
      ...awake,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      settledOverride: "settled",
      settledAt: wasSettled ? (thread.settledAt ?? now) : now,
      unsettledAt: null,
    };
  }
  const resumed = wasSettled
    ? { ...awake, settledOverride: "active" as const, settledAt: null, unsettledAt: now }
    : awake;
  return {
    ...resumed,
    pinnedAt: section === "pinned" ? (thread.pinnedAt ?? now) : null,
    pinOrderKey: section === "pinned" ? (orderKey ?? thread.pinOrderKey) : null,
    ...(section === "active" && orderKey !== undefined ? { activeOrderKey: orderKey } : {}),
  };
}

type SidebarProject = {
  id: string;
  title: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

type ScopedSidebarProject = SidebarProject & {
  environmentId: string;
};

type ScopedSidebarThread = ThreadSortInput & {
  environmentId: string;
  projectId: string;
  archivedAt: string | null;
};

type LogicalSidebarProject = SidebarProject & {
  projectKey: string;
  memberProjectRefs: readonly {
    environmentId: string;
    projectId: string;
  }[];
};

export type ThreadTraversalDirection = "previous" | "next";

/**
 * Shared-worktree checks must exclude only successful deletions, never the
 * whole batch. A null result skips an entry that the caller can no longer find.
 */
export async function deleteSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
>(input: {
  entries: readonly TEntry[];
  delete: (
    entry: TEntry,
    deletedThreadKeys: ReadonlySet<string>,
  ) => Promise<AtomCommandResult<unknown, unknown> | null>;
}) {
  const deletedThreadKeys = new Set<string>();
  let firstFailure: AsyncResult.Failure<unknown, unknown> | null = null;

  for (const entry of input.entries) {
    const result = await input.delete(entry, deletedThreadKeys);
    if (result === null) continue;
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) break;
      firstFailure ??= result;
      continue;
    }
    deletedThreadKeys.add(entry.threadKey);
  }

  return { deletedThreadKeys, firstFailure };
}

export async function archiveSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
  TResult extends { readonly _tag: "Success" | "Failure" },
>(input: {
  entries: readonly TEntry[];
  archive: (entry: TEntry, onArchived: () => void) => Promise<TResult>;
}): Promise<{
  archivedThreadKeys: readonly string[];
  mutationFailure: Extract<TResult, { readonly _tag: "Failure" }> | null;
  followupFailures: readonly Extract<TResult, { readonly _tag: "Failure" }>[];
}> {
  const archivedThreadKeys: string[] = [];
  const followupFailures: Extract<TResult, { readonly _tag: "Failure" }>[] = [];

  for (const entry of input.entries) {
    let didArchive = false;
    const result = await input.archive(entry, () => {
      didArchive = true;
    });
    if (didArchive || result._tag === "Success") archivedThreadKeys.push(entry.threadKey);
    if (result._tag === "Success") continue;
    const failure = result as Extract<TResult, { readonly _tag: "Failure" }>;
    if (didArchive) {
      followupFailures.push(failure);
      continue;
    }
    return { archivedThreadKeys, mutationFailure: failure, followupFailures };
  }

  return { archivedThreadKeys, mutationFailure: null, followupFailures };
}

export function buildMultiSelectThreadContextMenuItems(input: {
  count: number;
  hasRunningThread: boolean;
}): readonly ContextMenuItem<"mark-unread" | "archive" | "delete">[] {
  return [
    { id: "mark-unread", label: `Mark unread (${input.count})` },
    {
      id: "archive",
      label: `Archive (${input.count})`,
      disabled: input.hasRunningThread,
    },
    { id: "delete", label: `Delete (${input.count})`, destructive: true },
  ];
}

export function isSidebarSubagentThread(thread: Pick<SidebarThreadSummary, "lineage">): boolean {
  return thread.lineage.relationshipToParent === "subagent";
}

/**
 * The machine the sidebar is limited to: the stored choice while that machine
 * is still saved and there is more than one, otherwise null (all machines).
 * The stored id is kept, so a machine that drops out of the catalog for a
 * while gets its filter back when it returns.
 */
export function resolveSidebarEnvironmentScope(
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
  storedEnvironmentId: string | null,
): EnvironmentId | null {
  if (environments.length <= 1 || storedEnvironmentId === null) return null;
  return (
    environments.find((environment) => environment.environmentId === storedEnvironmentId)
      ?.environmentId ?? null
  );
}

export function filterSidebarV2VisibleThreads<
  T extends Pick<SidebarThreadSummary, "archivedAt" | "lineage"> & {
    environmentId: string;
    projectId: string;
  },
>(threads: readonly T[], scopedProjectKeys: ReadonlySet<string> | null): T[] {
  return threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      !isSidebarSubagentThread(thread) &&
      (scopedProjectKeys === null ||
        scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
  );
}

export function getSidebarForkParentThreadId(
  thread: Pick<SidebarThreadSummary, "forkedFrom" | "lineage">,
) {
  if (thread.lineage.relationshipToParent !== "fork") {
    return null;
  }
  return thread.forkedFrom?.type === "run"
    ? thread.forkedFrom.threadId
    : thread.lineage.parentThreadId;
}

export function buildBulkTitleRegenerationContextMenuItem(input: {
  supportedCount: number;
  actionableCount: number;
}): ContextMenuItem<"regenerate-title"> | null {
  if (input.supportedCount === 0) return null;
  if (input.actionableCount === 0) {
    return {
      id: "regenerate-title",
      label: `Regenerating… (${input.supportedCount})`,
      disabled: true,
    };
  }
  return {
    id: "regenerate-title",
    label: `Regenerate titles (${input.actionableCount})`,
  };
}

/**
 * Bulk unpin follows the same "count only what the action will touch" rule
 * as title regeneration: on a mixed selection the label counts the pinned
 * rows alone, and the item disappears when nothing selected is pinned.
 */
export function buildBulkUnpinContextMenuItem(input: {
  pinnedCount: number;
}): ContextMenuItem<"unpin"> | null {
  if (input.pinnedCount === 0) return null;
  return { id: "unpin", label: `Unpin (${input.pinnedCount})` };
}

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Waiting"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  Working: 3,
  Connecting: 3,
  Waiting: 2.5,
  "Plan Ready": 2,
  Completed: 1,
};

type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestRun"
  | "runtime"
> & {
  lastVisitedAt?: string | null | undefined;
  pendingBackgroundTasks?: SidebarThreadSummary["pendingBackgroundTasks"] | undefined;
};

export interface ThreadJumpHintVisibilityController {
  sync: (shouldShow: boolean) => void;
  dispose: () => void;
}

export function resolveSidebarStageBadgeLabel(input: {
  primaryServerVersion: string | null | undefined;
  fallbackStageLabel: string;
}): string {
  return resolveServerBackedAppStageLabel(input);
}

export function createThreadJumpHintVisibilityController(input: {
  delayMs: number;
  onVisibilityChange: (visible: boolean) => void;
  setTimeoutFn?: typeof globalThis.setTimeout;
  clearTimeoutFn?: typeof globalThis.clearTimeout;
}): ThreadJumpHintVisibilityController {
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout;
  let isVisible = false;
  let timeoutId: NodeJS.Timeout | null = null;

  const clearPendingShow = () => {
    if (timeoutId === null) {
      return;
    }
    clearTimeoutFn(timeoutId);
    timeoutId = null;
  };

  return {
    sync: (shouldShow) => {
      if (!shouldShow) {
        clearPendingShow();
        if (isVisible) {
          isVisible = false;
          input.onVisibilityChange(false);
        }
        return;
      }

      if (isVisible || timeoutId !== null) {
        return;
      }

      timeoutId = setTimeoutFn(() => {
        timeoutId = null;
        isVisible = true;
        input.onVisibilityChange(true);
      }, input.delayMs);
    },
    dispose: () => {
      clearPendingShow();
    },
  };
}

export function useThreadJumpHintVisibility(): {
  showThreadJumpHints: boolean;
  updateThreadJumpHintsVisibility: (shouldShow: boolean) => void;
} {
  const [showThreadJumpHints, setShowThreadJumpHints] = React.useState(false);
  const controllerRef = React.useRef<ThreadJumpHintVisibilityController | null>(null);

  React.useEffect(() => {
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        setShowThreadJumpHints(visible);
      },
      setTimeoutFn: window.setTimeout.bind(window),
      clearTimeoutFn: window.clearTimeout.bind(window),
    });
    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const updateThreadJumpHintsVisibility = React.useCallback((shouldShow: boolean) => {
    controllerRef.current?.sync(shouldShow);
  }, []);

  return {
    showThreadJumpHints,
    updateThreadJumpHintsVisibility,
  };
}

/**
 * Effective visited watermark for a thread. Servers with visited tracking
 * project `lastVisitedAt` on the shell and are authoritative — that value is
 * shared across every device connected to the environment. Pre-tracking
 * servers omit the field, and the browser's locally persisted watermark keeps
 * working as before.
 */
export function resolveThreadLastVisitedAt(
  serverLastVisitedAt: string | null | undefined,
  localLastVisitedAt: string | undefined,
): string | undefined {
  // When the server tracks visits it is authoritative — including explicit
  // rewinds from mark-unread, which a newer browser-local watermark must not
  // mask. The local value only carries servers without visited tracking.
  if (serverLastVisitedAt === undefined) return localLastVisitedAt;
  return serverLastVisitedAt ?? undefined;
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestRun?.completedAt) return false;
  const completedAt = Date.parse(thread.latestRun.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

// A double-click dispatches two `click` events before `dblclick`: the first has
// `detail === 1`, the second `detail === 2`. The second click must not run the
// row's single-click navigation, otherwise double-click-to-rename would also
// navigate. `MouseEvent.detail` is 0 for synthetic/keyboard activations, which
// still count as a normal single activation.
export function isTrailingDoubleClick(detail: number): boolean {
  return detail > 1;
}

function nodeClosest(node: object | null, selector: string): unknown {
  if (node === null || !("closest" in node) || typeof node.closest !== "function") return null;
  return node.closest(selector);
}

/** Clicks on a nested link keep the link's meaning. The row must not treat them as multi-select. */
export function isSidebarNestedLinkClick(target: EventTarget | null): boolean {
  if (target == null || typeof target !== "object") return false;
  if (nodeClosest(target, "a[href]") !== null) return true;
  const parent =
    "parentElement" in target &&
    target.parentElement !== null &&
    typeof target.parentElement === "object"
      ? target.parentElement
      : null;
  return nodeClosest(parent, "a[href]") !== null;
}

// Shift+click on the new thread button creates directly in the current
// project, skipping the command palette's project picker. With a single
// project there is nothing to pick, so a plain click already creates
// immediately and the modifier changes nothing.
export function shouldCreateNewThreadInCurrentProject(
  shiftKey: boolean,
  projectGroupCount: number,
): boolean {
  return shiftKey || projectGroupCount <= 1;
}

export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
  getPreferenceIds?: (item: TItem) => readonly TId[];
}): TItem[] {
  const { getId, getPreferenceIds, items, preferredIds } = input;
  if (preferredIds.length === 0) {
    return [...items];
  }

  const indexesByPreferenceId = new Map<TId, number[]>();
  for (const [index, item] of items.entries()) {
    const preferenceIds = getPreferenceIds?.(item) ?? [getId(item)];
    for (const preferenceId of new Set(preferenceIds)) {
      const indexes = indexesByPreferenceId.get(preferenceId);
      if (indexes) {
        indexes.push(index);
      } else {
        indexesByPreferenceId.set(preferenceId, [index]);
      }
    }
  }

  const emittedIndexes = new Set<number>();
  const ordered = preferredIds.flatMap((id) => {
    const index = indexesByPreferenceId
      .get(id)
      ?.find((candidate) => !emittedIndexes.has(candidate));
    if (index === undefined) {
      return [];
    }
    emittedIndexes.add(index);
    return [items[index]!];
  });
  const remaining = items.filter((_, index) => !emittedIndexes.has(index));
  return [...ordered, ...remaining];
}

export function getSidebarThreadIdsToPrewarm<TThreadId>(
  visibleThreadIds: readonly TThreadId[],
  limit = SIDEBAR_THREAD_PREWARM_LIMIT,
): TThreadId[] {
  return visibleThreadIds.slice(0, Math.max(0, limit));
}

export function resolveAdjacentThreadId<T>(input: {
  threadIds: readonly T[];
  currentThreadId: T | null;
  direction: ThreadTraversalDirection;
}): T | null {
  const { currentThreadId, direction, threadIds } = input;

  if (threadIds.length === 0) {
    return null;
  }

  if (currentThreadId === null) {
    return direction === "previous" ? (threadIds.at(-1) ?? null) : (threadIds[0] ?? null);
  }

  const currentIndex = threadIds.indexOf(currentThreadId);
  if (currentIndex === -1) {
    return null;
  }

  if (direction === "previous") {
    return currentIndex > 0 ? (threadIds[currentIndex - 1] ?? null) : null;
  }

  return currentIndex < threadIds.length - 1 ? (threadIds[currentIndex + 1] ?? null) : null;
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  const baseClassName =
    "h-8 w-full translate-x-0 cursor-pointer justify-start rounded-md px-2 text-left text-sm select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-sidebar-row-active text-sidebar-foreground font-medium hover:bg-sidebar-row-active hover:text-sidebar-foreground",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-sidebar-row-selected text-sidebar-foreground hover:bg-sidebar-row-active hover:text-sidebar-foreground",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      "bg-sidebar-row-active text-sidebar-foreground font-medium hover:bg-sidebar-row-active hover:text-sidebar-foreground",
    );
  }

  return cn(
    baseClassName,
    "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
  );
}

// ── Sidebar v2 status model ─────────────────────────────────────────
// Six visual states, three colors: color is reserved for "act now"
// (approval), "in motion" (working), and "broken" (failed). Ready is the
// unlabeled resting state — the agent stopped and is waiting on the user,
// whether it finished, asked a question, or proposed a plan. Waiting
// (runtime status "idle") is the agent stopped with background work that will
// wake it (subagents, monitors): not the user's turn yet, so it renders grey
// like working, not as a false Done. Commands it left running, such as a dev
// server, do not hold the thread; it reads as ready.
// Unread completion is tracked separately: it describes whether a ready
// thread needs attention, not what the thread is currently doing.
export type SidebarThreadStatus =
  | "approval"
  | "input"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

export function shouldRecedeSidebarThread(input: {
  status: SidebarThreadStatus;
  isUnread: boolean;
  isWoke: boolean;
  isActive: boolean;
  isSelected: boolean;
}): boolean {
  if (input.isActive || input.isSelected || input.status === "input") return false;
  if (input.status === "working" || input.status === "waiting") return true;
  if (input.status === "ready" || input.status === "approval") {
    return !input.isUnread && !input.isWoke;
  }
  return false;
}

type SidebarThreadStatusInput = Pick<
  SidebarThreadSummary,
  "hasPendingApprovals" | "hasPendingUserInput" | "runtime"
>;

export function resolveSidebarThreadStatus(thread: SidebarThreadStatusInput): SidebarThreadStatus {
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  if (thread.hasPendingUserInput) {
    return "input";
  }
  if (
    thread.runtime !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") {
    return "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}

// ---------------------------------------------------------------------------
// Chat groups. A chat in a known visible group renders under its group,
// wherever the group is placed; its own pin/snooze/settle no longer place it.

function timestampMsOrNull(value: string | null | undefined): number | null {
  if (value == null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** "3 hours ago" → "3 hours"; rows have no room for the suffix. */
export function compactSidebarTimeLabel(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

/** Recent-activity time for sidebar sorting; never reads updatedAt. */
export function sidebarActivityMs(thread: {
  readonly createdAt: string;
  readonly latestUserMessageAt: string | null;
  readonly unsettledAt?: string | null;
}): number {
  // updatedAt moves on renames and group moves, which must not reorder rows.
  const base =
    timestampMsOrNull(thread.latestUserMessageAt) ??
    timestampMsOrNull(thread.createdAt) ??
    Number.NEGATIVE_INFINITY;
  const unsettled = timestampMsOrNull(thread.unsettledAt);
  return unsettled === null ? base : Math.max(base, unsettled);
}

const SIDEBAR_THREAD_STATUS_URGENCY: readonly SidebarThreadStatus[] = [
  "approval",
  "input",
  "failed",
  "working",
  "waiting",
  "limited",
  "ready",
];

/** Most urgent member status; null when there are no members. */
export function resolveThreadGroupStatus(
  members: ReadonlyArray<SidebarThreadStatusInput>,
): SidebarThreadStatus | null {
  let best: number | null = null;
  for (const member of members) {
    const rank = SIDEBAR_THREAD_STATUS_URGENCY.indexOf(resolveSidebarThreadStatus(member));
    if (best === null || rank < best) best = rank;
  }
  return best === null ? null : SIDEBAR_THREAD_STATUS_URGENCY[best]!;
}

export type SidebarGroupSection = "pinned" | "active" | "snoozed" | "settled";

/** The group's settle stamp while it still holds: null once any member has been
 * used, unsettled or set active since it was stamped. Labels and sorting use it too. */
export function groupSettleStampMs(
  group: Pick<EnvironmentThreadGroup, "settledAt">,
  members: ReadonlyArray<
    Parameters<typeof sidebarActivityMs>[0] & {
      readonly settledOverride: "settled" | "active" | null;
    }
  >,
): number | null {
  const stampedAt = timestampMsOrNull(group.settledAt);
  if (stampedAt === null) return null;
  return members.every(
    (member) => member.settledOverride !== "active" && sidebarActivityMs(member) <= stampedAt,
  )
    ? stampedAt
    : null;
}

/** Snoozed › settled › pinned › active. A group is settled when every member is
 * settled, or when it is stamped and no member has been unsettled or used since. */
export function resolveSidebarGroupSection(input: {
  readonly group: Pick<EnvironmentThreadGroup, "pinnedAt" | "snoozedUntil" | "settledAt">;
  readonly members: ReadonlyArray<
    Parameters<typeof sidebarActivityMs>[0] & {
      readonly settledOverride: "settled" | "active" | null;
    }
  >;
  readonly now: string;
}): SidebarGroupSection {
  const snoozedUntil = timestampMsOrNull(input.group.snoozedUntil);
  const now = timestampMsOrNull(input.now);
  if (snoozedUntil !== null && now !== null && snoozedUntil > now) return "snoozed";
  if (
    groupSettleStampMs(input.group, input.members) !== null ||
    (input.members.length > 0 &&
      input.members.every((member) => member.settledOverride === "settled"))
  ) {
    return "settled";
  }
  if (input.group.pinnedAt !== null) return "pinned";
  return "active";
}

/** Resolve each visible thread to its group, or to null when ungrouped/unknown. */
export function partitionThreadsByGroup<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly projectId: string;
    readonly groupId: ThreadGroupId | null;
  },
>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly groups: ReadonlyMap<string, EnvironmentThreadGroup>;
}): {
  readonly ungrouped: ReadonlyArray<T>;
  readonly byGroup: ReadonlyMap<string, ReadonlyArray<T>>;
} {
  const ungrouped: T[] = [];
  const members = new Map<string, T[]>();
  for (const thread of input.threads) {
    if (thread.groupId === null) {
      ungrouped.push(thread);
      continue;
    }
    const key = threadGroupKey({ environmentId: thread.environmentId, groupId: thread.groupId });
    const group = input.groups.get(key);
    // An unknown group, one from another project, or a hidden group (one
    // live chat) never hides the chat: it places itself by its own state.
    if (group === undefined || !group.visible || group.projectId !== thread.projectId) {
      ungrouped.push(thread);
      continue;
    }
    const list = members.get(key) ?? [];
    list.push(thread);
    members.set(key, list);
  }
  const byGroup = new Map<string, ReadonlyArray<T>>();
  for (const [key, list] of members) {
    const ranks = new Map(input.groups.get(key)!.threadIds.map((id, index) => [id, index]));
    byGroup.set(
      key,
      list
        .map((thread, index) => ({ thread, index }))
        .toSorted(
          (left, right) =>
            (ranks.get(left.thread.id) ?? Number.POSITIVE_INFINITY) -
              (ranks.get(right.thread.id) ?? Number.POSITIVE_INFINITY) || left.index - right.index,
        )
        .map((entry) => entry.thread),
    );
  }
  return { ungrouped, byGroup };
}

export type SidebarTreeEntry<T> =
  | { readonly kind: "project-heading"; readonly projectKey: string }
  | {
      readonly kind: "group";
      readonly groupKey: string;
      readonly group: EnvironmentThreadGroup;
      readonly members: ReadonlyArray<T>;
    }
  | { readonly kind: "thread"; readonly thread: T; readonly groupKey: string | null };

type SidebarActivityInput = Parameters<typeof sidebarActivityMs>[0];

/** Active tree: projects by newest item, then their groups and ungrouped chats by activity.
 *  Group members follow their group row only when the group is expanded. */
export function buildSidebarActiveTree<T extends SidebarActivityInput>(input: {
  readonly ungrouped: ReadonlyArray<T>;
  readonly groups: ReadonlyArray<{
    readonly key: string;
    readonly group: EnvironmentThreadGroup;
    readonly members: ReadonlyArray<T>;
  }>;
  readonly projectKeyOf: (item: T | EnvironmentThreadGroup) => string;
  readonly isExpanded: (groupKey: string) => boolean;
}): ReadonlyArray<SidebarTreeEntry<T>> {
  type Node =
    | { readonly kind: "thread"; readonly thread: T; readonly activity: number }
    | {
        readonly kind: "group";
        readonly key: string;
        readonly group: EnvironmentThreadGroup;
        readonly members: ReadonlyArray<T>;
        readonly activity: number;
      };
  const projects = new Map<string, { nodes: Node[]; activity: number }>();
  const add = (projectKey: string, node: Node) => {
    const project = projects.get(projectKey) ?? { nodes: [], activity: Number.NEGATIVE_INFINITY };
    project.nodes.push(node);
    project.activity = Math.max(project.activity, node.activity);
    projects.set(projectKey, project);
  };
  for (const thread of input.ungrouped) {
    add(input.projectKeyOf(thread), {
      kind: "thread",
      thread,
      activity: sidebarActivityMs(thread),
    });
  }
  for (const { key, group, members } of input.groups) {
    // A group with no visible member renders nothing.
    if (members.length === 0) continue;
    const activity = Math.max(...members.map(sidebarActivityMs));
    add(input.projectKeyOf(group), { kind: "group", key, group, members, activity });
  }
  const entries: SidebarTreeEntry<T>[] = [];
  const byActivity = <N extends { readonly activity: number }>(left: N, right: N) =>
    right.activity - left.activity;
  for (const [projectKey, project] of [...projects].toSorted(([, left], [, right]) =>
    byActivity(left, right),
  )) {
    entries.push({ kind: "project-heading", projectKey });
    for (const node of project.nodes.toSorted(byActivity)) {
      if (node.kind === "thread") {
        entries.push({ kind: "thread", thread: node.thread, groupKey: null });
        continue;
      }
      entries.push({ kind: "group", groupKey: node.key, group: node.group, members: node.members });
      if (!input.isExpanded(node.key)) continue;
      for (const member of node.members) {
        entries.push({ kind: "thread", thread: member, groupKey: node.key });
      }
    }
  }
  return entries;
}

/**
 * Whether a group row shows its chats. Active and Pinned groups follow the
 * persisted choice. A group parked in Snoozed or Settled starts collapsed
 * whatever it was in Active; only the open chat's group may show open there,
 * and a toggle made there (`parkedOverride`) lasts for the session only.
 */
export function resolveSidebarGroupExpanded(input: {
  readonly groupKey: string;
  readonly parked: boolean;
  readonly persisted: boolean;
  readonly parkedOverride: boolean | undefined;
  readonly routeGroupKey: string | null;
}): boolean {
  if (!input.parked) return input.persisted;
  return input.parkedOverride ?? (input.groupKey === input.routeGroupKey && input.persisted);
}

/** The group holding the routed chat; entering it opens it once. */
export function resolveForcedOpenGroupKey(input: {
  readonly routeThreadKey: string | null;
  readonly groupKeyByThreadKey: ReadonlyMap<string, string>;
}): string | null {
  if (input.routeThreadKey === null) return null;
  return input.groupKeyByThreadKey.get(input.routeThreadKey) ?? null;
}

export type SidebarV2TopStatusKind =
  | "approval"
  | "done"
  | "failed"
  | "limited"
  | "input"
  | "waiting"
  | "woke"
  | "working";

export function resolveSidebarV2TopStatus(input: {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
}): SidebarV2TopStatusKind | null {
  if (input.status === "working") {
    return "working";
  }
  if (input.status === "waiting") {
    return "waiting";
  }
  if (input.status === "approval") {
    return "approval";
  }
  if (input.status === "input") {
    return "input";
  }
  if (input.status === "failed" || input.status === "limited") {
    return input.status;
  }
  if (input.isWoke) {
    return "woke";
  }
  return input.isUnread ? "done" : null;
}

export function shouldShowSidebarV2Duration(status: SidebarThreadStatus): boolean {
  return status === "working";
}

/** First VALID timestamp wins: `a ?? b` falls through on null, but a present-
    yet-malformed string must also fall through to the next candidate rather
    than sink the row to the epoch. */
export function firstValidTimestampMs(
  ...candidates: ReadonlyArray<string | null | undefined>
): number {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

export { sortActiveThreadsByOrderKey as sortThreadsForSidebar } from "@t3tools/client-runtime/state/thread-sort";
// The Working section beta folds and orders the inbox the same way on mobile.
export {
  isThreadWorking as isSidebarThreadWorking,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "@t3tools/client-runtime/state/thread-inbox";

// Pinned-reorder key math and the keyed sort live in client-runtime
// (state/thread-sort) so web and mobile compute identical pinned orders.
export { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
export { sortPinnedThreadsByOrderKey as sortPinnedThreadsForSidebar } from "@t3tools/client-runtime/state/thread-sort";

const EMPTY_CONTENT_MATCH_KEYS: ReadonlySet<string> = new Set<string>();

/**
 * Search the already-ordered sidebar thread collection by title or linked PR,
 * plus any thread whose messages the server matched (`contentMatchKeys`, keyed
 * by `threadSearchMatchKey`). Keeping the input order means lifecycle ordering
 * (active, snoozed, settled) remains stable while the user narrows the list.
 */
export function searchSidebarThreads<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly title: string;
  } & Parameters<typeof threadPullRequestSearchTerms>[0],
>(
  threads: readonly T[],
  query: string,
  contentMatchKeys: ReadonlySet<string> = EMPTY_CONTENT_MATCH_KEYS,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return [];
  const titleMatches: T[] = [];
  const contentMatches: T[] = [];
  for (const thread of threads) {
    const matchesTitle = [thread.title, ...threadPullRequestSearchTerms(thread)].some((term) =>
      term.toLowerCase().includes(normalizedQuery),
    );
    if (matchesTitle) {
      titleMatches.push(thread);
    } else if (
      contentMatchKeys.size > 0 &&
      contentMatchKeys.has(
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      )
    ) {
      contentMatches.push(thread);
    }
  }
  return [...titleMatches, ...contentMatches];
}

/**
 * Whether a PR's search terms contain every whitespace-separated token of the
 * query. Search results use this to pick the PR number to show, so it has to
 * accept the multi-token queries the command palette matches on.
 */
export function pullRequestMatchesSearchQuery(
  pullRequest: Parameters<typeof threadPullRequestSearchTerms>[0],
  query: string,
): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return false;
  const haystack = normalizeSearchText(threadPullRequestSearchTerms(pullRequest).join(" "));
  return normalizedQuery.split(" ").every((token) => haystack.includes(token));
}

export function filterSidebarProjectScopeItems<TItem extends { readonly value: string }>(input: {
  items: readonly TItem[];
  query: string;
  matches: (item: TItem, query: string) => boolean;
}): readonly TItem[] {
  const query = input.query.trim();
  if (query.length === 0) return input.items;
  return input.items.filter((item) => item.value !== "all" && input.matches(item, query));
}

export interface SidebarProjectScopeMenuState {
  readonly open: boolean;
  readonly query: string;
}

export type SidebarProjectScopeMenuAction =
  | { readonly type: "query-changed"; readonly query: string }
  | { readonly type: "open-changed"; readonly open: boolean }
  | { readonly type: "project-settings-opened" };

export function reduceSidebarProjectScopeMenuState(
  state: SidebarProjectScopeMenuState,
  action: SidebarProjectScopeMenuAction,
): SidebarProjectScopeMenuState {
  switch (action.type) {
    case "query-changed":
      return { ...state, query: action.query };
    case "open-changed":
      return { open: action.open, query: "" };
    case "project-settings-opened":
      return { open: false, query: "" };
  }
}

/** The timestamp a working thread's elapsed label counts from: when its
    current work started (request time until adoption). Background wakes do
    not reset it. Malformed timestamps fall through to the next candidate. */
export function resolveWorkingStartedAt(
  thread: Pick<SidebarThreadSummary, "latestRun" | "runtime">,
): string | null {
  return resolveThreadWorkingStartedAt(thread);
}

export function formatWorkingDurationLabel(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
}): ThreadStatusPill | null {
  const { thread } = input;

  if (thread.hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if (thread.runtime?.status === "running" || thread.runtime?.status === "waiting") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (
    thread.runtime?.status === "preparing" ||
    thread.runtime?.status === "starting" ||
    thread.runtime?.status === "queued"
  ) {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])) {
    return {
      label: "Waiting",
      colorClass: "text-sidebar-muted-foreground",
      dotClass: "bg-sidebar-muted-foreground",
      pulse: false,
    };
  }

  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestRunSettled(thread.latestRun, thread.runtime) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

export function getFallbackThreadIdAfterDelete<
  T extends Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreads(
      threads.filter(
        (thread) =>
          thread.projectId === deletedThread.projectId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}
export function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly ThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }

  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
}

function sortProjectsByActivity<TProject extends SidebarProject>(
  projects: readonly TProject[],
  sortOrder: SidebarProjectSortOrder,
  getProjectThreads: (project: TProject) => readonly ThreadSortInput[],
  compareTies: (left: TProject, right: TProject) => number,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  // Each project's timestamp walks all of its threads, so compute it once
  // per project instead of once per comparison.
  return projects
    .map((project) => ({
      project,
      timestamp: getProjectSortTimestamp(project, getProjectThreads(project), sortOrder),
    }))
    .sort((left, right) => {
      const byTimestamp =
        right.timestamp === left.timestamp ? 0 : right.timestamp > left.timestamp ? 1 : -1;
      return byTimestamp || compareTies(left.project, right.project);
    })
    .map(({ project }) => project);
}

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TThread extends Pick<Thread, "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const threadsByProjectId = new Map<string, TThread[]>();
  for (const thread of threads) {
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProjectId.get(project.id) ?? [],
    (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
  );
}

export function sortLogicalProjectsForSidebar<
  TProject extends LogicalSidebarProject,
  TThread extends ScopedSidebarThread,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const groupKeyByProjectRef = new Map(
    projects.flatMap((project) =>
      project.memberProjectRefs.map(
        (projectRef) =>
          [`${projectRef.environmentId}\0${projectRef.projectId}`, project.projectKey] as const,
      ),
    ),
  );
  const threadsByProjectKey = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const projectKey = groupKeyByProjectRef.get(`${thread.environmentId}\0${thread.projectId}`);
    if (!projectKey) continue;
    const existing = threadsByProjectKey.get(projectKey);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByProjectKey.set(projectKey, [thread]);
    }
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProjectKey.get(project.projectKey) ?? [],
    (left, right) =>
      left.title.localeCompare(right.title) || left.projectKey.localeCompare(right.projectKey),
  );
}

export function sortSidebarV2ProjectGroups<
  TProject extends LogicalSidebarProject,
  TThread extends ScopedSidebarThread & Pick<SidebarThreadSummary, "lineage">,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  return sortLogicalProjectsForSidebar(
    projects,
    filterSidebarV2VisibleThreads(threads, null),
    sortOrder,
  );
}

/**
 * Sorts the cross-environment project collection used by landing surfaces.
 * Project ids are only unique within an environment, and archived threads
 * must not make a project appear recently active.
 */
export function sortScopedProjectsForSidebar<
  TProject extends ScopedSidebarProject,
  TThread extends ScopedSidebarThread,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const scopedKey = (environmentId: string, projectId: string) =>
    `${environmentId}\u0000${projectId}`;
  const threadsByProject = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) {
      continue;
    }
    const key = scopedKey(thread.environmentId, thread.projectId);
    const existing = threadsByProject.get(key) ?? [];
    existing.push(thread);
    threadsByProject.set(key, existing);
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProject.get(scopedKey(project.environmentId, project.id)) ?? [],
    (left, right) =>
      left.title.localeCompare(right.title) ||
      left.environmentId.localeCompare(right.environmentId) ||
      left.id.localeCompare(right.id),
  );
}
