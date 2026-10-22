import type { CursorMcpServer, CursorMcpStatusResult } from "@t3tools/contracts";

/** What a Cursor MCP server needs before this thread's agent can use it. */
export type CursorMcpServerAction = "sign_in" | "restart" | null;

/**
 * Restart outranks sign-in: Cursor reads a folder's sign-ins once per server
 * process, so a server signed in after the folder loaded only needs a restart.
 */
export function cursorMcpServerAction(server: CursorMcpServer): CursorMcpServerAction {
  if (server.needsRelaunch) return "restart";
  if (server.status === "needs_sign_in") return "sign_in";
  return null;
}

/** Servers that need something from the user, for the tab's warning dot. */
export function cursorMcpServersNeedingAction(
  status: CursorMcpStatusResult,
): ReadonlyArray<CursorMcpServer> {
  return status.servers.filter((server) => cursorMcpServerAction(server) !== null);
}
