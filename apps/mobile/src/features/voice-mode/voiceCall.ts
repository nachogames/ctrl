import { requireOptionalNativeModule } from "expo";
import { PermissionsAndroid, Platform } from "react-native";

import type { VoiceCall, VoiceCallAction } from "./voiceCallTypes";

interface CtrlVoiceCall {
  start(caller: string, title: string, status: string, muted: boolean): void;
  update(status: string, muted: boolean): void;
  stop(): void;
  addListener(
    event: "onAction",
    listener: (event: { readonly action: string }) => void,
  ): { remove(): void };
}

const native =
  Platform.OS === "android" ? requireOptionalNativeModule<CtrlVoiceCall>("CtrlVoiceCall") : null;

/** Android binaries built before the call service cannot capture in the background. */
export const voiceCallSupported: boolean = native !== null;

let askedForNotifications = false;

/**
 * Asks once per launch to show notifications, which Android 13 hides until
 * allowed: the call keeps running without them, but loses its notification
 * and its Hang up and Mute.
 */
export async function prepareVoiceCall(): Promise<void> {
  if (native === null || askedForNotifications || Number(Platform.Version) < 33) return;
  askedForNotifications = true;
  await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(
    () => undefined,
  );
}

/** The ongoing call notification that keeps Android capturing in the background. */
export function startVoiceCall(call: VoiceCall) {
  native?.start(call.caller, `Talking to ${call.caller}`, call.status, call.muted);
}

export function updateVoiceCall(call: Pick<VoiceCall, "status" | "muted">) {
  native?.update(call.status, call.muted);
}

export function stopVoiceCall() {
  native?.stop();
}

/** Hang up and Mute in the notification. */
export function onVoiceCallAction(listener: (action: VoiceCallAction) => void): () => void {
  const subscription = native?.addListener("onAction", ({ action }) => {
    if (action === "end" || action === "mute") listener(action);
  });
  return () => subscription?.remove();
}
