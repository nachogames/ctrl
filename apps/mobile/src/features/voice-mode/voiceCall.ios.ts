import { addUserInteractionListener, type LiveActivity } from "expo-widgets";

import VoiceCallActivity, { type VoiceCallActivityProps } from "../../widgets/VoiceCallActivity";
import type { VoiceCall, VoiceCallAction } from "./voiceCallTypes";

/** iOS keeps the microphone in the background through the app's background audio mode. */
export const voiceCallSupported = true;

let activity: LiveActivity<VoiceCallActivityProps> | null = null;
let props: VoiceCallActivityProps | null = null;

// A call shown when the app was killed has nothing behind it.
try {
  for (const stale of VoiceCallActivity.getInstances()) void stale.end("immediate").catch(() => {});
} catch {
  // Binaries built before the activity was added do not know it.
}

/** Live Activities need no permission prompt. */
export async function prepareVoiceCall(): Promise<void> {}

/** The Lock Screen and Dynamic Island call, with a timer, Mute and End. */
export function startVoiceCall(call: VoiceCall) {
  props = { ...call, startedAt: Date.now() };
  try {
    activity = VoiceCallActivity.start(props);
  } catch {
    // Live Activities are off, or the binary predates this one; the call still runs.
    activity = null;
  }
}

export function updateVoiceCall(call: Pick<VoiceCall, "status" | "muted">) {
  if (props === null || activity === null) return;
  props = { ...props, ...call };
  void activity.update(props).catch(() => {});
}

export function stopVoiceCall() {
  const ended = activity;
  activity = null;
  props = null;
  void ended?.end("immediate").catch(() => {});
}

export function onVoiceCallAction(listener: (action: VoiceCallAction) => void): () => void {
  const subscription = addUserInteractionListener((event) => {
    if (event.source !== "VoiceCallActivity") return;
    if (event.target === "end" || event.target === "mute") listener(event.target);
  });
  return () => subscription.remove();
}
