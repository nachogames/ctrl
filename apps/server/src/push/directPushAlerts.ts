import { DEFAULT_DIRECT_PUSH_ALERT_KINDS, type DirectPushAlertKind } from "@t3tools/contracts";
import type { AgentAwarenessPhase, AgentAwarenessState } from "@t3tools/shared/agentAwareness";

/** A finished run older than this is history, not news. Matches the relay. */
export const TERMINAL_ALERT_FRESHNESS_MS = 2 * 60_000;

const ALERTS: Partial<
  Record<AgentAwarenessPhase, { readonly kind: DirectPushAlertKind; readonly status: string }>
> = {
  waiting_for_approval: { kind: "approval", status: "Approval" },
  waiting_for_input: { kind: "input", status: "Input" },
  completed: { kind: "completed", status: "Done" },
  failed: { kind: "failed", status: "Failed" },
};

/**
 * The kind of alert a thread's new awareness state is worth, or null when it
 * should not buzz any phone. `previousPhase` is undefined when this process
 * has not seen the thread since it started; a finished run then only counts
 * when this process finished it, so restarting the server does not replay
 * old completions. Each device then filters by its own `alertOn` choice.
 */
export function alertKind(input: {
  readonly state: AgentAwarenessState | null;
  readonly previousPhase: AgentAwarenessPhase | null | undefined;
  readonly finishedSinceStart: boolean;
  readonly nowMs: number;
}): DirectPushAlertKind | null {
  const { state } = input;
  const alert = state === null ? undefined : ALERTS[state.phase];
  if (state === null || alert === undefined || state.phase === input.previousPhase) return null;
  if (alert.kind === "completed" || alert.kind === "failed") {
    if (input.previousPhase === undefined && !input.finishedSinceStart) return null;
    if (input.nowMs - Date.parse(state.updatedAt) > TERMINAL_ALERT_FRESHNESS_MS) return null;
  }
  return alert.kind;
}

/**
 * The question a thread just stopped waiting on, so phones can drop its
 * alert, or null. Moving straight to another question is not an answer: that
 * question's own alert follows, and a clear racing it could remove it.
 */
export function answeredKind(
  previousPhase: AgentAwarenessPhase | null | undefined,
  phase: AgentAwarenessPhase | null,
): DirectPushAlertKind | null {
  const isQuestion = (value: AgentAwarenessPhase | null | undefined) =>
    value === "waiting_for_approval" || value === "waiting_for_input";
  if (!isQuestion(previousPhase) || isQuestion(phase)) return null;
  return ALERTS[previousPhase as AgentAwarenessPhase]?.kind ?? null;
}

export function deviceWantsAlert(
  alertOn: ReadonlyArray<DirectPushAlertKind> | undefined,
  kind: DirectPushAlertKind,
): boolean {
  return (alertOn ?? DEFAULT_DIRECT_PUSH_ALERT_KINDS).includes(kind);
}

export function alertText(state: AgentAwarenessState): {
  readonly title: string;
  readonly body: string;
} {
  return {
    title: state.threadTitle.slice(0, 120),
    body: `${ALERTS[state.phase]?.status ?? "Update"}: ${state.projectTitle}`.slice(0, 240),
  };
}

/** Same shape the relay sends, so the app's tap routing works unchanged. */
export function apnsAlertPayload(state: AgentAwarenessState) {
  return {
    aps: {
      alert: alertText(state),
      sound: "default",
      "thread-id": `${state.environmentId}/${state.threadId}`,
    },
    environmentId: state.environmentId,
    threadId: state.threadId,
    deepLink: state.deepLink,
  };
}

/** Data message handled natively by the app's AgentMessagingService. */
export function fcmAlertData(input: {
  readonly state: AgentAwarenessState;
  readonly deviceId: string;
  readonly userId: string;
  readonly nowMs: number;
}): Record<string, string> {
  const { state } = input;
  const text = alertText(state);
  return {
    t3_kind: "agent_activity",
    updated_at: String(input.nowMs),
    device_id: input.deviceId,
    user_id: input.userId,
    alert_id: JSON.stringify([state.environmentId, state.threadId, state.phase, state.updatedAt]),
    alert_group: JSON.stringify([state.environmentId, state.threadId]),
    alert_title: text.title,
    alert_body: text.body,
    alert_path: state.deepLink,
    active: "false",
  };
}

/** The thread whose alerts a clear removes, matching the alerts' grouping. */
export interface AlertThread {
  readonly environmentId: string;
  readonly threadId: string;
}

/** Silent push the app handles natively by removing the thread's alerts. */
export function apnsClearPayload(thread: AlertThread) {
  return {
    aps: { "content-available": 1 },
    t3_clear_thread: `${thread.environmentId}/${thread.threadId}`,
  };
}

export function fcmClearData(input: {
  readonly thread: AlertThread;
  readonly deviceId: string;
  readonly userId: string;
  readonly nowMs: number;
}): Record<string, string> {
  return {
    t3_kind: "agent_alert_clear",
    updated_at: String(input.nowMs),
    device_id: input.deviceId,
    user_id: input.userId,
    alert_group: JSON.stringify([input.thread.environmentId, input.thread.threadId]),
  };
}
