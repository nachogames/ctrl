import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ThreadId } from "@t3tools/contracts";

import { formatElapsedDurationLabel } from "../../timestampFormat";
import { sidebarActivityMs, type SidebarThreadStatus } from "../Sidebar.logic";

type GroupChatSubtitleThread = Pick<
  EnvironmentThreadShell,
  "id" | "handedOffFrom" | "handedOffTo" | "createdAt" | "latestUserMessageAt" | "unsettledAt"
>;

/**
 * The one-line subtitle under a chat in the Group panel: how it relates to the
 * open chat and the handoff chain, else how long it has been idle.
 */
export function groupChatSubtitle(input: {
  thread: GroupChatSubtitleThread;
  currentThreadId: ThreadId | null;
  threadsById: ReadonlyMap<ThreadId, { readonly title: string }>;
  status: SidebarThreadStatus;
  now?: number;
}): string {
  const { thread } = input;
  if (thread.id === input.currentThreadId) return "this chat";
  const activityMs = sidebarActivityMs(thread);
  const elapsed = Number.isFinite(activityMs)
    ? formatElapsedDurationLabel(new Date(activityMs).toISOString(), input.now)
    : "";
  const since = elapsed === "" || elapsed === "just now" ? null : elapsed;
  if (thread.handedOffTo !== null) return since === null ? "handed off" : `handed off · ${since}`;
  if (thread.handedOffFrom !== null) {
    if (thread.handedOffFrom === input.currentThreadId) return "started from this chat";
    const source = input.threadsById.get(thread.handedOffFrom);
    if (source !== undefined) return `started from ${source.title}`;
  }
  // Only a chat at rest is idle; a busy one reports when it last moved.
  if (input.status !== "ready") return since === null ? "just now" : `${since} ago`;
  return since === null ? "idle" : `idle ${since}`;
}

export interface GroupStatusPill {
  label: string;
  colorClass: string;
}

// Same hues as `resolveThreadStatusPill` and the sidebar's group status dot.
const GROUP_STATUS_PILLS: Partial<Record<SidebarThreadStatus, GroupStatusPill>> = {
  approval: { label: "Approval", colorClass: "text-amber-600 dark:text-amber-300/90" },
  input: { label: "Needs input", colorClass: "text-indigo-600 dark:text-indigo-300/90" },
  failed: { label: "Failed", colorClass: "text-error" },
  working: { label: "Working", colorClass: "text-sky-600 dark:text-sky-300/80" },
  waiting: { label: "Waiting", colorClass: "text-muted-foreground" },
  limited: { label: "Usage limit", colorClass: "text-warning-foreground" },
};

/** The pill for a group or chat status; a chat at rest shows none. */
export function groupStatusPill(status: SidebarThreadStatus | null): GroupStatusPill | null {
  return status === null ? null : (GROUP_STATUS_PILLS[status] ?? null);
}

export interface InlineTextSegment {
  text: string;
  code: boolean;
  /** Offset in the source text; a stable key. */
  start: number;
}

/** Splits `code` spans out of plain text; an unmatched backtick stays literal. */
export function splitInlineCode(text: string): InlineTextSegment[] {
  const segments: InlineTextSegment[] = [];
  const pattern = /`([^`\n]+)`/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) {
      segments.push({ text: text.slice(cursor, match.index), code: false, start: cursor });
    }
    segments.push({ text: match[1]!, code: true, start: match.index });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), code: false, start: cursor });
  return segments;
}
