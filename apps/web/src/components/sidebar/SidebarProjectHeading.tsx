import { ChevronRightIcon, PlusIcon } from "lucide-react";
import {
  memo,
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { cn } from "~/lib/utils";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SIDEBAR_LIFTED_ROW_CLASS } from "./SidebarGroupRow";
import { useStaticSidebarSortable } from "./useStaticSidebarSortable";

/**
 * A project's heading in the Active tree: favicon and name, muted. Clicking
 * collapses or expands the project's rows; dragging moves the project; its
 * "+" starts a new chat in the project.
 */
export const SidebarProjectHeading = memo(function SidebarProjectHeading(props: {
  sortableId: string;
  projectKey: string;
  project: ProjectFaviconProject | null;
  displayName: string;
  collapsed: boolean;
  draggable: boolean;
  onToggleCollapsed: (projectKey: string, collapsed: boolean) => void;
  onNewChat: (projectKey: string) => void;
  onContextMenu: (projectKey: string, position: { x: number; y: number }) => void;
}) {
  const { collapsed, onContextMenu, onNewChat, onToggleCollapsed, projectKey } = props;
  const { setNodeRef, style, listeners, isDragging } = useStaticSidebarSortable(props.sortableId, {
    draggable: props.draggable,
  });
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(projectKey, { x: event.clientX, y: event.clientY });
    },
    [onContextMenu, projectKey],
  );
  const toggle = useCallback(
    () => onToggleCollapsed(projectKey, !collapsed),
    [collapsed, onToggleCollapsed, projectKey],
  );
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle();
    },
    [toggle],
  );
  return (
    <li
      ref={setNodeRef}
      data-sidebar-item={props.sortableId}
      data-sidebar-item-inset={8}
      data-thread-selection-safe
      data-testid="sidebar-project-heading"
      className="list-none"
      style={style}
    >
      {/* 28px tall; the drag preview reserves exactly that. Content sits low so
          the space above separates it from the previous project. */}
      <div
        {...listeners}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={`${props.displayName}, project`}
        className={cn(
          "group/project-heading flex h-7 cursor-pointer items-end gap-2 rounded-md px-2.5 pb-1 text-xs text-sidebar-muted-foreground outline-none select-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isDragging && SIDEBAR_LIFTED_ROW_CLASS,
        )}
        onClick={toggle}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
      >
        {props.project ? (
          <ProjectFavicon project={props.project} className="size-3.5 shrink-0" />
        ) : null}
        <span className="min-w-0 truncate">{props.displayName}</span>
        {/* Rotates on toggle only; shown while collapsed or hovered. */}
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "mb-px size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            !collapsed && "rotate-90 opacity-0 group-hover/project-heading:opacity-100",
          )}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`New chat in ${props.displayName}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onNewChat(projectKey);
                }}
                onKeyDown={(event) => event.stopPropagation()}
                // A press on the button must not start a drag of the project.
                onPointerDown={(event) => event.stopPropagation()}
                className="pointer-events-none ml-auto inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-row-hover hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-hover/project-heading:pointer-events-auto group-hover/project-heading:opacity-100"
              />
            }
          >
            <PlusIcon aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">New chat in {props.displayName}</TooltipPopup>
        </Tooltip>
      </div>
    </li>
  );
});
