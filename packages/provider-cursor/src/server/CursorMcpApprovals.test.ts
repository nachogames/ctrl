import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";

import * as Approvals from "./CursorMcpApprovals.ts";

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);

const setupHome = Effect.fn("setupHome")(function* (config?: {
  readonly allow?: ReadonlyArray<string>;
  readonly deny?: ReadonlyArray<string>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem
    .makeTempDirectoryScoped({ directory: NodeOS.tmpdir(), prefix: "cursor-approvals-" })
    .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
  if (config !== undefined) {
    yield* fileSystem.makeDirectory(path.join(home, ".cursor"), { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(home, ".cursor", "cli-config.json"),
      JSON.stringify({ permissions: { allow: config.allow ?? [], deny: config.deny ?? [] } }),
    );
  }
  const inHome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Platform, "darwin"),
    );
  return { home, fileSystem, path, inHome };
});

const hookCall = (overrides: Record<string, unknown> = {}) => ({
  hook_event_name: "beforeMCPExecution",
  conversation_id: "agent-1",
  workspace_roots: ["/repo"],
  mcp_server_name: "linear",
  tool_name: "save_issue",
  tool_input: '{"title":"Bug"}',
  tool_use_id: "call-1",
  ...overrides,
});

const fakeSession = (
  decision: Approvals.CursorMcpApprovalDecision,
  overrides: Partial<Approvals.CursorApprovalSession> = {},
) => {
  const calls: Array<Approvals.CursorMcpCall> = [];
  const matches: Array<boolean> = [];
  const session: Approvals.CursorApprovalSession = {
    enforced: true,
    agentId: () => "agent-1",
    cwd: "/repo",
    hasActiveTurn: () => true,
    ctrlMcpUrl: () => "http://127.0.0.1:1/mcp",
    requestApproval: (call, { matchedByAgent }) =>
      Effect.sync(() => (calls.push(call), matches.push(matchedByAgent), decision)),
    ...overrides,
  };
  return { session, calls, matches };
};

describe("mcpPermission", () => {
  it("denies first, then allows, and asks for anything else, with globs", () => {
    const rules = {
      allow: ["Mcp(linear:get_*)", "Mcp(ember:*)"],
      deny: ["Mcp(linear:delete_*)"],
    };
    expect(Approvals.mcpPermission(rules, "linear", "get_issue")).toBe("allow");
    expect(Approvals.mcpPermission(rules, "linear", "delete_issue")).toBe("deny");
    expect(Approvals.mcpPermission(rules, "linear", "save_issue")).toBe("ask");
    // Allow rules match case exactly, deny rules ignore case.
    expect(Approvals.mcpPermission(rules, "ember", "create_task")).toBe("allow");
    expect(Approvals.mcpPermission(rules, "Ember", "create_task")).toBe("ask");
    expect(Approvals.mcpPermission(rules, "LINEAR", "delete_issue")).toBe("deny");
    expect(Approvals.mcpPermission(rules, "figma", "get_file")).toBe("ask");
  });
});

describe("decideCursorMcpHook", () => {
  afterEach(() => Approvals.resetCursorApprovalSessionsForTest());

  it("asks the thread whose agent made the call, and passes its decision on", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setupHome({ allow: ["Mcp(linear:get_*)"] });
        const allowing = fakeSession("allow_once");
        yield* Approvals.registerCursorApprovalSession(allowing.session);

        expect(yield* test.inHome(Approvals.decideCursorMcpHook(hookCall()))).toEqual({
          permission: "allow",
        });
        expect(allowing.calls).toEqual([
          { server: "linear", tool: "save_issue", input: '{"title":"Bug"}', toolCallId: "call-1" },
        ]);
        // A call the allowlist covers never reaches the user.
        yield* test.inHome(Approvals.decideCursorMcpHook(hookCall({ tool_name: "get_issue" })));
        expect(allowing.calls).toHaveLength(1);
      }),
    ));

  it("denies what the user declines or the allowlist denies", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setupHome({ deny: ["Mcp(linear:delete_*)"] });
        const declining = fakeSession("deny");
        yield* Approvals.registerCursorApprovalSession(declining.session);

        const declined = yield* test.inHome(Approvals.decideCursorMcpHook(hookCall()));
        expect(declined.permission).toBe("deny");
        const denied = yield* test.inHome(
          Approvals.decideCursorMcpHook(hookCall({ tool_name: "delete_issue" })),
        );
        expect(denied.permission).toBe("deny");
        expect(declining.calls).toHaveLength(1);
      }),
    ));

  it("falls back to the one running thread in the folder when the agent id differs", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setupHome();
        const running = fakeSession("allow_once", { agentId: () => "other" });
        const idle = fakeSession("deny", { agentId: () => "idle", hasActiveTurn: () => false });
        yield* Approvals.registerCursorApprovalSession(running.session);
        yield* Approvals.registerCursorApprovalSession(idle.session);

        const response = yield* test.inHome(Approvals.decideCursorMcpHook(hookCall()));
        expect(response.permission).toBe("allow");
        expect(running.calls).toHaveLength(1);
        // Matched by folder only, so the card cannot allow the tool for the whole chat.
        expect(running.matches).toEqual([false]);
      }),
    ));

  it("denies when no thread can be matched, but never holds threads that did not opt in", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setupHome();
        const enforced = fakeSession("allow_once", {
          agentId: () => "elsewhere",
          cwd: "/other",
        });
        yield* Approvals.registerCursorApprovalSession(enforced.session);
        const unmatched = yield* test.inHome(Approvals.decideCursorMcpHook(hookCall()));
        expect(unmatched.permission).toBe("deny");

        Approvals.resetCursorApprovalSessionsForTest();
        const optedOut = fakeSession("deny", { enforced: false });
        yield* Approvals.registerCursorApprovalSession(optedOut.session);
        const allowed = yield* test.inHome(Approvals.decideCursorMcpHook(hookCall()));
        expect(allowed.permission).toBe("allow");
        expect(optedOut.calls).toHaveLength(0);
      }),
    ));

  it("allows Ctrl's own MCP server only at the address Ctrl gave the agent", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setupHome();
        const session = fakeSession("deny");
        yield* Approvals.registerCursorApprovalSession(session.session);
        const own = yield* test.inHome(
          Approvals.decideCursorMcpHook(
            hookCall({ mcp_server_name: "t3-code", mcp_server_url: "http://127.0.0.1:1/mcp" }),
          ),
        );
        expect(own.permission).toBe("allow");
        expect(session.calls).toHaveLength(0);
        // A project server that borrows the name is asked about like any other.
        const impostor = yield* test.inHome(
          Approvals.decideCursorMcpHook(
            hookCall({ mcp_server_name: "t3-code", mcp_server_url: "https://evil.example/mcp" }),
          ),
        );
        expect(impostor.permission).toBe("deny");
        expect(session.calls).toHaveLength(1);
      }),
    ));
});

