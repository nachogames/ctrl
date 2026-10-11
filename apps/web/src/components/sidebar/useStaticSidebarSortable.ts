import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties } from "react";

import { animateSidebarLayoutChanges } from "../Sidebar.logic";

/**
 * Structural sidebar rows (project headings, group rows) sit in the one
 * sortable list so the drag preview can move them and measure their rects,
 * but they are never picked up.
 */
export function useStaticSidebarSortable(id: string): {
  readonly setNodeRef: (node: HTMLElement | null) => void;
  readonly style: CSSProperties;
} {
  const { setNodeRef, transform, transition } = useSortable({
    id,
    disabled: { draggable: true },
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  return {
    setNodeRef,
    style: {
      transform: CSS.Translate.toString(transform),
      transition,
      visibility: transform?.scaleY === 0 ? "hidden" : undefined,
    },
  };
}
