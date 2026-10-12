import type { ProjectScript, ThreadGroupRunningResource } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatElapsedDurationLabel } from "../../timestampFormat";
import {
  type GlanceCard,
  type GlanceInput,
  frontendScript,
  glanceCards,
  glanceFrontend,
  groupActivity,
  ticketChips,
  compactTicketChips,
} from "./GroupGlanceCards.logic";

const NOW = Date.parse("2026-10-11T12:00:00.000Z");

const input = (overrides: Partial<GlanceInput> = {}): GlanceInput => ({
  branch: "feat/auth",
  worktreePath: "/Users/me/.t3/worktrees/app/feat-auth",
  vcs: { ahead: 3, behind: 1, baseRef: "main", changedFiles: 4 },
  pullRequest: null,
  tickets: [],
  frontend: null,
  activity: { working: 1, idle: 2, lastActivityLabel: "5 minutes ago" },
  ...overrides,
});

const cards = (overrides: Partial<GlanceInput> = {}) =>
  Object.fromEntries(glanceCards(input(overrides)).map((card) => [card.id, card])) as Record<
    GlanceCard["id"],
    GlanceCard
  >;

describe("glanceCards", () => {
  it("describes the branch and worktree from the VCS status", () => {
    const { branch, worktree } = cards();
    expect(branch).toMatchObject({
      primary: "feat/auth",
      secondary: "3 ahead of main · 1 behind upstream",
      compact: "3↑ 1↓",
    });
    expect(worktree).toMatchObject({ secondary: "4 changes", compact: "4 changes", empty: false });
  });

  it("counts one changed file as one change", () => {
    const { worktree } = cards({ vcs: { ahead: 0, behind: 0, baseRef: null, changedFiles: 1 } });
    expect(worktree).toMatchObject({ secondary: "1 change", compact: "1 change" });
  });

  it("leaves out the base and the behind count when there are none", () => {
    const { branch } = cards({ vcs: { ahead: 2, behind: 0, baseRef: null, changedFiles: 0 } });
    expect(branch).toMatchObject({ secondary: "2 ahead", compact: "2↑" });
  });

  it("names the branch and worktree without counts when VCS status is unavailable", () => {
    const { branch, worktree } = cards({ vcs: null });
    expect([branch.primary, branch.secondary]).toEqual(["feat/auth", null]);
    expect(worktree.secondary).toBeNull();
  });

  it("reads a root workspace group", () => {
    const { branch, worktree } = cards({ branch: null, worktreePath: null });
    expect(branch).toMatchObject({ primary: "No branch", empty: true });
    expect(worktree).toMatchObject({ primary: "Project folder", empty: false });
  });

  it("tones a pull request by its state and checks", () => {
    const pr = {
      number: 412,
      title: "Rework auth",
      state: "open" as const,
      checksText: "1 of 5 failing",
      checksFailing: true,
      signInRequired: false,
    };
    expect(cards({ pullRequest: pr })["pull-request"]).toMatchObject({
      primary: "#412 Rework auth",
      secondary: "1 of 5 failing",
      compact: "Open",
      tone: "warning",
    });
    expect(cards({ pullRequest: { ...pr, state: "merged" } })["pull-request"].tone).toBe("merged");
    expect(cards({ pullRequest: { ...pr, state: "draft" } })["pull-request"].tone).toBe("muted");
    expect(cards({ pullRequest: { ...pr, signInRequired: true } })["pull-request"].secondary).toBe(
      "Sign in to see checks",
    );
    expect(cards()["pull-request"]).toMatchObject({ primary: "No pull request", empty: true });
  });

  it("states empty tickets, frontend and activity", () => {
    const empty = cards({ activity: { working: 0, idle: 0, lastActivityLabel: null } });
    expect(empty.tickets).toMatchObject({ primary: "No tickets linked", empty: true });
    expect(empty.frontend).toMatchObject({ primary: "No frontend script", empty: true });
    expect(empty.activity).toMatchObject({ primary: "No activity yet", empty: true });
  });

  it("shows a running frontend by its port and a stopped one by its script", () => {
    expect(
      cards({ frontend: { scriptName: "Dev", port: 5173, running: true } }).frontend,
    ).toMatchObject({ primary: "localhost:5173", tone: "success" });
    expect(
      cards({ frontend: { scriptName: "Dev", port: 5173, running: false } }).frontend,
    ).toMatchObject({ primary: "Stopped", secondary: "Dev", tone: "muted" });
  });
});

