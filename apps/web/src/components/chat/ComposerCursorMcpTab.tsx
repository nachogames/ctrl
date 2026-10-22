import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  type CursorMcpFolderInput,
  type CursorMcpServer,
  type CursorMcpStatusResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { PlugIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { APP_BASE_NAME } from "~/branding";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { ComposerBanner } from "./ComposerBanner";
import { composerFloatingLayerProps } from "./composerEventScope";
import { cursorMcpServerAction, cursorMcpServersNeedingAction } from "./cursorMcpSignIn";

// Each check runs Cursor's CLI, which connects to every MCP server, so switching
// between threads in one folder reuses a recent answer.
const RECENT_CHECK_MS = 2 * 60_000;
const recentChecks = new Map<
  string,
  { readonly at: number; readonly status: CursorMcpStatusResult }
>();

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : undefined,
  });
}

/**
 * Restarts the environment's server, which the desktop app or background
 * service starts again. Cursor only rereads a loaded folder's sign-ins then.
 */
export function useRestartServerForCursorMcp(environmentId: EnvironmentId | null) {
  const canMaintain = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const restartServer = useAtomCommand(serverEnvironment.cursorMcpRestartServer, {
    reportFailure: false,
  });
  const [restarting, setRestarting] = useState(false);
  const restart = async () => {
    if (environmentId === null || restarting) return;
    setRestarting(true);
    const result = await restartServer({ environmentId, input: {} });
    if (result._tag === "Success") {
      recentChecks.clear();
      toastManager.add({
        type: "info",
        title: `Restarting ${APP_BASE_NAME}`,
        description: "It reconnects on its own in a few seconds.",
      });
    } else {
      setRestarting(false);
      reportFailure(`Could not restart ${APP_BASE_NAME}`, result);
    }
  };
  return { canMaintain, restarting, restart };
}

function serverStatusLabel(server: CursorMcpServer) {
  switch (cursorMcpServerAction(server)) {
    case "restart":
      return <Badge variant="warning">Restart to use</Badge>;
    case "sign_in":
      return <Badge variant="warning">Signed out</Badge>;
    case null:
      break;
  }
  switch (server.status) {
    case "ready":
      return <Badge variant="success">Ready</Badge>;
    case "error":
      return <Badge variant="error">Error</Badge>;
    default:
      return <Badge variant="outline">Unknown</Badge>;
  }
}

/**
 * A Cursor thread's MCP servers and whether each is signed in for its folder,
 * as a tab on the composer. Cursor saves sign-ins per folder and reads them
 * once per server process, so sign-in and restart both live here.
 */
export function ComposerCursorMcpTab(props: {
  readonly environmentId: EnvironmentId;
  /** The folder the thread's Cursor agent runs in. */
  readonly folder: CursorMcpFolderInput;
  /** The first message loads the folder, which changes the answer, so it re-checks. */
  readonly firstTurn: boolean;
}) {
  const { environmentId, folder } = props;
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const readStatus = useAtomCommand(serverEnvironment.cursorMcpStatus, { reportFailure: false });
  const signIn = useAtomCommand(serverEnvironment.cursorMcpSignIn, { reportFailure: false });
  const restart = useRestartServerForCursorMcp(environmentId);
  const folderKey = canRead
    ? `${environmentId}:${folder.threadId ?? ""}:${folder.projectId ?? ""}:${props.firstTurn}`
    : null;
  const [checked, setChecked] = useState<{
    readonly key: string;
    readonly status: CursorMcpStatusResult;
  } | null>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [confirmingRestart, setConfirmingRestart] = useState(false);

  const remember = (key: string, status: CursorMcpStatusResult) => {
    recentChecks.set(key, { at: Date.now(), status });
    setChecked({ key, status });
  };
  const check = useEffectEvent(async (key: string) => {
    const result = await readStatus({ environmentId, input: folder });
    if (result._tag === "Success") remember(key, result.value);
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
  if (folderKey === null || status === null) return null;
  if (status.cliAvailable && status.servers.length === 0) return null;
  const needingAction = cursorMcpServersNeedingAction(status);
  const needsRestart = needingAction.some((server) => cursorMcpServerAction(server) === "restart");

  const signInTo = async (name: string) => {
    if (signingIn !== null) return;
    setSigningIn(name);
    const result = await signIn({ environmentId, input: { ...folder, name } });
    setSigningIn(null);
    if (result._tag === "Success") remember(folderKey, result.value);
    else reportFailure(`Could not sign in to ${name}`, result);
  };

  return (
    <Popover onOpenChange={(open) => !open && setConfirmingRestart(false)}>
      <ComposerBanner.Root density="comfortable" width="content" data-composer-shoulder-tab>
        <PopoverTrigger
          render={
            <ComposerBanner.Row
              render={<button type="button" />}
              className="text-muted-foreground transition-colors duration-200 hover:text-foreground"
            />
          }
          aria-label={
            needingAction.length > 0
              ? `MCP servers: ${needingAction.length} need attention`
              : "MCP servers"
          }
        >
          <ComposerBanner.Icon>
            <PlugIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>MCP</ComposerBanner.Content>
          {needingAction.length > 0 ? (
            <ComposerBanner.Actions>
              <ComposerBanner.Dot className="me-1.5 text-warning" />
            </ComposerBanner.Actions>
          ) : null}
        </PopoverTrigger>
      </ComposerBanner.Root>
      <PopoverPopup
        {...composerFloatingLayerProps}
        side="top"
        align="end"
        width="md"
        padding="compact"
      >
        <div className="flex flex-col gap-2 text-sm">
          <p className="font-medium">Cursor MCP servers</p>
          {!status.cliAvailable ? (
            <p className="text-muted-foreground text-xs">
              Install Cursor's command-line tool on the machine running {APP_BASE_NAME} to check
              sign-ins: <code className="font-mono">{status.installCommand}</code>
            </p>
          ) : null}
          <ul className="flex flex-col gap-1">
            {status.servers.map((server) => (
              <li key={server.name} className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{server.name}</span>
                {serverStatusLabel(server)}
                {cursorMcpServerAction(server) === "sign_in" ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!canManage || signingIn !== null}
                    onClick={() => void signInTo(server.name)}
                  >
                    {signingIn === server.name ? "Signing in…" : "Sign in"}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {signingIn !== null ? (
            <p className="text-muted-foreground text-xs">
              Finish signing in in the browser on the machine running {APP_BASE_NAME}.
            </p>
          ) : null}
          {needsRestart ? (
            status.canRestartServer && restart.canMaintain ? (
              <div className="flex flex-col gap-1.5 border-t pt-2">
                <p className="text-muted-foreground text-xs">
                  {confirmingRestart
                    ? "Restarting interrupts every running turn on this server."
                    : `Cursor already loaded this folder, so it uses new sign-ins after ${APP_BASE_NAME} restarts.`}
                </p>
                <Button
                  size="xs"
                  variant={confirmingRestart ? "destructive" : "outline"}
                  className="self-start"
                  disabled={restart.restarting}
                  onClick={() =>
                    confirmingRestart ? void restart.restart() : setConfirmingRestart(true)
                  }
                >
                  {restart.restarting
                    ? "Restarting…"
                    : confirmingRestart
                      ? "Restart now"
                      : `Restart ${APP_BASE_NAME}`}
                </Button>
              </div>
            ) : (
              <p className="border-t pt-2 text-muted-foreground text-xs">
                Cursor already loaded this folder. Restart the {APP_BASE_NAME} server on that
                machine to use new sign-ins.
              </p>
            )
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
