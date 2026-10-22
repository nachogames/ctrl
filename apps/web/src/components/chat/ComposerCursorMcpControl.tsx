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
import { PlugIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { APP_BASE_NAME } from "~/branding";
import { cn } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  type ComposerControlSize,
} from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { cursorMcpServerAction, cursorMcpServersNeedingAction } from "./cursorMcpSignIn";
import { useComposerMenuState } from "./useComposerMenuState";

// Each check runs Cursor's CLI, which connects to every MCP server, so switching
// between threads in one folder reuses a recent answer.
const RECENT_CHECK_MS = 2 * 60_000;
const CHECK_RETRY_MS = 2_000;
const CHECK_RETRIES = 15;
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

export type CursorMcpControlState = NonNullable<ReturnType<typeof useCursorMcpStatus>>;

/**
 * A Cursor thread's MCP servers and whether each is signed in for its folder.
 * Cursor saves sign-ins per folder and reads them once per server process, so
 * sign-in and restart both live here. Null until there is something to show.
 */
export function useCursorMcpStatus(input: {
  readonly environmentId: EnvironmentId;
  /** The folder the thread's Cursor agent runs in; null for other providers. */
  readonly folder: CursorMcpFolderInput | null;
  /** The first message loads the folder, which changes the answer, so it re-checks. */
  readonly firstTurn: boolean;
}) {
  const { environmentId, folder } = input;
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const readStatus = useAtomCommand(serverEnvironment.cursorMcpStatus, { reportFailure: false });
  const signIn = useAtomCommand(serverEnvironment.cursorMcpSignIn, { reportFailure: false });
  const restart = useRestartServerForCursorMcp(environmentId);
  const folderKey =
    canRead && folder !== null
      ? `${environmentId}:${folder.threadId ?? ""}:${folder.projectId ?? ""}:${folder.providerInstanceId ?? ""}:${input.firstTurn}`
      : null;
  const [checked, setChecked] = useState<{
    readonly key: string;
    readonly status: CursorMcpStatusResult;
  } | null>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);

  const remember = (key: string, status: CursorMcpStatusResult) => {
    recentChecks.set(key, { at: Date.now(), status });
    setChecked({ key, status });
  };
  const check = useEffectEvent(async (key: string) => {
    if (folder === null) return true;
    const result = await readStatus({ environmentId, input: folder });
    if (result._tag !== "Success") return false;
    remember(key, result.value);
    return true;
  });
  useEffect(() => {
    if (folderKey === null) return;
    const recent = recentChecks.get(folderKey);
    if (recent !== undefined && Date.now() - recent.at < RECENT_CHECK_MS) return;
    // Right after a reload the environment may not be connected yet, so a
    // failed check tries again for a while instead of leaving no control.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async (count: number) => {
      const done = await check(folderKey);
      if (done || cancelled || count >= CHECK_RETRIES) return;
      timer = setTimeout(() => void attempt(count + 1), CHECK_RETRY_MS);
    };
    void attempt(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [folderKey]);

  const status =
    folderKey === null
      ? null
      : checked !== null && checked.key === folderKey
        ? checked.status
        : (recentChecks.get(folderKey)?.status ?? null);
  if (folder === null || folderKey === null || status === null) return null;
  if (status.cliAvailable && status.servers.length === 0) return null;

  const signInTo = async (name: string) => {
    if (signingIn !== null) return;
    setSigningIn(name);
    const result = await signIn({ environmentId, input: { ...folder, name } });
    setSigningIn(null);
    if (result._tag === "Success") remember(folderKey, result.value);
    else reportFailure(`Could not sign in to ${name}`, result);
  };

  return {
    status,
    needingAction: cursorMcpServersNeedingAction(status),
    canManage,
    signingIn,
    signInTo,
    restart,
  };
}

