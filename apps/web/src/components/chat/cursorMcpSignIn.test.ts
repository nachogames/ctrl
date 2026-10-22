import type { CursorMcpServer, CursorMcpStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { cursorMcpNotice, cursorMcpNoticeBlocksSend } from "./cursorMcpSignIn";

const server = (overrides: Partial<CursorMcpServer> & { name: string }): CursorMcpServer => ({
  source: "user",
  transport: null,
  status: "ready",
  statusDetail: null,
  needsRelaunch: false,
  ...overrides,
});

const status = (overrides: Partial<CursorMcpStatusResult>): CursorMcpStatusResult => ({
  cliAvailable: true,
  installCommand: "install",
  folder: "/repo",
  folderLoaded: false,
  servers: [],
  userConfigError: null,
  ...overrides,
});

describe("cursorMcpNotice", () => {
  it("holds the first message until servers in an unloaded folder are signed in", () => {
    const notice = cursorMcpNotice(
      status({ servers: [server({ name: "linear", status: "needs_sign_in" })] }),
      { firstTurn: true },
    );
    expect(notice).toEqual({ kind: "sign_in", names: ["linear"], needsRelaunchAfter: false });
    expect(cursorMcpNoticeBlocksSend(notice, { firstTurn: true })).toBe(true);
    expect(cursorMcpNoticeBlocksSend(notice, { firstTurn: false })).toBe(false);
  });

  it("does not hold a message when only a relaunch would let a sign-in through", () => {
    const notice = cursorMcpNotice(
      status({
        folderLoaded: true,
        servers: [server({ name: "linear", status: "needs_sign_in" })],
      }),
      { firstTurn: true },
    );
    expect(notice).toEqual({ kind: "sign_in", names: ["linear"], needsRelaunchAfter: true });
    expect(cursorMcpNoticeBlocksSend(notice, { firstTurn: true })).toBe(false);
  });

  it("asks for a relaunch before any further sign-in", () => {
    expect(
      cursorMcpNotice(
        status({
          folderLoaded: true,
          servers: [
            server({ name: "linear", needsRelaunch: true }),
            server({ name: "figma", status: "needs_sign_in" }),
          ],
        }),
        { firstTurn: false },
      ),
    ).toEqual({ kind: "relaunch", names: ["linear"] });
  });

  it("only suggests installing the CLI on a thread's first message", () => {
    const missing = status({ cliAvailable: false });
    expect(cursorMcpNotice(missing, { firstTurn: true })).toEqual({
      kind: "install",
      command: "install",
    });
    expect(cursorMcpNotice(missing, { firstTurn: false })).toBeNull();
  });
});
