import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { shiftSpeaker } from "./shiftSpeaker";

const SHIFT_VOICE_MODE_KEY = "t3code:shift-voice-mode";

/** Voice mode for Shift's thread on this client: dictation sends, and replies are read aloud. */
export function useShiftVoiceMode() {
  return useLocalStorage(SHIFT_VOICE_MODE_KEY, false, Schema.Boolean);
}

/** True while Shift's reply is being read aloud. */
export function useShiftSpeaking() {
  return useSyncExternalStore(shiftSpeaker.subscribe, shiftSpeaker.isSpeaking);
}
