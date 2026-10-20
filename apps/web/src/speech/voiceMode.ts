import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { replySpeaker } from "./replySpeaker";

// The key predates voice in every thread; kept so a saved choice carries over.
const VOICE_MODE_KEY = "t3code:shift-voice-mode";

/** Voice mode on this device, for every thread: dictation sends, and replies are read aloud. */
export function useVoiceMode() {
  return useLocalStorage(VOICE_MODE_KEY, false, Schema.Boolean);
}

/** True while a reply is being read aloud. */
export function useReplySpeaking() {
  return useSyncExternalStore(replySpeaker.subscribe, replySpeaker.isSpeaking);
}
