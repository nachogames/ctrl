import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties } from "react";

import { animateSidebarLayoutChanges } from "../Sidebar.logic";

/**
 * Structural sidebar rows (project headings, group rows) sit in the one
 * sortable list so the drag preview can move them and measure their rects.
 * Active-tree headings and group rows can be picked up to rearrange the
 * tree; others never are.
 */
export function useStaticSidebarSortable(
  id: string,
  options: { readonly draggable?: boolean } = {},
): {
  readonly setNodeRef: (node: HTMLElement | null) => void;
  readonly style: CSSProperties;
  readonly listeners: ReturnType<typeof useSortable>["listeners"];
  readonly isDragging: boolean;
} {
  const { setNodeRef, transform, transition, listeners, isDragging } = useSortable({
    id,
    disabled: { draggable: options.draggable !== true },
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  return {
    setNodeRef,
    listeners: options.draggable === true ? listeners : undefined,
    isDragging,
    style: {
      transform: CSS.Translate.toString(transform),
      transition,
      visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      ...(isDragging ? { position: "relative", zIndex: 20 } : {}),
    },
  };
}
