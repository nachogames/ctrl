import { closestCenter, type CollisionDetection, type Modifier } from "@dnd-kit/core";
import { verticalListSortingStrategy, type SortingStrategy } from "@dnd-kit/sortable";
import {
  resolveSidebarDropTarget,
  sidebarListItemId,
  type SidebarDropTarget,
  sidebarMarkerId,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
} from "./Sidebar.logic";

const stationary = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
const hidden = { ...stationary, scaleY: 0 };
type ThreadItem = Extract<SidebarListItem, { kind: "thread" }>;
// Matches sidebarListItemId for project headings.
const PROJECT_HEADING_ID_PREFIX = "sidebar-project-";
const isUngroupedThread = (item: SidebarListItem): item is ThreadItem =>
  item.kind === "thread" && (item.groupKey ?? null) === null;
type Layout = Parameters<SortingStrategy>[0];
const isShelfHeader = (item: SidebarListItem | undefined) =>
  item?.kind === "marker" &&
  (item.marker === "working-header" ||
    item.marker === "snoozed-header" ||
    item.marker === "settled-header");

/** Keep the lifted card below the Pins label, including when Pins is empty.
 * The container rect follows scrolling; the offset is measured once at pickup. */
export function restrictBelowSidebarLabel(
  { transform, containerNodeRect, draggingNodeRect }: Parameters<Modifier>[0],
  offset: number,
) {
  if (!containerNodeRect || !draggingNodeRect) return transform;
  const minimumY = containerNodeRect.top + offset - draggingNodeRect.top;
  return transform.y < minimumY ? { ...transform, y: minimumY } : transform;
}

/** Reject the nearest unsupported target without selecting another section.
 * Recreate this detector when drop eligibility changes. */
export function createSidebarCollisionDetection(
  isValidTarget: (id: string) => boolean,
  options: {
    items?: readonly SidebarListItem[];
    activationY?: number | null;
  } = {},
): CollisionDetection {
  const validity = new Map<string, boolean>();
  const sections = new Map<string, SidebarSection | null>();
  let previousPointerY = options.activationY;
  let boundarySection: "pinned" | "active" | undefined;
  return (args) => {
    let collisions = closestCenter(args);
    const pointer = args.pointerCoordinates;
    const items = options.items;
    const source = items?.find((item) => item.kind === "thread" && item.key === args.active.id);
    const boundary = args.droppableContainers
      .find((container) => container.id === sidebarMarkerId("pinned-divider"))
      ?.node.current?.querySelector(".sidebar-drag-boundary-label")
      ?.getBoundingClientRect();
    if (items && boundary && source?.kind === "thread" && pointer) {
      boundarySection ??= source.section === "pinned" ? "pinned" : "active";
      // Use the visible divider row, including its sortable translation.
      // Only pointer movement can change sections: opening the destination
      // moves this row, but must not toggle a stationary gesture back.
      const previousY = previousPointerY ?? pointer.y;
      previousPointerY = pointer.y;
      if (pointer.x >= boundary.left && pointer.x <= boundary.right) {
        if (pointer.y < previousY && pointer.y <= boundary.bottom) boundarySection = "pinned";
        else if (pointer.y > previousY && pointer.y >= boundary.top) boundarySection = "active";
        const nextHeader = (["working-header", "snoozed-header", "settled-header"] as const)
          .map((marker) =>
            args.droppableContainers.find((container) => container.id === sidebarMarkerId(marker)),
          )
          .find((container) => container !== undefined);
        const activeBottom = nextHeader?.node.current?.getBoundingClientRect().top;
        if (boundarySection === "pinned" || (activeBottom != null && pointer.y < activeBottom)) {
          const target = collisions.find((collision) => {
            const id = String(collision.id);
            if (!sections.has(id)) {
              sections.set(
                id,
                resolveSidebarDropTarget(items, String(args.active.id), id)?.section ?? null,
              );
            }
            return sections.get(id) === boundarySection;
          });
          if (target)
            collisions = [target, ...collisions.filter((collision) => collision !== target)];
        }
      }
    }
    const nearest = collisions[0];
    if (!nearest || nearest.id === args.active.id) {
      return collisions;
    }
    const id = String(nearest.id);
    const valid = validity.get(id) ?? isValidTarget(id);
    validity.set(id, valid);
    return valid ? collisions : collisions.filter((collision) => collision.id === args.active.id);
  };
}

/** Preview the committed section layout without moving or mounting DOM nodes.
 * A zero scaleY marks rows/markers to hide while retaining their measured nodes. */