function ServerIcon({ server }: { readonly server: CursorMcpServer }) {
  const [failed, setFailed] = useState(false);
  if (server.iconUrl === undefined || failed) {
    return <PlugIcon className="size-4 text-muted-foreground" />;
  }
  return (
    <img
      src={server.iconUrl}
      alt=""
      className="size-4 rounded-xs"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function ServerStatus({ server }: { readonly server: CursorMcpServer }) {
  const action = cursorMcpServerAction(server);
  const [label, tone] =
    action === "restart"
      ? ["Restart to use", "text-warning"]
      : action === "sign_in"
        ? ["Sign in", "text-warning"]
        : server.status === "ready"
          ? ["Ready", "text-success"]
          : server.status === "error"
            ? ["Error", "text-destructive-foreground"]
            : ["Unknown", "text-muted-foreground"];
  return (
    <span className={cn("ms-auto flex items-center gap-1.5 text-xs", tone)}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

/** The server list and actions, shared by the inline dropdown and the overflow menu. */
export function CursorMcpMenuContent(props: { readonly mcp: CursorMcpControlState }) {
  const { status, canManage, signingIn, signInTo, restart } = props.mcp;
  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const needsRestart = status.servers.some((server) => cursorMcpServerAction(server) === "restart");
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>Cursor MCP servers</MenuGroupLabel>
        {!status.cliAvailable ? (
          <p className="max-w-72 px-2 pb-1.5 text-muted-foreground text-xs">
            Install Cursor's command-line tool on the machine running {APP_BASE_NAME} to check
            sign-ins: <code className="font-mono">{status.installCommand}</code>
          </p>
        ) : null}
        {status.servers.map((server) => {
          const canSignIn = cursorMcpServerAction(server) === "sign_in" && canManage;
          return (
            <MenuItem
              key={server.name}
              className="min-w-64"
              disabled={canSignIn && signingIn !== null}
              closeOnClick={false}
              onClick={() => canSignIn && void signInTo(server.name)}
            >
              <ServerIcon server={server} />
              <span className="truncate">{server.name}</span>
              {canSignIn ? (
                <Button render={<span />} size="xs" variant="outline" className="ms-auto">
                  {signingIn === server.name ? "Signing in…" : "Sign in"}
                </Button>
              ) : (
                <ServerStatus server={server} />
              )}
            </MenuItem>
          );
        })}
      </MenuGroup>
      {signingIn !== null ? (
        <p className="whitespace-nowrap px-2 pb-1.5 text-muted-foreground text-xs">
          Finish in the browser on the machine running {APP_BASE_NAME}.
        </p>
      ) : null}
      {needsRestart ? (
        <>
          <MenuSeparator />
          {status.canRestartServer && restart.canMaintain ? (
            <MenuItem
              variant={confirmingRestart ? "destructive" : "default"}
              closeOnClick={confirmingRestart}
              disabled={restart.restarting}
              onClick={() =>
                confirmingRestart ? void restart.restart() : setConfirmingRestart(true)
              }
            >
              <RotateCwIcon />
              {restart.restarting
                ? "Restarting…"
                : confirmingRestart
                  ? "Restart now? Running turns stop"
                  : `Restart ${APP_BASE_NAME} to use new sign-ins`}
            </MenuItem>
          ) : (
            <p className="whitespace-nowrap px-2 py-1.5 text-muted-foreground text-xs">
              Restart the {APP_BASE_NAME} server on that machine to use new sign-ins.
            </p>
          )}
        </>
      ) : null}
    </>
  );
}

/** The MCP dropdown in the composer's control row, beside the model and access pickers. */
export function ComposerCursorMcpControl(props: {
  readonly mcp: CursorMcpControlState;
  readonly size: ComposerControlSize;
  readonly hidden: boolean;
}) {
  const menuProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const attention = props.mcp.needingAction.length;
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            size={props.size}
            aria-label={attention > 0 ? `MCP servers, ${attention} need attention` : "MCP servers"}
          />
        }
      >
        <span className="relative flex">
          <ComposerControlIcon icon={PlugIcon} size={props.size} />
          {attention > 0 ? (
            <span
              aria-hidden
              className="-end-0.5 -top-0.5 absolute size-1.5 rounded-full bg-warning"
            />
          ) : null}
        </span>
        <span data-composer-control-label className="sr-only sm:not-sr-only">
          MCP
        </span>
        <ComposerControlChevron size={props.size} />
      </MenuTrigger>
      <MenuPopup align="start" {...menuProps}>
        <CursorMcpMenuContent mcp={props.mcp} />
      </MenuPopup>
    </Menu>
  );
}
