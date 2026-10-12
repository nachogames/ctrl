import { ThreadId } from "@t3tools/contracts";
import type { ThreadGroupRunningResource } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  START_PENDING_MS,
  busyScriptIds,
  scriptStartState,
  settlePendingStarts,
} from "./useGroupScriptRunner.logic";

const NOW = 1_000_000;
const planner = ThreadId.make("planner");

const server = (
  port: number,
  overrides: Partial<ThreadGroupRunningResource> = {},
): ThreadGroupRunningResource => ({
  id: `server:${port}`,
  kind: "server",
  name: "node",
  detail: `:${port}`,
  url: `http://localhost:${port}`,
  source: "terminal",
  tier: "known",
  terminal: { threadId: planner, terminalId: "script-web" },
  startedByThreadId: planner,
  scriptId: null,
  port,
  ...overrides,
});

describe("pending starts", () => {
  const web = { scriptId: "web", port: 8765, at: NOW };
  const api = { scriptId: "api", port: null, at: NOW };

  it("shows Starting… until a scan shows the script or its port", () => {
    expect(settlePendingStarts([web, api], [], NOW + 5_000)).toEqual([web, api]);
    expect(settlePendingStarts([web, api], [server(8765)], NOW + 5_000)).toEqual([api]);
    expect(settlePendingStarts([web, api], [server(9000, { scriptId: "api" })], NOW)).toEqual([
      web,
    ]);
    // A registered resource on the port only names it; it does not mean the server is up.
    expect(
      settlePendingStarts([web], [server(8765, { id: "manual:web", kind: "manual" })], NOW),
    ).toEqual([web]);
  });

  it("gives up after 15 s", () => {
    expect(settlePendingStarts([web], null, NOW + START_PENDING_MS - 1)).toEqual([web]);
    expect(settlePendingStarts([web], null, NOW + START_PENDING_MS)).toEqual([]);
  });

  it("keeps the same array when nothing settles, so state does not churn", () => {
    const pending = [web];
    expect(settlePendingStarts(pending, [], NOW)).toBe(pending);
  });
});

describe("script start state", () => {
  const terminal = (threadId: string, terminalId: string, hasRunningSubprocess: boolean) => ({
    threadId,
    terminalId,
    hasRunningSubprocess,
  });

  it("marks a script busy while its script terminal on a member chat runs something", () => {
    const busy = busyScriptIds(
      [
        terminal("planner", "script-web", true),
        terminal("planner", "script-api", false),
        terminal("stranger", "script-docs", true),
        terminal("planner", "term-1", true),
      ],
      new Set(["planner"]),
      ["web", "api", "docs"],
    );
    expect([...busy]).toEqual(["web"]);
  });

  it("prefers starting over busy, and is idle otherwise", () => {
    const pending = [{ scriptId: "web", port: null, at: NOW }];
    expect(scriptStartState("web", pending, new Set(["web"]))).toBe("starting");
    expect(scriptStartState("api", pending, new Set(["api"]))).toBe("busy");
    expect(scriptStartState("docs", pending, new Set())).toBe("idle");
  });
});
