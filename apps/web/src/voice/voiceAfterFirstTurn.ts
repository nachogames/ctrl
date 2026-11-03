import type { VoiceSessionTarget } from "@t3tools/client-runtime/voice-mode";

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
