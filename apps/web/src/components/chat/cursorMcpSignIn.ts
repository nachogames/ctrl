import type { CursorMcpStatusResult } from "@t3tools/contracts";

export type CursorMcpNotice =
  | { readonly kind: "relaunch"; readonly names: ReadonlyArray<string> }
  | {
      readonly kind: "sign_in";
      readonly names: ReadonlyArray<string>;
      /** Signing in now only reaches Cursor threads after a relaunch. */
      readonly needsRelaunchAfter: boolean;
    }
  | { readonly kind: "install"; readonly command: string };

/**
 * What a Cursor thread should say about its folder's MCP sign-ins. A relaunch
 * outranks sign-in because no sign-in reaches a folder this server already loaded.
 */
export function cursorMcpNotice(
  status: CursorMcpStatusResult,
  options: { readonly firstTurn: boolean },
): CursorMcpNotice | null {
  if (!status.cliAvailable) {
    return options.firstTurn ? { kind: "install", command: status.installCommand } : null;
  }
  const relaunch = status.servers.filter((server) => server.needsRelaunch);
  if (relaunch.length > 0) {
    return { kind: "relaunch", names: relaunch.map((server) => server.name) };
  }
  const signIn = status.servers.filter((server) => server.status === "needs_sign_in");
  if (signIn.length > 0) {
    return {
      kind: "sign_in",
      names: signIn.map((server) => server.name),
      needsRelaunchAfter: status.folderLoaded,
    };
  }
  return null;
}

/** Holds the first message while sign-in can still reach the agent that message starts. */
export function cursorMcpNoticeBlocksSend(
  notice: CursorMcpNotice | null,
  options: { readonly firstTurn: boolean },
): boolean {
  return options.firstTurn && notice?.kind === "sign_in" && !notice.needsRelaunchAfter;
}

export function formatServerNames(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
