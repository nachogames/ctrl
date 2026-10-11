import type {
  EnvironmentThreadGroup,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { ChevronRightIcon, LayersIcon, PlusIcon } from "lucide-react";
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
import { useSharedPullRequestSummary } from "~/state/pullRequests";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import {
  compactSidebarTimeLabel,
  resolveThreadGroupStatus,
  sidebarActivityMs,
  type SidebarGroupSection,
  type SidebarThreadStatus,
} from "../Sidebar.logic";
import { snoozeWakeLabel } from "../Sidebar.snooze";
import { useStaticSidebarSortable } from "./useStaticSidebarSortable";

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

/** `#412`, coloured by state: open green, merged purple, closed and draft grey. */
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
  const Icon = presentation?.Icon ?? PullRequestGlyph.pullRequest;
  const tone =
    presentation === null || status?.state === "closed" || presentation.label === "Draft"
      ? "text-muted-foreground"
      : presentation.toneClassName;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums", tone)}>
      <Icon aria-hidden className="size-3" />
      <span>
        <span className="sr-only">Pull request </span>
        {link.number}
      </span>
    </span>
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
 * navigation target; its context menu holds the group actions.
 */
export const SidebarGroupRow = memo(function SidebarGroupRow(props: {
  sortableId: string;
  groupKey: string;
  group: EnvironmentThreadGroup;
  members: ReadonlyArray<EnvironmentThreadShell>;
  section: SidebarGroupSection;
  expanded: boolean;
  isRenaming: boolean;
  onToggle: (groupKey: string, expanded: boolean) => void;
  onContextMenu: (groupKey: string, position: { x: number; y: number }) => void;
  onCommitRename: (groupKey: string, title: string) => void;
  onCancelRename: () => void;
}) {
  const { expanded, group, groupKey, members, onCancelRename, onCommitRename, onContextMenu } =
    props;
  const { onToggle } = props;
  const { setNodeRef, style } = useStaticSidebarSortable(props.sortableId);
  const status = resolveThreadGroupStatus(members);
  const dot = status === null ? undefined : STATUS_DOT[status];
  const newestActivityMs = members.reduce(
    (newest, member) => Math.max(newest, sidebarActivityMs(member)),
    Number.NEGATIVE_INFINITY,
  );
  const timeLabel =
    props.section === "snoozed" && group.snoozedUntil !== null
      ? snoozeWakeLabel(group.snoozedUntil, { now: new Date().toISOString() })
      : props.section === "settled" && group.settledAt !== null
        ? relativeLabel(Date.parse(group.settledAt))
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
      data-thread-selection-safe
      // An expanded group opens a block that its "New chat" row closes.
      data-sidebar-group-block={expanded ? "" : undefined}
      data-testid="sidebar-group-row"
      className="list-none"
      style={style}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${group.title}, group of ${countLabel}${dot ? `, ${dot.label}` : ""}`}
        className={cn(
          "group/sidebar-group flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-sm outline-none select-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          parked ? "text-secondary-label hover:text-sidebar-foreground" : "text-sidebar-foreground",
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

/**
 * "+ New chat in group", the last child of an expanded group. Its space is
 * always reserved so the list never shifts; it fades in while a row of its
 * group is hovered (the `group-block-hover` variant) or it has focus.
 */
export const SidebarGroupNewChatRow = memo(function SidebarGroupNewChatRow(props: {
  groupKey: string;
  onNewChat: (groupKey: string) => void;
}) {
  const { groupKey, onNewChat } = props;
  return (
    <li
      data-thread-selection-safe
      data-sidebar-group-new-chat
      className="list-none opacity-0 transition-opacity delay-100 duration-100 group-block-hover:opacity-100 group-block-hover:delay-0 motion-reduce:transition-none"
    >
      <button
        type="button"
        onClick={() => onNewChat(groupKey)}
        className="flex h-7 w-full cursor-pointer items-center rounded-md px-2.5 pl-6 text-left text-xs text-sidebar-muted-foreground/70 outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex h-full min-w-0 flex-1 items-center gap-2 border-l border-sidebar-border pl-5">
          <PlusIcon aria-hidden className="size-3.5 shrink-0" />
          New chat in group
        </span>
      </button>
    </li>
  );
});
