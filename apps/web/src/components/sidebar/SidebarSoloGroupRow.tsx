import { ChevronRightIcon, LayersIcon } from "lucide-react";
import { type ReactNode } from "react";
import { cn } from "~/lib/utils";

/** A presentation-only group. Adding a second chat creates its durable membership. */
export function SidebarSoloGroupRow(props: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  onContextMenu: (position: { x: number; y: number }) => void;
  children: ReactNode;
}) {
  return (
    <li className="list-none" data-thread-selection-safe>
      <button
        type="button"
        aria-expanded={props.expanded}
        aria-label={`${props.title}, group of 1 chat`}
        onClick={props.onToggle}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu({ x: event.clientX, y: event.clientY });
        }}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-sm text-sidebar-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 shrink-0 text-muted-foreground", props.expanded && "rotate-90")}
        />
        <LayersIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{props.title}</span>
      </button>
      {props.expanded && <ul>{props.children}</ul>}
    </li>
  );
}
