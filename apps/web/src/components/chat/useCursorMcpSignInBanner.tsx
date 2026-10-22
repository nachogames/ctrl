import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  type CursorMcpFolderInput,
  type CursorMcpStatusResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { KeyRoundIcon, RotateCwIcon, TerminalIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { APP_BASE_NAME } from "~/branding";

import { relaunchDesktopApp, useCanRelaunchDesktopEnvironment } from "~/lib/desktopRelaunch";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { cursorMcpNotice, cursorMcpNoticeBlocksSend, formatServerNames } from "./cursorMcpSignIn";

const INSTALL_HINT_DISMISSED_KEY = "ctrl:cursor-mcp-install-hint-dismissed";
// Each check runs Cursor's CLI, which connects to every MCP server, so switching
// between threads in one folder reuses a recent answer.
const RECENT_CHECK_MS = 2 * 60_000;
const recentChecks = new Map<
  string,
  { readonly at: number; readonly status: CursorMcpStatusResult }
>();

function rememberCheck(key: string, status: CursorMcpStatusResult) {
  recentChecks.set(key, { at: Date.now(), status });
}

function readInstallHintDismissed(): boolean {
  try {
    return window.localStorage.getItem(INSTALL_HINT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Cursor saves MCP sign-ins per folder and its SDK reads them once per server
 * process, so a Cursor thread checks its folder and offers sign-in before the
 * first message, or a relaunch when the folder already loaded signed out.
 */
export function useCursorMcpSignInBanner(input: {
  readonly environmentId: EnvironmentId | null;
  /** Null when the thread is not a Cursor thread or its folder does not exist yet. */
  readonly folder: CursorMcpFolderInput | null;
  readonly firstTurn: boolean;
}): { readonly item: ComposerBannerStackItem | null; readonly blocksSend: boolean } {
  const canRead = useEnvironmentScope(input.environmentId, AuthOrchestrationReadScope);
  const canManage = useEnvironmentScope(input.environmentId, AuthProvidersManageScope);
  const canRelaunch = useCanRelaunchDesktopEnvironment(input.environmentId);
  const readStatus = useAtomCommand(serverEnvironment.cursorMcpStatus, { reportFailure: false });
  const signIn = useAtomCommand(serverEnvironment.cursorMcpSignIn, { reportFailure: false });
  const folderId =
    input.environmentId === null || input.folder === null || !canRead
      ? null
      : `${input.environmentId}:${input.folder.threadId ?? ""}:${input.folder.projectId ?? ""}`;
  // The first message loads the folder, which changes the answer, so it re-checks.
  const folderKey = folderId === null ? null : `${folderId}:${input.firstTurn}`;
  const [checked, setChecked] = useState<{
    readonly key: string;
    readonly status: CursorMcpStatusResult;
  } | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [installHintDismissed, setInstallHintDismissed] = useState(readInstallHintDismissed);

  const check = useEffectEvent(async (key: string) => {
    if (input.environmentId === null || input.folder === null) return;
    const result = await readStatus({ environmentId: input.environmentId, input: input.folder });
    if (result._tag !== "Success") return;
    rememberCheck(key, result.value);
    setChecked({ key, status: result.value });
  });
  useEffect(() => {
    if (folderKey === null) return;
    const recent = recentChecks.get(folderKey);
    if (recent !== undefined && Date.now() - recent.at < RECENT_CHECK_MS) return;
    // oxlint-disable-next-line react/set-state-in-effect -- State changes only after the response arrives.
    void check(folderKey);
  }, [folderKey]);

  const status =
    folderKey === null
      ? null
      : checked !== null && checked.key === folderKey
        ? checked.status
        : (recentChecks.get(folderKey)?.status ?? null);
  const notice = status === null ? null : cursorMcpNotice(status, { firstTurn: input.firstTurn });
  if (folderKey === null || notice === null || dismissedKey === folderId) {
    return { item: null, blocksSend: false };
  }
  const blocksSend = cursorMcpNoticeBlocksSend(notice, { firstTurn: input.firstTurn });
  const dismiss = () => setDismissedKey(folderId);

  const signInTo = async (name: string) => {
    if (input.environmentId === null || input.folder === null || signingIn !== null) return;
    setSigningIn(name);
    const result = await signIn({
      environmentId: input.environmentId,
      input: { ...input.folder, name },
    });
    setSigningIn(null);
    if (result._tag === "Success") {
      rememberCheck(folderKey, result.value);
      setChecked({ key: folderKey, status: result.value });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: `Could not sign in to ${name}`,
      description: error instanceof Error ? error.message : undefined,
    });
  };

  if (notice.kind === "install") {
    if (installHintDismissed) return { item: null, blocksSend: false };
    return {
      blocksSend: false,
      item: {
        id: "cursor-mcp:install",
        variant: "info",
        priority: "notice",
        icon: <TerminalIcon />,
        title: "Install Cursor's command-line tool to check MCP sign-ins",
        description: (
          <>
            Run <code className="font-mono">{notice.command}</code> on the machine running{" "}
            {APP_BASE_NAME}.
          </>
        ),
        dismissLabel: "Don't show again",
        onDismiss: () => {
          setInstallHintDismissed(true);
          try {
            window.localStorage.setItem(INSTALL_HINT_DISMISSED_KEY, "1");
          } catch {
            // Storage can be unavailable; the hint then returns on the next load.
          }
        },
      },
    };
  }

  if (notice.kind === "relaunch") {
    return {
      blocksSend: false,
      item: {
        id: `cursor-mcp:relaunch:${folderKey}`,
        variant: "warning",
        icon: <RotateCwIcon />,
        title: `Restart ${APP_BASE_NAME} to use ${formatServerNames(notice.names)} in Cursor`,
        description: canRelaunch
          ? "Cursor loaded this folder's MCP sign-ins before you signed in, and only reads them again after a restart."
          : `Cursor loaded this folder's MCP sign-ins before you signed in. Restart the ${APP_BASE_NAME} server on that machine to use them.`,
        actions: canRelaunch ? (
          <Button size="xs" variant="ghost" onClick={() => void relaunchDesktopApp()}>
            Relaunch {APP_BASE_NAME}
          </Button>
        ) : undefined,
        dismissLabel: "Dismiss",
        onDismiss: dismiss,
      },
    };
  }

  return {
    blocksSend,
    item: {
      id: `cursor-mcp:sign-in:${folderKey}`,
      variant: blocksSend ? "warning" : "info",
      icon: <KeyRoundIcon />,
      title: `${formatServerNames(notice.names)} ${notice.names.length === 1 ? "needs" : "need"} sign-in for this folder`,
      description: notice.needsRelaunchAfter
        ? `Cursor saves MCP sign-ins per folder. This folder is already loaded, so relaunch ${APP_BASE_NAME} after signing in.`
        : `Cursor saves MCP sign-ins per folder. Sign in before the first message so the agent can use them; your browser opens on the machine running ${APP_BASE_NAME}.`,
      actions: (
        <>
          {notice.names.map((name) => (
            <Button
              key={name}
              size="xs"
              variant="ghost"
              disabled={!canManage || signingIn !== null}
              onClick={() => void signInTo(name)}
            >
              {signingIn === name ? `Signing in to ${name}…` : `Sign in to ${name}`}
            </Button>
          ))}
          {blocksSend ? (
            <Button size="xs" variant="ghost-muted" onClick={dismiss}>
              Continue anyway
            </Button>
          ) : null}
        </>
      ),
      ...(blocksSend ? {} : { dismissLabel: "Dismiss", onDismiss: dismiss }),
    },
  };
}
