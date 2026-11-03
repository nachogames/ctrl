import { useSyncExternalStore } from "react";

import { replySpeaker } from "./replySpeaker";

// Voice mode is a running conversation, so it is never saved: a reload or a
// restart starts with it off instead of reading replies with no strip to stop it.
let voiceModeOn = false;
const voiceModeListeners = new Set<() => void>();
const subscribeVoiceMode = (listener: () => void) => {
  voiceModeListeners.add(listener);
  return () => void voiceModeListeners.delete(listener);
};
const readVoiceMode = () => voiceModeOn;
const setVoiceModeOn = (on: boolean) => {
  if (voiceModeOn === on) return;
  voiceModeOn = on;
  for (const listener of voiceModeListeners) listener();
};

/** Voice mode in this window: dictation sends, and replies are read aloud. */
export function useVoiceMode(): readonly [boolean, (on: boolean) => void] {
  return [useSyncExternalStore(subscribeVoiceMode, readVoiceMode), setVoiceModeOn];
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
