import type {
  VoiceModePhase,
  VoiceModeState,
  VoiceSessionTarget,
} from "@t3tools/client-runtime/voice-mode";
import { useCallback, useSyncExternalStore } from "react";

import { voiceMode } from "./voiceMode";

export function useVoiceModeState(): VoiceModeState {
  return useSyncExternalStore(voiceMode.subscribe, voiceMode.getState);
}

/** This thread's conversation phase. A primitive, so captions do not re-render the caller. */
export function useVoiceModePhase(target: VoiceSessionTarget): VoiceModePhase {
  const { environmentId, threadId } = target;
  const getSnapshot = useCallback(
    () =>
      voiceMode.isActiveFor({ environmentId, threadId }) ? voiceMode.getState().phase : "idle",
    [environmentId, threadId],
  );
  return useSyncExternalStore(voiceMode.subscribe, getSnapshot);
}
