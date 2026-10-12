import type {
  ProjectScript,
  ThreadGroupLink,
  ThreadGroupRunningResource,
} from "@t3tools/contracts";
import { loopbackPort, pullRequestTitleIssueLinks } from "@t3tools/shared/threadGroups";

import { formatElapsedDurationLabel } from "../../timestampFormat";
import type { SidebarThreadStatus } from "../Sidebar.logic";

export type GlanceTone = "default" | "muted" | "success" | "warning" | "merged";

/** One glance card; below 440px the same model is one compact row. */
export interface GlanceCard {
  readonly id: "branch" | "pull-request" | "tickets" | "frontend" | "worktree" | "activity";
  readonly title: string;
  readonly primary: string;
  readonly secondary: string | null;
  /** The compact row's right-hand text, which its action replaces on hover. */
  readonly compact: string | null;
  readonly tone: GlanceTone;
  readonly empty: boolean;
}

export interface TicketChip {
  readonly url: string;
  /** Where the chip links: the URL when it is http(s), else null and the chip is plain text. */
  readonly href: string | null;
  readonly label: string;
  /** The stored link, which can be removed; null for a ref read from the PR title. */
  readonly linkId: string | null;
}

export interface GroupActivity {
  readonly working: number;
  readonly idle: number;
  readonly lastActivityLabel: string | null;
}

export interface GlanceInput {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly vcs: {
    readonly ahead: number;
    readonly behind: number;
    readonly baseRef: string | null;
    readonly changedFiles: number;
  } | null;
  readonly pullRequest: {
    readonly number: number;
    readonly title: string | null;
    readonly state: "open" | "draft" | "merged" | "closed" | null;
    readonly checksText: string | null;
    readonly checksFailing: boolean;
    readonly signInRequired: boolean;
  } | null;
  readonly tickets: ReadonlyArray<TicketChip>;
  readonly frontend: {
    readonly scriptName: string;
    readonly port: number | null;
    readonly running: boolean;
  } | null;
  readonly activity: GroupActivity;
}

const STATE_LABEL = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" } as const;

const card = (
  id: GlanceCard["id"],
  title: string,
  fields: Partial<Omit<GlanceCard, "id" | "title">> & Pick<GlanceCard, "primary">,
): GlanceCard => ({
  id,
  title,
  secondary: null,
  compact: null,
  tone: "default",
  empty: false,
  ...fields,
});

function pullRequestTone(pr: NonNullable<GlanceInput["pullRequest"]>): GlanceTone {
  if (pr.state === "merged") return "merged";
  if (pr.state === "draft" || pr.state === "closed") return "muted";
  return pr.checksFailing ? "warning" : "default";
}