describe("ticketChips", () => {
  it("lists stored links, then the pull request title's refs it does not already link", () => {
    const stored = {
      id: "link:1",
      url: "https://github.com/t3tools/t3code/issues/88",
      label: "#88",
    };
    expect(
      ticketChips([stored], {
        host: "github.com",
        repository: "t3tools/t3code",
        number: 412,
        title: "Fixes #88 and #91",
      }),
    ).toEqual([
      { url: stored.url, href: stored.url, label: "#88", linkId: "link:1" },
      {
        url: "https://github.com/t3tools/t3code/issues/91",
        href: "https://github.com/t3tools/t3code/issues/91",
        label: "#91",
        linkId: null,
      },
    ]);
  });

  it("links only http and https URLs; anything else is plain text", () => {
    const chips = ticketChips(
      [
        { id: "a", url: "javascript:alert(1)", label: "evil" },
        { id: "b", url: "not a url", label: "notes" },
        { id: "c", url: "http://linear.app/t3/issue/T3-12", label: "T3-12" },
      ],
      null,
    );
    expect(chips.map((chip) => chip.href)).toEqual([
      null,
      null,
      "http://linear.app/t3/issue/T3-12",
    ]);
  });
});

describe("frontend", () => {
  const scripts: ReadonlyArray<ProjectScript> = [
    {
      id: "setup",
      name: "Setup",
      command: "vp i",
      icon: "configure",
      runOnWorktreeCreate: true,
      previewUrl: "http://localhost:1",
    },
    {
      id: "dev",
      name: "Dev",
      command: "vp run dev",
      icon: "play",
      runOnWorktreeCreate: false,
      previewUrl: "http://localhost:5173",
    },
  ];
  const server = { kind: "server", port: 5173 } as ThreadGroupRunningResource;

  it("is the first runnable script with a preview URL, running while its port is the group's", () => {
    const script = frontendScript(scripts);
    expect(script?.id).toBe("dev");
    expect(glanceFrontend(script, [server])).toEqual({
      scriptName: "Dev",
      port: 5173,
      running: true,
    });
    expect(glanceFrontend(script, null)?.running).toBe(false);
  });
});

describe("groupActivity", () => {
  it("counts busy and resting chats and reports the latest activity", () => {
    const at = Date.parse("2026-10-11T11:55:00.000Z");
    expect(
      groupActivity(
        [
          { status: "working", activityMs: at - 60_000 },
          { status: "approval", activityMs: at },
          { status: "ready", activityMs: Number.NEGATIVE_INFINITY },
        ],
        NOW,
      ),
    ).toEqual({
      working: 2,
      idle: 1,
      lastActivityLabel: formatElapsedDurationLabel(new Date(at).toISOString(), NOW),
    });
    expect(groupActivity([], NOW).lastActivityLabel).toBeNull();
  });
});

describe("compactTicketChips", () => {
  const chip = (label: string) => ({
    url: `https://linear.app/acme/issue/${label}`,
    href: `https://linear.app/acme/issue/${label}`,
    label,
    linkId: `link:${label}`,
  });

  it("shows two chips and folds the rest into +N until expanded", () => {
    const tickets = [chip("ENG-1"), chip("ENG-2"), chip("ENG-3"), chip("ENG-4")];
    const folded = compactTicketChips(tickets, false);
    expect(folded.shown.map((ticket) => ticket.label)).toEqual(["ENG-1", "ENG-2"]);
    expect(folded.hidden).toBe(2);
    expect(compactTicketChips(tickets, true)).toEqual({ shown: tickets, hidden: 0 });
    expect(compactTicketChips(tickets.slice(0, 2), false)).toEqual({
      shown: tickets.slice(0, 2),
      hidden: 0,
    });
  });
});
