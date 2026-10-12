import { memo, useCallback, type MouseEvent as ReactMouseEvent } from "react";

import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { useStaticSidebarSortable } from "./useStaticSidebarSortable";

/**
 * A project's heading in the Active tree: favicon and name, muted. It is a
 * label, not a control; its context menu only scopes the list to the project.
 */
export const SidebarProjectHeading = memo(function SidebarProjectHeading(props: {
  sortableId: string;
  projectKey: string;
  project: ProjectFaviconProject | null;
  displayName: string;
  onContextMenu: (projectKey: string, position: { x: number; y: number }) => void;
}) {
  const { onContextMenu, projectKey } = props;
  const { setNodeRef, style } = useStaticSidebarSortable(props.sortableId);
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(projectKey, { x: event.clientX, y: event.clientY });
    },
    [onContextMenu, projectKey],
  );
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid="sidebar-project-heading"
      className="list-none"
      style={style}
    >
      {/* 28px tall; the drag preview reserves exactly that. Content sits low so
          the space above separates it from the previous project. */}
      <div
        className="flex h-7 items-end gap-2 px-2.5 pb-1 text-xs text-sidebar-muted-foreground select-none"
        onContextMenu={handleContextMenu}
      >
        {props.project ? (
          <ProjectFavicon project={props.project} className="size-3.5 shrink-0" />
        ) : null}
        <span className="min-w-0 truncate">{props.displayName}</span>
      </div>
    </li>
  );
});
