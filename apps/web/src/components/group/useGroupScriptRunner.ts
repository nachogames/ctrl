import type { EnvironmentThreadGroup } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthTerminalOperateScope,
  type ProjectScript,
  type ThreadGroupRunningResource,
  type ThreadId,
} from "@t3tools/contracts";
import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
  projectScriptTerminalId,
} from "@t3tools/shared/projectScripts";
import { loopbackPort } from "@t3tools/shared/threadGroups";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useEnvironmentScope } from "~/state/session";
import { terminalEnvironment } from "~/state/terminal";
import { useKnownTerminalSessions } from "~/state/terminalSessions";
import { useAtomCommand } from "~/state/use-atom-command";

import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  START_PENDING_MS,
  busyScriptIds,
  scriptStartState,
  settlePendingStarts,
  type PendingStart,
  type ScriptStartState,
} from "./useGroupScriptRunner.logic";

/** The size the chat's own script runs open their terminals at. */
const SCRIPT_TERMINAL_SIZE = { cols: 120, rows: 30 } as const;

export interface GroupScriptRunner {
  readonly canOperate: boolean;
  /** Start and Restart offer themselves only while this is "idle". */
  readonly startState: (scriptId: string) => ScriptStartState;
  /** Runs `script` in its `script-<id>` terminal on `threadId`, reusing it when it exists. */
  readonly start: (script: ProjectScript, threadId: ThreadId) => Promise<void>;
  /** Sends Ctrl-C to a server's terminal; one that is gone drops from the next scan. */
  readonly stop: (terminal: {
    readonly threadId: ThreadId;
    readonly terminalId: string;
  }) => Promise<void>;
}

/**
 * Start and stop a group's scripts in the group's workspace. `resources` is the
 * panel's scan, which ends a script's "Starting…" once its server shows up.
 */
export function useGroupScriptRunner(
  group: EnvironmentThreadGroup,
  projectRoot: string | null,
  scripts: ReadonlyArray<ProjectScript>,
  resources: ReadonlyArray<ThreadGroupRunningResource> | null,
): GroupScriptRunner {
  const canOperate =
    useEnvironmentScope(group.environmentId, AuthTerminalOperateScope) && projectRoot !== null;
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });

  const [pending, setPending] = useState<ReadonlyArray<PendingStart>>([]);
  useEffect(() => {
    const now = Date.now();
    // oxlint-disable-next-line react/set-state-in-effect -- A scan that shows the server ends its "Starting…".
    setPending((current) => settlePendingStarts(current, resources, now));
  }, [resources]);
  // Wakes once, when the oldest "Starting…" runs out.
  useEffect(() => {
    if (pending.length === 0) return;
    const oldest = Math.min(...pending.map((entry) => entry.at));
    const id = setTimeout(
      () => {
        const now = Date.now();
        setPending((current) => settlePendingStarts(current, null, now));
      },
      // A little slack so the wake never lands just before the deadline.
      Math.max(0, oldest + START_PENDING_MS - Date.now()) + 50,
    );
    return () => clearTimeout(id);
  }, [pending]);

  const terminals = useKnownTerminalSessions({
    environmentId: group.environmentId,
    threadId: null,
  });
  const busy = useMemo(
    () =>
      busyScriptIds(
        (terminals ?? []).map((session) => ({
          threadId: session.target.threadId,
          terminalId: session.target.terminalId,
          hasRunningSubprocess: session.state.hasRunningSubprocess,
        })),
        new Set(group.threadIds),
        scripts.map((script) => script.id),
      ),
    [group.threadIds, scripts, terminals],
  );
  const startState = useCallback(
    (scriptId: string) => scriptStartState(scriptId, pending, busy),
    [busy, pending],
  );

  const start = useCallback(
    async (script: ProjectScript, threadId: ThreadId) => {
      if (!canOperate || projectRoot === null) return;
      // A second click would type the command into the script that is already starting.
      if (startState(script.id) !== "idle") return;
      const at = Date.now();
      const port = script.previewUrl === undefined ? null : loopbackPort(script.previewUrl);
      setPending((current) => [
        ...current.filter((entry) => entry.scriptId !== script.id),
        { scriptId: script.id, port, at },
      ]);
      const settle = () => setPending((current) => current.filter((entry) => entry.at !== at));
      const project = { cwd: projectRoot };
      const terminalId = projectScriptTerminalId(script.id);
      const report = (interrupted: boolean, error: unknown) => {
        if (interrupted) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not start ${script.name}`,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      };
      const opened = await openTerminal({
        environmentId: group.environmentId,
        input: {
          threadId,
          terminalId,
          cwd: projectScriptCwd({ project, worktreePath: group.worktreePath }),
          worktreePath: group.worktreePath,
          env: projectScriptRuntimeEnv({ project, worktreePath: group.worktreePath }),
          ...SCRIPT_TERMINAL_SIZE,
        },
      });
      if (opened._tag === "Failure") {
        settle();
        return report(isAtomCommandInterrupted(opened), squashAtomCommandFailure(opened));
      }
      const written = await writeTerminal({
        environmentId: group.environmentId,
        input: { threadId, terminalId, data: `${script.command}\r` },
      });
      if (written._tag === "Failure") {
        settle();
        report(isAtomCommandInterrupted(written), squashAtomCommandFailure(written));
      }
    },
    [
      canOperate,
      group.environmentId,
      group.worktreePath,
      openTerminal,
      projectRoot,
      startState,
      writeTerminal,
    ],
  );

  const stop = useCallback(
    async (terminal: { readonly threadId: ThreadId; readonly terminalId: string }) => {
      if (!canOperate) return;
      await writeTerminal({
        environmentId: group.environmentId,
        input: { threadId: terminal.threadId, terminalId: terminal.terminalId, data: "\x03" },
      });
    },
    [canOperate, group.environmentId, writeTerminal],
  );

  return { canOperate, startState, start, stop };
}
