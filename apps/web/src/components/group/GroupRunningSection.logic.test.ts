import { ThreadId } from "@t3tools/contracts";
import type { ProjectScript, ThreadGroupRunningResource } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  NO_STOPPED_TRACKING,
  STOPPED_ROW_MS,
  manualNameIdFor,
  observeScan,
  renameManualResources,
  runningView,
  trackStoppedRows,
} from "./GroupRunningSection.logic";

type Resource = ThreadGroupRunningResource;
const NOW = 1_000_000;
const planner = ThreadId.make("planner");
const builder = ThreadId.make("builder");

const server = (port: number, overrides: Partial<Resource> = {}): Resource => ({
  id: `server:${port}`,
  kind: "server",
  name: "node",
  detail: `:${port}`,
  url: `http://localhost:${port}`,
  source: "terminal",
  tier: "known",
  terminal: { threadId: planner, terminalId: `term-${port}` },
  startedByThreadId: planner,
  scriptId: null,
  port,
  ...overrides,
});
const found = (port: number, name: string): Resource =>
  server(port, { name, source: "cwd", tier: "found", terminal: null, startedByThreadId: null });
const script = (id: string, overrides: Partial<ProjectScript> = {}): ProjectScript => ({
  id,
  name: id,
  command: `vp run ${id}`,
  icon: "play",
  runOnWorktreeCreate: false,
  ...overrides,
});
const view = (
  resources: ReadonlyArray<Resource>,
  overrides: Partial<Parameters<typeof runningView>[0]> = {},
) =>
  runningView({
    resources,
    stopped: [],
    scripts: [],
    manual: [],
    chatTitles: new Map([[planner, "Plan auth"]]),
    currentThreadId: builder,
    now: NOW,
    ...overrides,
  });

describe("runningView", () => {
  it("lists known rows and folds found processes into one line", () => {
    const result = view([
      server(5173),
      found(8000, "python3"),
      found(8001, "python3"),
      {
        ...found(5432, "postgres"),
        id: "container:db",
        kind: "container",
        source: "docker",
        detail: "docker",
      },
      {
        ...server(0),
        id: "manual:notes",
        kind: "manual",
        name: "Notes",
        detail: "registered",
        url: null,
        source: "registered",
        terminal: null,
        startedByThreadId: null,
        port: null,
      },
    ]);
    expect(result.known.map((row) => [row.id, row.state, row.note])).toEqual([
      ["server:5173", "running", "started by Plan auth"],
      ["manual:notes", "registered", "registered"],
    ]);
    expect(result.known[1]?.manualId).toBe("notes");
    expect(result.found?.label).toBe("3 other processes in this worktree · python3, postgres");
    expect(result.found?.rows.map((row) => [row.id, row.canNameIt])).toEqual([
      ["server:8000", true],
      ["server:8001", true],
      ["container:db", false],
    ]);
  });

  it("offers Stop only for a server a member terminal owns", () => {
    const [own, named] = view([
      server(5173),
      server(5000, { name: "Docs", source: "cwd", terminal: null, startedByThreadId: null }),
    ]).known;
    expect(own?.stopTerminal).toEqual({ threadId: planner, terminalId: "term-5173" });
    expect(named?.stopTerminal).toBeNull();
    expect(named?.note).toBe("in this worktree");
    expect(view([server(5173, { startedByThreadId: builder })]).known[0]?.note).toBe(
      "started by this chat",
    );
  });

  it("offers Start for each runnable script that is not running", () => {
    const scripts = [
      script("dev"),
      script("storybook", { previewUrl: "http://localhost:6006" }),
      script("api"),
      script("install", { runOnWorktreeCreate: true }),
      script("clean", { runOnSettle: true }),
    ];
    const result = view(
      [
        server(5173, {
          scriptId: "dev",
          terminal: { threadId: planner, terminalId: "script-dev" },
        }),
        server(6006),
        // The script-api terminal was reused for another program: the scan gives it no scriptId.
        server(8000, {
          name: "python3",
          terminal: { threadId: planner, terminalId: "script-api" },
        }),
      ],
      { scripts },
    );
    expect(result.start.map((row) => row.scriptId)).toEqual(["api"]);
  });
});