export function glanceCards(input: GlanceInput): ReadonlyArray<GlanceCard> {
  const { vcs, pullRequest: pr, frontend, activity } = input;
  const behind = vcs !== null && vcs.behind > 0 ? vcs.behind : null;
  return [
    input.branch === null
      ? card("branch", "Branch", { primary: "No branch", tone: "muted", empty: true })
      : card("branch", "Branch", {
          primary: input.branch,
          secondary:
            vcs === null
              ? null
              : `${vcs.ahead} ahead${vcs.baseRef === null ? "" : ` of ${vcs.baseRef}`}${behind === null ? "" : ` · ${behind} behind upstream`}`,
          compact: vcs === null ? null : `${vcs.ahead}↑${behind === null ? "" : ` ${behind}↓`}`,
        }),
    pr === null
      ? card("pull-request", "Pull request", {
          primary: "No pull request",
          tone: "muted",
          empty: true,
        })
      : card("pull-request", "Pull request", {
          primary: pr.title === null ? `#${pr.number}` : `#${pr.number} ${pr.title}`,
          secondary: pr.signInRequired ? "Sign in to see checks" : pr.checksText,
          compact: pr.state === null ? null : STATE_LABEL[pr.state],
          tone: pullRequestTone(pr),
        }),
    input.tickets.length === 0
      ? card("tickets", "Tickets", { primary: "No tickets linked", tone: "muted", empty: true })
      : card("tickets", "Tickets", {
          primary: input.tickets.map((ticket) => ticket.label).join(", "),
          compact: `${input.tickets.length}`,
        }),
    frontend === null
      ? card("frontend", "Frontend", { primary: "No frontend script", tone: "muted", empty: true })
      : frontend.running
        ? card("frontend", "Frontend", {
            primary: frontend.port === null ? frontend.scriptName : `localhost:${frontend.port}`,
            compact: frontend.port === null ? null : `:${frontend.port}`,
            tone: "success",
          })
        : card("frontend", "Frontend", {
            primary: "Stopped",
            secondary: frontend.scriptName,
            compact: "stopped",
            tone: "muted",
          }),
    card("worktree", "Worktree", {
      primary: input.worktreePath ?? "Project folder",
      secondary: vcs === null ? null : `${vcs.changedFiles} changes`,
      compact: vcs === null ? null : `${vcs.changedFiles} changes`,
    }),
    activity.working + activity.idle === 0
      ? card("activity", "Activity", { primary: "No activity yet", tone: "muted", empty: true })
      : card("activity", "Activity", {
          primary: `${activity.working} working · ${activity.idle} idle`,
          secondary:
            activity.lastActivityLabel === null
              ? null
              : `Last activity ${activity.lastActivityLabel}`,
          compact: activity.lastActivityLabel,
        }),
  ];
}

function webHref(url: string): string | null {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Stored links first, then `#N` refs in the pull request title that no stored link covers. */
export function ticketChips(
  links: ReadonlyArray<ThreadGroupLink>,
  pullRequest: {
    readonly host: string;
    readonly repository: string;
    readonly number: number;
    readonly title: string | null;
  } | null,
): ReadonlyArray<TicketChip> {
  const chips: Array<TicketChip> = links.map((link) => ({
    url: link.url,
    href: webHref(link.url),
    label: link.label,
    linkId: link.id,
  }));
  if (pullRequest === null || pullRequest.title === null) return chips;
  const seen = new Set(chips.map((chip) => chip.url));
  for (const ref of pullRequestTitleIssueLinks({ ...pullRequest, title: pullRequest.title })) {
    if (seen.has(ref.url)) continue;
    seen.add(ref.url);
    chips.push({ url: ref.url, href: webHref(ref.url), label: ref.label, linkId: null });
  }
  return chips;
}

/** Scripts a user starts by hand: not the setup or settle script. */
export const isRunnableScript = (script: ProjectScript) =>
  !script.runOnWorktreeCreate && script.runOnSettle !== true;

/** The script the Frontend card starts: the first runnable one with a preview URL. */
export function frontendScript(scripts: ReadonlyArray<ProjectScript>): ProjectScript | null {
  return (
    scripts.find((script) => isRunnableScript(script) && script.previewUrl !== undefined) ?? null
  );
}

export function glanceFrontend(
  script: ProjectScript | null,
  resources: ReadonlyArray<ThreadGroupRunningResource> | null,
): GlanceInput["frontend"] {
  if (script === null || script.previewUrl === undefined) return null;
  const port = loopbackPort(script.previewUrl);
  return {
    scriptName: script.name,
    port,
    running:
      port !== null &&
      (resources ?? []).some((resource) => resource.kind === "server" && resource.port === port),
  };
}

const BUSY: ReadonlySet<SidebarThreadStatus> = new Set(["working", "waiting", "approval", "input"]);

export function groupActivity(
  members: ReadonlyArray<{ readonly status: SidebarThreadStatus; readonly activityMs: number }>,
  now = Date.now(),
): GroupActivity {
  const working = members.filter((member) => BUSY.has(member.status)).length;
  const last = members.reduce(
    (latest, member) => Math.max(latest, member.activityMs),
    Number.NEGATIVE_INFINITY,
  );
  return {
    working,
    idle: members.length - working,
    lastActivityLabel: Number.isFinite(last)
      ? formatElapsedDurationLabel(new Date(last).toISOString(), now)
      : null,
  };
}
