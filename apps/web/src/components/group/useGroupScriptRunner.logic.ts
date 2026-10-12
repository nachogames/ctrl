import type { ThreadGroupRunningResource } from "@t3tools/contracts";
import { projectScriptTerminalId } from "@t3tools/shared/projectScripts";

/** How long a Start click shows "Starting…" when no scan confirms the server. */
export const START_PENDING_MS = 15_000;

export interface PendingStart {
  readonly scriptId: string;
  /** The script's preview port, which also confirms the start when it listens. */
  readonly port: number | null;
  readonly at: number;
}

/**
 * "starting" after a click until a scan shows the script or 15 s pass; "busy"
 * while its `script-<id>` terminal runs something, so Start would only type into it.
 */
export type ScriptStartState = "idle" | "starting" | "busy";

/** Pending starts that are younger than 15 s and that no scan has confirmed yet. */
export function settlePendingStarts(
  pending: ReadonlyArray<PendingStart>,
  resources: ReadonlyArray<ThreadGroupRunningResource> | null,
  now: number,
): ReadonlyArray<PendingStart> {
  const running = (resources ?? []).filter((resource) => resource.kind !== "manual");
  const kept = pending.filter(
    (start) =>
      now - start.at < START_PENDING_MS &&
      !running.some(
        (resource) =>
          resource.scriptId === start.scriptId ||
          (start.port !== null && resource.port === start.port),
      ),
  );
  return kept.length === pending.length ? pending : kept;
}

/** Scripts whose `script-<id>` terminal, on one of `threadIds`, runs a subprocess. */
export function busyScriptIds(
  terminals: ReadonlyArray<{
    readonly threadId: string;
    readonly terminalId: string;
    readonly hasRunningSubprocess: boolean;
  }>,
  threadIds: ReadonlySet<string>,
  scriptIds: ReadonlyArray<string>,
): ReadonlySet<string> {
  return new Set(
    scriptIds.filter((scriptId) =>
      terminals.some(
        (terminal) =>
          terminal.hasRunningSubprocess &&
          threadIds.has(terminal.threadId) &&
          terminal.terminalId === projectScriptTerminalId(scriptId),
      ),
    ),
  );
}

export function scriptStartState(
  scriptId: string,
  pending: ReadonlyArray<PendingStart>,
  busy: ReadonlySet<string>,
): ScriptStartState {
  if (pending.some((start) => start.scriptId === scriptId)) return "starting";
  return busy.has(scriptId) ? "busy" : "idle";
}