describe("stopped rows", () => {
  const dev = server(5173, {
    scriptId: "dev",
    terminal: { threadId: planner, terminalId: "script-dev" },
  });

  it("keeps a stopped server greyed with Restart, then lets it go after 30 s", () => {
    const stopped = trackStoppedRows({ previous: [dev], next: [], stopped: [], now: NOW });
    const result = view([], { stopped, scripts: [script("dev")], now: NOW + 10_000 });
    expect(result.known[0]).toMatchObject({
      state: "stopped",
      note: "stopped 10s ago",
      restart: { scriptId: "dev", threadId: planner },
      stopTerminal: null,
    });
    expect(result.start).toEqual([]);
    expect(
      trackStoppedRows({ previous: [], next: [], stopped, now: NOW + STOPPED_ROW_MS }),
    ).toEqual([]);
    expect(view([], { stopped, now: NOW + STOPPED_ROW_MS }).known).toEqual([]);
  });

  it("drops a stopped row when its port comes back within 30 s, leaving one running row", () => {
    const stopped = trackStoppedRows({ previous: [dev], next: [], stopped: [], now: NOW });
    const restarted = { ...dev, id: "server:5173-again" };
    const back = trackStoppedRows({ previous: [], next: [restarted], stopped, now: NOW + 5_000 });
    expect(back).toEqual([]);
    expect(
      view([restarted], { stopped: back, now: NOW + 5_000 }).known.map((row) => row.state),
    ).toEqual(["running"]);
    // Even a render that still holds the old stopped rows shows the server once.
    expect(view([restarted], { stopped, now: NOW + 5_000 }).known.map((row) => row.state)).toEqual([
      "running",
    ]);
    const registered = {
      ...dev,
      id: "manual:web",
      kind: "manual" as const,
      tier: "known" as const,
    };
    // A registered row on the port is only a name, not the server coming back.
    expect(
      trackStoppedRows({ previous: [], next: [registered], stopped, now: NOW + 5_000 }),
    ).toEqual(stopped);
  });

  describe("a named server", () => {
    // The server names a live row from the manual resource; once it stops, the
    // manual row comes back on its own with the same port.
    const named = { ...dev, name: "Web app" };
    const manual: Resource = {
      ...dev,
      id: "manual:web",
      kind: "manual",
      name: "Web app",
      detail: "http://localhost:5173",
      source: "registered",
      terminal: null,
      startedByThreadId: null,
      scriptId: null,
    };
    const scripts = [script("dev", { previewUrl: "http://localhost:5173" })];

    it("still offers Start when a registered resource sits on the script's port", () => {
      const result = view([manual], { scripts });
      expect(result.start.map((row) => row.scriptId)).toEqual(["dev"]);
      expect(result.known.map((row) => [row.id, row.state])).toEqual([
        ["manual:web", "registered"],
      ]);
    });

    it("shows a stopped row with Restart, hiding the registered row on its port", () => {
      const stopped = trackStoppedRows({
        previous: [named],
        next: [manual],
        stopped: [],
        now: NOW,
      });
      expect(stopped.map((row) => row.resource.id)).toEqual(["server:5173"]);
      const result = view([manual], { stopped, scripts, now: NOW + 10_000 });
      expect(result.known.map((row) => [row.id, row.state, row.name])).toEqual([
        ["server:5173", "stopped", "Web app"],
      ]);
      expect(result.known[0]?.restart).toEqual({ scriptId: "dev", threadId: planner });
      expect(result.start).toEqual([]);
    });

    it("returns to the Start row and the registered row after 30 s", () => {
      const stopped = trackStoppedRows({
        previous: [named],
        next: [manual],
        stopped: [],
        now: NOW,
      });
      const later = NOW + STOPPED_ROW_MS;
      const kept = trackStoppedRows({ previous: [manual], next: [manual], stopped, now: later });
      expect(kept).toEqual([]);
      const result = view([manual], { stopped: kept, scripts, now: later });
      expect(result.known.map((row) => [row.id, row.state])).toEqual([
        ["manual:web", "registered"],
      ]);
      expect(result.start.map((row) => row.scriptId)).toEqual(["dev"]);
    });
  });

  it("never marks a found process or a registered resource as stopped", () => {
    expect(
      trackStoppedRows({ previous: [found(8000, "python3")], next: [], stopped: [], now: NOW }),
    ).toEqual([]);
    const registered = { ...server(3000), id: "manual:api", kind: "manual" as const };
    expect(trackStoppedRows({ previous: [registered], next: [], stopped: [], now: NOW })).toEqual(
      [],
    );
  });

  it("never offers Start or Restart for setup and settle scripts", () => {
    const scripts = [
      script("install", { runOnWorktreeCreate: true }),
      script("clean", { runOnSettle: true }),
    ];
    const setup = server(5173, {
      scriptId: "install",
      terminal: { threadId: planner, terminalId: "setup-install" },
    });
    // Even on a script- terminal, a setup or settle script is not restartable.
    const settle = server(5174, {
      scriptId: "clean",
      terminal: { threadId: planner, terminalId: "script-clean" },
    });
    const stopped = trackStoppedRows({
      previous: [setup, settle],
      next: [],
      stopped: [],
      now: NOW,
    });
    const result = view([], { stopped, scripts, now: NOW + 1_000 });
    expect(result.known.map((row) => [row.state, row.restart])).toEqual([
      ["stopped", null],
      ["stopped", null],
    ]);
    expect(result.start).toEqual([]);
  });

  it("offers no Restart for a script that no longer exists", () => {
    const stopped = trackStoppedRows({ previous: [dev], next: [], stopped: [], now: NOW });
    expect(view([], { stopped, scripts: [] }).known[0]?.restart).toBeNull();
  });
});

