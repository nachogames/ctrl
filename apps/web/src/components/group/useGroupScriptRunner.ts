import type { EnvironmentThreadGroup } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthTerminalOperateScope, type ProjectScript, type ThreadId } from "@t3tools/contracts";
import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
  projectScriptTerminalId,
} from "@t3tools/shared/projectScripts";
import { useCallback } from "react";

import { useEnvironmentScope } from "~/state/session";
import { terminalEnvironment } from "~/state/terminal";
import { useAtomCommand } from "~/state/use-atom-command";

import { stackedThreadToast, toastManager } from "../ui/toast";

/** The size the chat's own script runs open their terminals at. */
const SCRIPT_TERMINAL_SIZE = { cols: 120, rows: 30 } as const;

export interface GroupScriptRunner {
  readonly canOperate: boolean;
  /** Runs `script` in its `script-<id>` terminal on `threadId`, reusing it when it exists. */
  readonly start: (script: ProjectScript, threadId: ThreadId) => Promise<void>;
  /** Sends Ctrl-C to a server's terminal; one that is gone drops from the next scan. */
  readonly stop: (terminal: {
    readonly threadId: ThreadId;
    readonly terminalId: string;
  }) => Promise<void>;
}

/** Start and stop a group's scripts in the group's workspace. */
export function useGroupScriptRunner(
  group: EnvironmentThreadGroup,
  projectRoot: string | null,
): GroupScriptRunner {
  const canOperate =
    useEnvironmentScope(group.environmentId, AuthTerminalOperateScope) && projectRoot !== null;
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });

  const start = useCallback(
    async (script: ProjectScript, threadId: ThreadId) => {
      if (!canOperate || projectRoot === null) return;
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
        return report(isAtomCommandInterrupted(opened), squashAtomCommandFailure(opened));
      }
      const written = await writeTerminal({
        environmentId: group.environmentId,
        input: { threadId, terminalId, data: `${script.command}\r` },
      });
      if (written._tag === "Failure") {
        report(isAtomCommandInterrupted(written), squashAtomCommandFailure(written));
      }
    },
    [canOperate, group.environmentId, group.worktreePath, openTerminal, projectRoot, writeTerminal],
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

  return { canOperate, start, stop };
}
