import type { ThreadGroupRunningResource } from "@t3tools/contracts";

export const RUNNING_FOOTNOTE = "Started by chats in this group. Keeps running across handoffs.";

export interface RunningRowView {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  /** Scanned resources are live (green); registered ones are only remembered (grey). */
  readonly tone: "running" | "registered";
  /** Where the open button goes, or null when the resource has no web address. */
  readonly openUrl: string | null;
  /** The stored manual resource id, set only for rows that can be removed. */
  readonly manualId: string | null;
}

const MANUAL_ID_PREFIX = "manual:";

function webUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function runningRowView(resource: ThreadGroupRunningResource): RunningRowView {
  const manual = resource.kind === "manual";
  return {
    id: resource.id,
    name: resource.name,
    detail: resource.detail,
    tone: manual ? "registered" : "running",
    openUrl: webUrl(resource.url),
    manualId:
      manual && resource.id.startsWith(MANUAL_ID_PREFIX)
        ? resource.id.slice(MANUAL_ID_PREFIX.length)
        : null,
  };
}
