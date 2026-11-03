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

/** The agent reply read aloud so far, for the voice strip's caption. */
export function useSpokenCaption() {
  return useSyncExternalStore(replySpeaker.subscribe, replySpeaker.spokenCaption);
}

/**
 * What voice needs that is missing in a thread without Codex voice, as a hint
 * naming where to turn it on; null when dictation and spoken replies are ready.
 */
export function voiceUnavailableReason(input: {
  readonly dictationReady: boolean;
  readonly spokenRepliesReady: boolean;
}): string | null {
  if (!input.dictationReady && !input.spokenRepliesReady)
    return "Turn on Dictation and Spoken replies in Settings → Devices";
  if (!input.dictationReady) return "Turn on Dictation in Settings → Devices";
  if (!input.spokenRepliesReady) return "Turn on Spoken replies in Settings → Devices";
  return null;
}