describe("setCursorApprovalHookInstalled", () => {
  it("adds and removes only Ctrl's entry, keeping the user's hooks", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setupHome();
        const hooksPath = test.path.join(test.home, ".cursor", "hooks.json");
        const theirs = { command: "/usr/local/bin/their-hook" };
        yield* test.fileSystem.makeDirectory(test.path.dirname(hooksPath), { recursive: true });
        yield* test.fileSystem.writeFileString(
          hooksPath,
          JSON.stringify({ version: 1, hooks: { beforeMCPExecution: [theirs], stop: [theirs] } }),
        );
        const readHooks = test.fileSystem
          .readFileString(hooksPath)
          .pipe(Effect.map((text) => JSON.parse(text)));
        const script = test.path.join(test.home, ".cursor", "hooks", "ctrl-mcp-approval.sh");

        yield* test.inHome(Approvals.setCursorApprovalHookInstalled(true));
        yield* test.inHome(Approvals.setCursorApprovalHookInstalled(true));
        expect((yield* readHooks).hooks).toEqual({
          beforeMCPExecution: [theirs, { command: `'${script}'`, timeout: 3600, failClosed: true }],
          stop: [theirs],
        });
        expect(((yield* test.fileSystem.stat(script)).mode & 0o777).toString(8)).toBe("755");

        yield* test.inHome(Approvals.setCursorApprovalHookInstalled(false));
        expect((yield* readHooks).hooks).toEqual({ beforeMCPExecution: [theirs], stop: [theirs] });
        expect(yield* test.fileSystem.exists(script)).toBe(false);
      }),
    ));
});

describe("syncCursorApprovalHook", () => {
  it("keeps the hook while any instance wants it, and refuses a hooks.json it cannot read", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setupHome();
        const script = test.path.join(test.home, ".cursor", "hooks", "ctrl-mcp-approval.sh");
        yield* test.inHome(Approvals.syncCursorApprovalHook("cursor", true));
        yield* test.inHome(Approvals.syncCursorApprovalHook("cursor_work", false));
        expect(yield* test.fileSystem.exists(script)).toBe(true);
        yield* test.inHome(Approvals.syncCursorApprovalHook("cursor", false));
        expect(yield* test.fileSystem.exists(script)).toBe(false);

        yield* test.fileSystem.writeFileString(
          test.path.join(test.home, ".cursor", "hooks.json"),
          "{ // comments are not JSON\n}",
        );
        const failure = yield* test
          .inHome(Approvals.setCursorApprovalHookInstalled(true))
          .pipe(Effect.flip);
        expect(failure._tag).toBe("CursorApprovalHookError");
      }),
    ));
});

describe("the Cursor app's MCP allowlist", () => {
  afterEach(() => Approvals.resetCursorApprovalSessionsForTest());

  const writeAppSettings = Effect.fn("writeAppSettings")(function* (
    home: string,
    composerState: Record<string, unknown>,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(
      home,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
    );
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
      yield* sql.unsafe("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [
        "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser",
        JSON.stringify({ composerState }),
      ]);
    }).pipe(
      Effect.provide(
        NodeSqliteClient.layer({
          filename: path.join(directory, "state.vscdb"),
          readerWorker: false,
          checkpointWorker: false,
        }),
      ),
    );
  });

  it("allows what the app allows, server-wide entries included, and asks for the rest", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setupHome();
        yield* writeAppSettings(test.home, {
          mcpAllowedTools: ["linear:get_workspace", "plugin-figma-figma:*"],
          yoloMcpToolsDisabled: false,
        });
        const session = fakeSession("deny");
        yield* Approvals.registerCursorApprovalSession(session.session);
        const decide = (server: string, tool: string) =>
          test
            .inHome(
              Approvals.decideCursorMcpHook(hookCall({ mcp_server_name: server, tool_name: tool })),
            )
            .pipe(Effect.map((response) => response.permission));

        expect(yield* decide("linear", "get_workspace")).toBe("allow");
        expect(yield* decide("plugin-figma-figma", "get_screenshot")).toBe("allow");
        expect(session.calls).toHaveLength(0);
        expect(yield* decide("linear", "save_issue")).toBe("deny");
        expect(session.calls.map((call) => call.tool)).toEqual(["save_issue"]);
      }),
    ));

  it("asks for everything when the app has MCP auto-run turned off", () => {
    expect(
      Approvals.findMcpAllowedTools({
        composerState: { mcpAllowedTools: ["linear:*"], yoloMcpToolsDisabled: true },
      }),
    ).toEqual([]);
  });
});