export function createSidebarSortingStrategy(input: {
  items: readonly SidebarListItem[];
  /** Suspend the reorder preview while the thread is dragged out as context. */
  enabled?: boolean;
  settledOrder: readonly string[];
  /** Time-ordered inbox (Working beta): where the lifted row would land. */
  activeOrder?: readonly string[];
  settledExpanded: boolean;
  settledVisibleCount?: number;
  routeThreadKey?: string | null;
  snoozedThreadCount?: number;
  cardHeight?: number;
  slimHeight?: number;
  /** Space each pinned boundary opens for its label while dragging. The
   * markers stay zero height at rest, so nothing is reserved until pickup. */
  boundaryLabelHeight?: number;
  /** True while the hovered row is a drop target in itself (a group drop):
   * nothing moves, so the target stays under the pointer to be highlighted. */
  holdsLayout?: (activeId: string, overId: string) => boolean;
}): SortingStrategy {
  if (input.enabled === false) return () => stationary;
  const { items } = input;
  const indices = new Map(items.map((item, index) => [sidebarListItemId(item), index]));
  let previous: Pick<Layout, "rects" | "activeIndex" | "overIndex"> | undefined;
  let transforms: ReturnType<SortingStrategy>[] | null = [];

  function project({ rects, activeIndex, overIndex }: Layout) {
    const active = items[activeIndex];
    const over = items[overIndex] ?? active;
    if (active?.kind !== "thread" || !over || !rects[0]) return [];
    // A held layout keeps every row in its rest order, still opening the
    // boundary labels' space so they never sit on top of the rows below them.
    const held = input.holdsLayout?.(active.key, sidebarListItemId(over)) ?? false;
    const target = held
      ? null
      : resolveSidebarDropTarget(items, active.key, sidebarListItemId(over));
    if (!held && !target) return [];
    // Every non-marker row by section, in list order. Project headings belong
    // to Active; group rows and their members keep their section.
    const rows: Record<SidebarSection, SidebarListItem[]> = {
      pinned: [],
      active: [],
      working: [],
      snoozed: [],
      settled: [],
    };
    let cardHeight = input.cardHeight;
    let slimHeight = input.slimHeight;
    let activeHeight: number | undefined;
    let headerScale: number | undefined;
    for (const [index, item] of items.entries()) {
      if (item.kind === "marker") {
        if (isShelfHeader(item)) {
          const height = rects[index]?.height;
          if (height) headerScale ??= height / 32;
        }
        continue;
      }
      if (item.kind === "thread") {
        const height = rects[index]?.height;
        if (!isUngroupedThread(item)) slimHeight ??= height;
        else if (item.section === "pinned" || item.section === "working") cardHeight ??= height;
        else if (item.section === "active") activeHeight ??= height;
        else slimHeight ??= height;
        if (item.key === active.key) continue;
      }
      rows[item.kind === "project-heading" ? "active" : item.section].push(item);
    }
    // Cards are 4.875rem + 0.25rem padding; slim rows/placeholders are h-9.
    const scale =
      slimHeight !== undefined ? slimHeight / 36 : (headerScale ?? (cardHeight ?? 82) / 82);
    cardHeight ??= 82 * scale;
    slimHeight ??= 36 * scale;
    // Active tree rows are slim; a measured row wins.
    activeHeight ??= slimHeight;
    const labelHeight = (input.boundaryLabelHeight ?? 0) * scale;
    const projectSections = (target: SidebarDropTarget): SidebarListItem[] => {
      const moved: ThreadItem = { ...active, section: target.section };
      if (target.section === "active" && input.activeOrder !== undefined) {
        // A time-ordered Active section lands the row at its time slot.
        const byId = new Map(rows.active.map((item) => [sidebarListItemId(item), item] as const));
        rows.active = input.activeOrder.flatMap((id): SidebarListItem[] => {
          if (id === active.key) return [moved];
          const existing = byId.get(id);
          if (existing) return [existing];
          // A drop can open a project heading that is not rendered yet.
          return id.startsWith(PROJECT_HEADING_ID_PREFIX)
            ? [{ kind: "project-heading", key: id.slice(PROJECT_HEADING_ID_PREFIX.length) }]
            : [];
        });
      } else {
        const order =
          target.section === "pinned"
            ? target.pinnedOrder
            : target.section === "settled"
              ? input.settledOrder
              : (input.activeOrder ?? target.activeOrder);
        const ranks = new Map(order.map((key, index) => [key, index]));
        const rank = ranks.get(active.key) ?? Number.POSITIVE_INFINITY;
        // Only ungrouped chats are ranked; group rows and members stay above them.
        const list = rows[target.section];
        const index = list.findIndex(
          (item) =>
            isUngroupedThread(item) && (ranks.get(item.key) ?? Number.POSITIVE_INFINITY) > rank,
        );
        list.splice(index < 0 ? list.length : index, 0, moved);
      }
      // A heading whose last row left goes with it.
      rows.active = rows.active.filter(
        (item, index, list) =>
          item.kind !== "project-heading" ||
          (list[index + 1] !== undefined && list[index + 1]!.kind !== "project-heading"),
      );
      const settledOrder = (
        input.settledOrder.length > 0
          ? input.settledOrder
          : rows.settled.flatMap((item) => (isUngroupedThread(item) ? [item.key] : []))
      ).filter((key) => key !== active.key || target.section === "settled");
      const visible = input.settledExpanded
        ? settledOrder.slice(0, input.settledVisibleCount ?? settledOrder.length)
        : [];
      const routeKey = input.routeThreadKey;
      if (routeKey && settledOrder.includes(routeKey) && !visible.includes(routeKey)) {
        visible.push(routeKey);
      }
      rows.settled = [
        ...rows.settled.filter((item) => !isUngroupedThread(item)),
        ...visible.map((key): SidebarListItem => ({ kind: "thread", key, section: "settled" })),
      ];
      const projected: SidebarListItem[] = [];
      const marker = (name: SidebarListMarker) => projected.push({ kind: "marker", marker: name });
      const section = (name: "active" | "settled") => {
        if (rows[name].length > 0) projected.push(...rows[name]);
        else marker(`${name}-placeholder`);
      };
      marker("pinned-header");
      projected.push(...rows.pinned);
      marker("pinned-divider");
      section("active");
      if (items.some((item) => item.kind === "marker" && item.marker === "working-header")) {
        marker("working-header");
        projected.push(...rows.working);
      }
      if (
        rows.snoozed.length > 0 ||
        ((active.section !== "snoozed" || (input.snoozedThreadCount ?? 0) > 1) &&
          items.some((item) => item.kind === "marker" && item.marker === "snoozed-header"))
      ) {
        marker("snoozed-header");
        projected.push(...rows.snoozed);
      }
      marker("settled-header");
      section("settled");
      return projected;
    };
    const projected = target === null ? [...items] : projectSections(target);
    const fallbackHeight = (item: SidebarListItem) => {
      switch (item.kind) {
        case "project-heading":
          return 28 * scale;
        case "group":
          return 32 * scale;
        case "marker":
          return slimHeight;
        case "thread":
          if (!isUngroupedThread(item)) return slimHeight;
          if (item.section === "pinned" || item.section === "working") return cardHeight;
          return item.section === "active" ? activeHeight : slimHeight;
      }
    };
    const heights = projected.map((item) => {
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      const moved = item.kind === "thread" && item.key === active.key;
      return item.kind === "marker" &&
        (item.marker === "pinned-header" || item.marker === "pinned-divider")
        ? labelHeight
        : item.kind === "marker" && item.marker.endsWith("placeholder") && target !== null
          ? slimHeight
          : moved
            ? fallbackHeight(item)
            : (rect?.height ?? fallbackHeight(item));
    });
    const firstShelf = items.findIndex(isShelfHeader);
    // Unsortable rows such as a group's "New chat" row leave a gap after the
    // row they follow; it travels with that row.
    const gaps = projected.map((item) => {
      const index = indices.get(sidebarListItemId(item));
      if (index === undefined || index + 1 === firstShelf) return 0;
      const rect = rects[index];
      const next = rects[index + 1];
      if (!rect || !next) return 0;
      const gap = next.top - rect.bottom - 1;
      return gap > 2 ? gap : 0;
    });
    const shelfRect = rects[firstShelf];
    const beforeShelf = rects[firstShelf - 1];
    const lastRect = rects.at(-1);
    // Consume the shelf's auto margin as drag labels and resized rows need
    // room, keeping the combined shelves at their measured bottom.
    let shelfSpace =
      shelfRect && beforeShelf && lastRect && shelfRect.top > beforeShelf.bottom + 1
        ? Math.max(
            0,
            lastRect.bottom -
              rects[0].top -
              heights.reduce((sum, height, index) => sum + height + gaps[index]! + 1, -1),
          )
        : 0;
    const result = items.map(() => hidden);
    let top = rects[0].top;
    for (const [projectedIndex, item] of projected.entries()) {
      if (isShelfHeader(item)) {
        top += shelfSpace;
        shelfSpace = 0;
      }
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      if (index !== undefined && rect) result[index] = { ...stationary, y: top - rect.top };
      top += heights[projectedIndex]! + gaps[projectedIndex]! + 1;
    }
    result[activeIndex] = stationary;
    return result;
  }

  return (args) => {
    if (
      previous?.rects !== args.rects ||
      previous.activeIndex !== args.activeIndex ||
      previous.overIndex !== args.overIndex
    ) {
      previous = args;
      transforms = project(args);
    }
    return transforms === null
      ? verticalListSortingStrategy(args)
      : (transforms[args.index] ?? stationary);
  };
}