describe("observeScan", () => {
  // A python server the panel started from the "Web" script, then stopped.
  const web = server(8765, {
    name: "Web",
    scriptId: "web",
    terminal: { threadId: builder, terminalId: "script-web" },
    startedByThreadId: builder,
  });
  const scripts = [script("web", { name: "Web", previewUrl: "http://localhost:8765" })];

  it("shows a server that left the scan as stopped with Restart, hiding its Start row", () => {
    const running = observeScan(NO_STOPPED_TRACKING, [web], NOW);
    expect(running.stopped).toEqual([]);
    const after = observeScan(running, [], NOW + 3_000);
    const result = view([], { stopped: after.stopped, scripts, now: NOW + 3_000 });
    expect(result.known).toMatchObject([
      {
        id: "server:8765",
        state: "stopped",
        note: "stopped just now",
        restart: { scriptId: "web", threadId: builder },
      },
    ]);
    expect(result.start).toEqual([]);
    // Once the row expires, the script offers Start again.
    const later = observeScan(after, [], NOW + 3_000 + STOPPED_ROW_MS);
    expect(later.stopped).toEqual([]);
    expect(view([], { stopped: later.stopped, scripts }).start.map((row) => row.scriptId)).toEqual([
      "web",
    ]);
  });

  it("keeps the previous scan in its state, so a late or repeated fold still sees the stop", () => {
    // The panel used to read the previous scan from a ref inside its state updater. React runs
    // that updater during the next render, after the ref already held the new scan, so the
    // diff compared the empty scan with itself and nothing ever looked stopped.
    const next: ReadonlyArray<Resource> = [];
    expect(trackStoppedRows({ previous: next, next, stopped: [], now: NOW })).toEqual([]);
    const running = observeScan(NO_STOPPED_TRACKING, [web], NOW);
    expect(running.previous).toEqual([web]);
    // Strict mode calls an updater twice with the same state: both calls agree.
    const first = observeScan(running, next, NOW + 1_000);
    const second = observeScan(running, next, NOW + 1_000);
    expect(first.stopped.map((row) => row.resource.id)).toEqual(["server:8765"]);
    expect(second).toEqual(first);
  });
});

describe("removing a server's name", () => {
  const manual = [
    { id: "web", name: "Web app", url: "http://127.0.0.1:5173/app", kind: "server" as const },
    { id: "docs", name: "Docs", url: "https://docs.example.test", kind: "server" as const },
  ];

  it("matches the registered resource on the server's port", () => {
    expect(manualNameIdFor(manual, 5173)).toBe("web");
    expect(manualNameIdFor(manual, 3000)).toBeNull();
    expect(manualNameIdFor(manual, null)).toBeNull();
  });

  it("offers Remove name on a named running or stopped server, never on a registered row", () => {
    const named = server(5173, { name: "Web app" });
    expect(view([named], { manual }).known[0]?.nameId).toBe("web");
    expect(view([server(3000)], { manual }).known[0]?.nameId).toBeNull();
    const stopped = trackStoppedRows({ previous: [named], next: [], stopped: [], now: NOW });
    expect(view([], { stopped, manual }).known[0]).toMatchObject({
      state: "stopped",
      nameId: "web",
    });
    const registered: Resource = {
      ...server(5173),
      id: "manual:web",
      kind: "manual",
      source: "registered",
      terminal: null,
      startedByThreadId: null,
    };
    expect(view([registered], { manual }).known[0]).toMatchObject({
      manualId: "web",
      nameId: null,
    });
  });
});

describe("renameManualResources", () => {
  it("renames the resource on the port, else registers one for it", () => {
    const web = {
      id: "web",
      name: "Web",
      url: "http://127.0.0.1:5173/app",
      kind: "server" as const,
    };
    expect(renameManualResources([web], { port: 5173, name: "Web app" })).toEqual([
      { ...web, name: "Web app" },
    ]);
    expect(
      renameManualResources([{ ...web, id: "port-3000", url: null }], { port: 3000, name: "API" }),
    ).toEqual([
      { ...web, id: "port-3000", url: null },
      { id: "port-3000-2", name: "API", url: "http://localhost:3000", kind: "server" },
    ]);
  });
});
