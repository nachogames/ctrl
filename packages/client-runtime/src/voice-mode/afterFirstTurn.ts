import type { VoiceSessionTarget } from "./controller.ts";

// Threads whose voice waits for their first turn, by thread key, and whether
// that turn was seen running. A draft keeps its thread id when it is sent, so
// the key survives the draft becoming a thread.
const voiceAfterFirstTurn = new Map<string, { sawRunning: boolean }>();
const voiceKey = (target: VoiceSessionTarget) => `${target.environmentId}:${target.threadId}`;

/** Starts voice on `target` once its first turn has run and given it a session. */
export function startVoiceAfterFirstTurn(target: VoiceSessionTarget) {
  voiceAfterFirstTurn.set(voiceKey(target), { sawRunning: false });
}

/**
 * Where `target`'s wait stands, given the thread's phase now: "none" when it
 * is not waiting, "ready" once its turn has run and ended. The thread records
 * a provider thread before that turn's session exists, so it must run first.
 */
export function voiceAfterFirstTurnStatus(
  target: VoiceSessionTarget,
  phase: string,
): "none" | "waiting" | "ready" {
  const wait = voiceAfterFirstTurn.get(voiceKey(target));
  if (wait === undefined) return "none";
  if (phase === "running") wait.sawRunning = true;
  return wait.sawRunning && phase === "ready" ? "ready" : "waiting";
}

export function clearVoiceAfterFirstTurn(target: VoiceSessionTarget) {
  voiceAfterFirstTurn.delete(voiceKey(target));
}

/** The first message a thread sends when voice starts it, so Codex has a session to talk in. */
export const VOICE_STARTER_MESSAGE = "Starting a voice conversation. Reply with one word: Ready.";

const sessionRecoveries = new Map<string, () => boolean>();

/**
 * Lets `target` recover when voice finds no running provider session, as after
 * the session idled out: `recover` starts one and returns true, or returns
 * false to report the failure. Returns the unregister function.
 */
export function onVoiceSessionMissing(target: VoiceSessionTarget, recover: () => boolean) {
  const key = voiceKey(target);
  sessionRecoveries.set(key, recover);
  return () => {
    if (sessionRecoveries.get(key) === recover) sessionRecoveries.delete(key);
  };
}

/**
 * Hands a failed start to its thread's recovery when the failure was a
 * missing provider session. True when the recovery took it over, so the
 * failure is not reported.
 */
export function recoverMissingVoiceSession(input: {
  readonly target: VoiceSessionTarget;
  readonly error: string;
}): boolean {
  // The server's answer when a thread has no running provider session to talk in.
  if (!input.error.includes("Send a message first")) return false;
  return sessionRecoveries.get(voiceKey(input.target))?.() === true;
}
