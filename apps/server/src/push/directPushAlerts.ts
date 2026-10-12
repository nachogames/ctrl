import {
  DEFAULT_DIRECT_PUSH_ALERT_KINDS,
  type DirectPushAlertKind,
  type PushAlertMessage,
} from "@t3tools/contracts";
import {
  type AgentAwarenessPhase,
  type AgentAwarenessState,
  headlineForPhase,
} from "@t3tools/shared/agentAwareness";

/** A finished run older than this is history, not news. Matches the relay. */
export const TERMINAL_ALERT_FRESHNESS_MS = 2 * 60_000;

const ALERTS: Partial<Record<AgentAwarenessPhase, DirectPushAlertKind>> = {
  waiting_for_approval: "approval",
  waiting_for_input: "input",
  completed: "completed",
  failed: "failed",
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
  const kind = state === null ? undefined : ALERTS[state.phase];
  if (state === null || kind === undefined || state.phase === input.previousPhase) return null;
  if (kind === "completed" || kind === "failed") {
    if (input.previousPhase === undefined && !input.finishedSinceStart) return null;
    if (input.nowMs - Date.parse(state.updatedAt) > TERMINAL_ALERT_FRESHNESS_MS) return null;
  }
  return kind;
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
  return ALERTS[previousPhase as AgentAwarenessPhase] ?? null;
}

/**
 * The state to alert on when a subagent stops on a question: the parent's
 * thread, which phones can open and which shows the child's question, in the
 * child's waiting phase. Subagent threads are hidden from thread lists, so an
 * alert for the child itself would lead nowhere.
 */
export function subagentQuestionState(
  parent: AgentAwarenessState,
  question: Extract<AgentAwarenessPhase, "waiting_for_input" | "waiting_for_approval"> | null,
  childUpdatedAt: string,
): AgentAwarenessState | null {
  if (question === null) return null;
  return {
    ...parent,
    phase: question,
    headline: headlineForPhase(question),
    updatedAt: childUpdatedAt,
  };
}

export function deviceWantsAlert(
  alertOn: ReadonlyArray<DirectPushAlertKind> | undefined,
  kind: DirectPushAlertKind,
): boolean {
  return (alertOn ?? DEFAULT_DIRECT_PUSH_ALERT_KINDS).includes(kind);
}

/** The fixed-format alert for a thread's state, sent directly or through the relay. */
export function alertMessage(
  state: AgentAwarenessState,
  kind: DirectPushAlertKind,
): PushAlertMessage {
  return {
    type: "alert",
    kind,
    environmentId: state.environmentId,
    threadId: state.threadId,
    threadTitle: state.threadTitle,
    projectTitle: state.projectTitle,
    updatedAt: state.updatedAt,
  };
}
