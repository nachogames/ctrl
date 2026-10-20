import type {
  EnvironmentThreadGroup,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { ChevronRightIcon, LayersIcon, PlusIcon, SquarePenIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSharedPullRequestSummary } from "~/state/pullRequests";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  resolvePullRequestReviewOutcome,
  resolvePullRequestState,
} from "../pullRequest/pullRequestPresentation";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import {
  compactSidebarTimeLabel,
  resolveThreadGroupStatus,
  groupSettleStampMs,
  sidebarActivityMs,
  type SidebarGroupSection,
  type SidebarThreadStatus,
} from "../Sidebar.logic";
import { snoozeWakeLabel } from "../Sidebar.snooze";
import { useStaticSidebarSortable } from "./useStaticSidebarSortable";

export const SIDEBAR_LIFTED_ROW_CLASS =
  "bg-sidebar bg-linear-to-b from-sidebar-row-active to-sidebar-row-active text-sidebar-foreground shadow-lg";

// Same hues as the thread status pills (amber approval, indigo input, sky working).
const STATUS_DOT: Partial<Record<SidebarThreadStatus, { label: string; className: string }>> = {
  approval: { label: "Needs approval", className: "bg-amber-500 dark:bg-amber-300/90" },
  input: { label: "Needs input", className: "bg-indigo-500 dark:bg-indigo-300/90" },
  failed: { label: "Failed", className: "bg-error" },
  working: { label: "Working", className: "bg-sky-500 dark:bg-sky-300/80" },
};

function relativeLabel(ms: number): string {
  return Number.isFinite(ms)
    ? compactSidebarTimeLabel(formatRelativeTimeLabel(new Date(ms).toISOString()))
    : "";
}

/**
 * `#412`, coloured by state: open green, merged purple, closed and draft grey.
 * An open one shows its review outcome instead: approved, or changes requested.
 */
function GroupPullRequestNumber(props: { group: EnvironmentThreadGroup }) {
  const link = props.group.pullRequest;
  const reference = useMemo(
    () =>
      link === null
        ? null
        : {
            projectId: props.group.projectId,
            host: link.host,
            repository: link.repository,
            number: link.number,
          },
    [link, props.group.projectId],
  );
  const shared = useSharedPullRequestSummary(props.group.environmentId, reference, null);
  if (link === null) return null;
  const status = link.snapshot ?? shared;
  const presentation =
    status === null
      ? null
      : resolvePullRequestState({ state: status.state, isDraft: status.isDraft ?? false });
  const review =
    status?.state === "open" && status.isDraft !== true
      ? resolvePullRequestReviewOutcome(status.reviewDecision)
      : null;
  const Icon = review?.Icon ?? presentation?.Icon ?? PullRequestGlyph.pullRequest;
  const tone =
    review?.toneClassName ??
    (presentation === null || status?.state === "closed" || presentation.label === "Draft"
      ? "text-muted-foreground"
      : presentation.toneClassName);
  const label = [
    `Pull request #${link.number}`,
    presentation?.label,
    review?.label ??
      (status?.state === "open" && status.reviewDecision === "review-required"
        ? "Awaiting review"
        : undefined),
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn("inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums", tone)}
          />
        }
      >
        <Icon aria-hidden className="size-3" />
        <span>
          <span className="sr-only">{label}</span>
          <span aria-hidden>{link.number}</span>
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Inline rename, same keys as a thread title: Enter saves, Escape cancels, blur saves. */
function GroupTitleInput(props: {
  groupKey: string;
  title: string;
  onCommit: (groupKey: string, title: string) => void;
  onCancel: () => void;
}) {
  const { groupKey, onCancel, onCommit } = props;
  // Mounted only while renaming, so the draft seeds from the title once.
  const [draft, setDraft] = useState(props.title);
  const committedRef = useRef(false);
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        event.preventDefault();
        committedRef.current = true;
        onCommit(groupKey, draft);
      } else if (event.key === "Escape") {
        event.preventDefault();
        committedRef.current = true;
        onCancel();
      }
    },
    [draft, groupKey, onCancel, onCommit],
  );
  const handleBlur = useCallback(() => {
    if (!committedRef.current) onCommit(groupKey, draft);
  }, [draft, groupKey, onCommit]);
  return (
    <input
      autoFocus
      value={draft}
      aria-label="Group title"
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      onClick={(event) => event.stopPropagation()}
      className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
    />
  );
}

/**
 * A chat group: one 32px line that toggles its members open. It is not a
 * navigation target; its context menu holds the group actions, its + starts
 * a new chat in the group, and in Active it drags to rearrange.
 */
