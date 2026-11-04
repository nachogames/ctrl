import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { newMessageId } from "~/lib/utils";
import { toastManager } from "../components/ui/toast";
import { useStableCallback } from "../hooks/useStableCallback";
import { useThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import {
  VOICE_STARTER_MESSAGE,
  clearVoiceAfterFirstTurn,
  onVoiceSessionMissing,
  startVoiceAfterFirstTurn,
  voiceAfterFirstTurnStatus,
} from "@t3tools/client-runtime/voice-mode";
import type { VoiceAvailability } from "./voiceAvailability";
import { useVoicePhaseFor, voiceMode } from "./voiceMode";

export type OneClickVoicePhase = "idle" | "connecting" | "active";

/**
 * Codex voice on `threadRef` from a single button, with no chat open. Voice
 * talks in the thread's provider session; when there is none yet, or it idled
 * out, a one-line starter turn opens it and voice connects once that turn ends.
 */
export function useOneClickVoice(threadRef: ScopedThreadRef, availability: VoiceAvailability) {
  const thread = useThreadShell(threadRef);
  const voicePhase = useVoicePhaseFor(threadRef);
  // Re-renders after the wait for a starter turn is dropped, which voice state does not show.
  const [, setWaitVersion] = useState(0);
  const dropWait = () => {
    clearVoiceAfterFirstTurn(threadRef);
    setWaitVersion((version) => version + 1);
  };
  // One starter turn per click: a second missing session is reported, not retried.
  const recoveredRef = useRef(false);
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });

  const warmUp = useStableCallback(() => {
    if (thread === null) return false;
    recoveredRef.current = true;
    startVoiceAfterFirstTurn(threadRef);
    setWaitVersion((version) => version + 1);
    void startThreadTurn({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: VOICE_STARTER_MESSAGE,
          attachments: [],
        },
        titleSeed: deriveThreadTitleSeed({ text: VOICE_STARTER_MESSAGE, attachments: [] }),
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: new Date().toISOString(),
      },
    }).then((result) => {
      if (result._tag === "Success") return;
      dropWait();
      toastManager.add({ type: "error", title: "Couldn't start voice" });
    });
    return true;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this thread's recovery with the voice controller, which reports a missing session outside React
  useEffect(
    () => onVoiceSessionMissing(threadRef, () => !recoveredRef.current && warmUp()),
    [threadRef, warmUp],
  );

  const turnPhase = threadRuntimeIsActive(thread?.runtime) ? "running" : "ready";
  const waitStatus = voiceAfterFirstTurnStatus(threadRef, turnPhase);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- connects voice once the starter turn has run and given the thread a session
  useEffect(() => {
    if (waitStatus !== "ready") return;
    clearVoiceAfterFirstTurn(threadRef);
    void voiceMode.start(threadRef);
  }, [threadRef, waitStatus]);

  const toggle = useStableCallback(() => {
    if (voicePhase !== "idle" || waitStatus !== "none") {
      dropWait();
      voiceMode.stop();
      return;
    }
    if (availability.kind === "unsupported") return;
    recoveredRef.current = false;
    if (availability.kind === "ready") void voiceMode.start(threadRef);
    else warmUp();
  });

  const phase: OneClickVoicePhase = waitStatus !== "none" ? "connecting" : voicePhase;
  return { phase, toggle };
}
