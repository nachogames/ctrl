import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import {
  VOICE_STARTER_MESSAGE,
  clearVoiceAfterFirstTurn,
  onVoiceSessionMissing,
  startVoiceAfterFirstTurn,
  voiceAfterFirstTurnStatus,
  type VoiceModePhase,
} from "@t3tools/client-runtime/voice-mode";
import { MessageId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Alert } from "react-native";

import { uuidv4 } from "../../lib/uuid";
import { useThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useVoiceModePhase } from "./useVoiceMode";
import { voiceMode } from "./voiceMode";

/**
 * Codex voice on a thread from a single button, with no chat open. Voice talks
 * in the thread's provider session, which the server reopens if it idled out;
 * when there is none yet, a one-line starter turn opens it and voice connects
 * once that turn ends.
 */
export function useOneClickVoice(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): { readonly phase: VoiceModePhase; readonly toggle: () => void } {
  const { environmentId, threadId } = input;
  const target = { environmentId, threadId };
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const voicePhase = useVoiceModePhase(target);
  // Re-renders after the wait for a starter turn is dropped, which voice state does not show.
  const [, setWaitVersion] = useState(0);
  // One starter turn per press: a second missing session is reported, not retried.
  const recoveredRef = useRef(false);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, {
    label: "start voice",
    reportFailure: false,
  });

  const dropWait = () => {
    clearVoiceAfterFirstTurn(target);
    setWaitVersion((version) => version + 1);
  };

  const warmUp = (): boolean => {
    if (thread === null) return false;
    recoveredRef.current = true;
    startVoiceAfterFirstTurn(target);
    setWaitVersion((version) => version + 1);
    void startTurn({
      environmentId,
      input: {
        creationSource: "mobile",
        threadId,
        message: {
          messageId: MessageId.make(uuidv4()),
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
      Alert.alert("Couldn't start voice");
    });
    return true;
  };

  const recover = useEffectEvent(() => !recoveredRef.current && warmUp());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this thread's recovery with the voice controller, which reports a missing session outside React
  useEffect(
    () => onVoiceSessionMissing({ environmentId, threadId }, () => recover()),
    [environmentId, threadId],
  );

  const turnPhase = threadRuntimeIsActive(thread?.runtime) ? "running" : "ready";
  const waitStatus = voiceAfterFirstTurnStatus(target, turnPhase);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- connects voice once the starter turn has run and given the thread a session
  useEffect(() => {
    if (waitStatus !== "ready") return;
    clearVoiceAfterFirstTurn({ environmentId, threadId });
    void voiceMode.start({ environmentId, threadId });
  }, [environmentId, threadId, waitStatus]);

  const toggle = () => {
    if (voicePhase !== "idle" || waitStatus !== "none") {
      dropWait();
      voiceMode.stop();
      return;
    }
    recoveredRef.current = false;
    if (thread?.activeProviderThreadId != null) void voiceMode.start(target);
    else warmUp();
  };

  return { phase: waitStatus !== "none" ? "connecting" : voicePhase, toggle };
}