export const SidebarGroupRow = memo(function SidebarGroupRow(props: {
  sortableId: string;
  groupKey: string;
  group: EnvironmentThreadGroup;
  members: ReadonlyArray<EnvironmentThreadShell>;
  section: SidebarGroupSection;
  expanded: boolean;
  draggable: boolean;
  isRenaming: boolean;
  onToggle: (groupKey: string, expanded: boolean) => void;
  onNewChat: (groupKey: string) => void;
  onContextMenu: (groupKey: string, position: { x: number; y: number }) => void;
  onCommitRename: (groupKey: string, title: string) => void;
  onCancelRename: () => void;
}) {
  const { expanded, group, groupKey, members, onCancelRename, onCommitRename, onContextMenu } =
    props;
  const { onNewChat, onToggle } = props;
  const { setNodeRef, style, listeners, isDragging } = useStaticSidebarSortable(props.sortableId, {
    draggable: props.draggable,
  });
  const status = resolveThreadGroupStatus(members);
  const dot = status === null ? undefined : STATUS_DOT[status];
  const newestActivityMs = members.reduce(
    (newest, member) => Math.max(newest, sidebarActivityMs(member)),
    Number.NEGATIVE_INFINITY,
  );
  const settleStampMs = groupSettleStampMs(group, members);
  const timeLabel =
    props.section === "snoozed" && group.snoozedUntil !== null
      ? snoozeWakeLabel(group.snoozedUntil, { now: new Date().toISOString() })
      : props.section === "settled" && settleStampMs !== null
        ? relativeLabel(settleStampMs)
        : relativeLabel(newestActivityMs);
  const countLabel = `${members.length} ${members.length === 1 ? "chat" : "chats"}`;

  const toggle = useCallback(() => onToggle(groupKey, !expanded), [expanded, groupKey, onToggle]);
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle();
    },
    [toggle],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(groupKey, { x: event.clientX, y: event.clientY });
    },
    [groupKey, onContextMenu],
  );

  const parked = props.section === "settled" || props.section === "snoozed";
  return (
    <li
      ref={setNodeRef}
      data-sidebar-item={props.sortableId}
      data-sidebar-item-inset={6}
      data-thread-selection-safe
      data-testid="sidebar-group-row"
      className="list-none"
      style={style}
    >
      <div
        {...listeners}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${group.title}, group of ${countLabel}${dot ? `, ${dot.label}` : ""}`}
        className={cn(
          "group/sidebar-group flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-sm outline-none select-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          parked ? "text-secondary-label hover:text-sidebar-foreground" : "text-sidebar-foreground",
          // Lifted like a dragged chat: opaque, so rows passing beneath never show through.
          isDragging && SIDEBAR_LIFTED_ROW_CLASS,
        )}
        onClick={toggle}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
      >
        {/* Rotates on toggle only; nothing repaints at rest. */}
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
            expanded && "rotate-90",
          )}
        />
        <LayersIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        {props.isRenaming ? (
          <GroupTitleInput
            groupKey={groupKey}
            title={group.title}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate font-medium">{group.title}</span>
        )}
        <GroupPullRequestNumber group={group} />
        <SidebarGroupNewChatButton title={group.title} onClick={() => onNewChat(groupKey)} />
        <span className="ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end text-xs text-secondary-label tabular-nums">
          {/* On hover a collapsed group trades its time for its chat count;
              a status dot stays beside it. */}
          {dot ? null : (
            <span className={cn(!expanded && "group-hover/sidebar-group:hidden")}>{timeLabel}</span>
          )}
          {expanded ? null : (
            <span className="hidden group-hover/sidebar-group:inline">{countLabel}</span>
          )}
          {dot ? (
            <span
              role="img"
              aria-label={dot.label}
              className="flex size-4 items-center justify-center"
            >
              <span className={cn("size-1.5 rounded-full", dot.className)} />
            </span>
          ) : null}
        </span>
      </div>
    </li>
  );
});

/** The group header's "+": a new chat that joins this group on its first send. */
export function SidebarGroupNewChatButton(props: { title: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`New chat in ${props.title}`}
            onClick={(event) => {
              event.stopPropagation();
              props.onClick();
            }}
            // A press on the button must not start a drag of the row.
            onPointerDown={(event) => event.stopPropagation()}
            // Takes no room at rest, so the PR number sits beside the time.
            className="hidden size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-sidebar-row-active hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-focus-within/sidebar-group:inline-flex group-hover/sidebar-group:inline-flex group-focus-within/sidebar-row:inline-flex group-any-hover/sidebar-row:inline-flex"
          />
        }
      >
        <PlusIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">New chat in group</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The open "+ New chat in group" draft, shown as the last chat of its group
 * so the composer's chat is plainly a new one in that group.
 */
export function SidebarGroupDraftRow(props: { groupTitle: string }) {
  return (
    <li data-thread-selection-safe className="list-none">
      <div
        aria-current="page"
        aria-label={`New chat in ${props.groupTitle}`}
        className="flex h-9 w-full items-center rounded-md bg-sidebar-row-active px-2.5 pl-6 text-sm text-sidebar-foreground select-none"
      >
        <span className="flex h-full min-w-0 flex-1 items-center gap-2.5 border-l border-sidebar-border pl-5">
          <SquarePenIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">New chat</span>
        </span>
      </div>
    </li>
  );
}
