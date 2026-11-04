import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  VoiceModeController,
  makeVoiceSessionOpener,
  makeVoiceSessionValidator,
  recoverMissingVoiceSession,
  type VoiceModePhase,
  type VoiceModeState,
  type VoicePeerConnection,
  type VoiceSessionTarget,
} from "@t3tools/client-runtime/voice-mode";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { Alert, AppState, NativeModules } from "react-native";
import type * as WebRTC from "react-native-webrtc";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { setVoiceAudioActive } from "./voiceAudio";
import {
  onVoiceCallAction,
  prepareVoiceCall,
  startVoiceCall,
  stopVoiceCall,
  updateVoiceCall,
  voiceCallSupported,
} from "./voiceCall";
import { resolveVoiceModeNotice } from "./voiceModePresentation";

/**
 * False on binaries built before react-native-webrtc was added. Importing the
 * package there throws, so it only loads once a conversation starts.
 */
export const voiceModeSupported: boolean = NativeModules.WebRTCModule != null;

let webrtc: typeof WebRTC | null = null;
function loadWebRTC(): typeof WebRTC {
  webrtc ??= require("react-native-webrtc") as typeof WebRTC;
  return webrtc;
}

/** Runs the voice stream on the connection runtime, holding it for the conversation's lifetime. */
function runOnConnectionRuntime(
  effect: Effect.Effect<void, never, EnvironmentRegistry.EnvironmentRegistry>,
) {
  return Effect.runFork(
    Effect.gen(function* () {
      yield* AtomRegistry.mount(appAtomRegistry, connectionAtomRuntime);
      const context = yield* AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime);
      yield* Effect.provideContext(effect, context);
    }).pipe(Effect.scoped, Effect.orDie),
  );
}

/**
 * react-native-webrtc's published declarations drop its EventTarget base
 * (`lib/typescript` omits the vendored event-target-shim types), so the class
 * types without `addEventListener`. The runtime class extends the shim and
 * supports it, which is all the controller uses.
 */
function createPeerConnection(): VoicePeerConnection {
  return new (loadWebRTC().RTCPeerConnection)() as unknown as VoicePeerConnection;
}

export const voiceMode = new VoiceModeController({
  validateTarget: makeVoiceSessionValidator(runOnConnectionRuntime),
  createPeerConnection,
  getMicrophone: () => loadWebRTC().mediaDevices.getUserMedia({ audio: true }),
  // Native WebRTC plays remote audio tracks through its own audio device; there is nothing to attach.
  playRemoteAudio: () => () => undefined,
  openSession: makeVoiceSessionOpener(runOnConnectionRuntime),
});

/** Who the call is with: Shift, or the thread's title. */
function voiceCaller(target: VoiceSessionTarget): string {
  const environmentId = EnvironmentId.make(target.environmentId);
  const threadId = ThreadId.make(target.threadId);
  const settings = appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId));
  if (settings?.home.threadId === threadId) return "Shift";
  const thread = appAtomRegistry.get(
    environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId)),
  );
  return thread?.title || "Voice conversation";
}

function voiceCallStatus(state: VoiceModeState): string {
  if (state.phase !== "active") return "Connecting…";
  return state.muted ? "Muted" : "Listening";
}

const KEEP_AWAKE_TAG = "voice-mode";
let previousPhase: VoiceModePhase = "idle";
let routedAudio = false;
let keepAwake: Promise<void> | null = null;

let previousCallStatus: string | null = null;

voiceMode.subscribe((state) => {
  const { phase } = state;
  // Captions change the state many times a second; the call shows only its status.
  const callStatus = phase === "idle" ? null : voiceCallStatus(state);
  if (callStatus !== null && callStatus !== previousCallStatus) {
    updateVoiceCall({ status: callStatus, muted: state.muted });
  }
  previousCallStatus = callStatus;
  if (phase === previousPhase) return;
  previousPhase = phase;
  if (phase === "active" && !routedAudio) {
    routedAudio = true;
    // WebRTC resets iOS routing when its audio unit starts, so route after activation.
    setVoiceAudioActive(true).catch(() => undefined);
    // Started once the microphone is granted: Android refuses a microphone service before.
    if (state.target !== null) {
      startVoiceCall({
        caller: voiceCaller(state.target),
        status: voiceCallStatus(state),
        muted: state.muted,
      });
      // Asked after the microphone so the two prompts never overlap; a granted
      // prompt reposts the notification Android dropped while it was denied.
      void prepareVoiceCall().then(() => {
        const current = voiceMode.getState();
        if (current.phase === "idle") return;
        updateVoiceCall({ status: voiceCallStatus(current), muted: current.muted });
      });
    }
  }
  if (phase !== "idle" && !voiceCallSupported && !keepAwake) {
    // Without a call to hold it, backgrounding ends the conversation, so the screen must not lock.
    keepAwake = activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
  }
  if (phase === "idle") {
    stopVoiceCall();
    if (routedAudio) {
      routedAudio = false;
      setVoiceAudioActive(false).catch(() => undefined);
    }
    const activation = keepAwake;
    keepAwake = null;
    // Every conversation shares the tag, so a newer one must keep its lock.
    activation
      ?.then(() => (keepAwake === null ? deactivateKeepAwake(KEEP_AWAKE_TAG) : undefined))
      .catch(() => undefined);
  }
});

onVoiceCallAction((action) => {
  if (action === "end") voiceMode.stop();
  else voiceMode.toggleMuted();
});

// A conversation runs like a phone call: it outlives its thread screen, the
// app going to the background, and the screen locking. Android binaries built
// before the call service cannot capture in the background, so there it ends
// rather than stay silently deaf.
AppState.addEventListener("change", (state) => {
  if (state === "background" && !voiceCallSupported) voiceMode.stop();
});

// Failures and remote endings are reported once, wherever the user is.
voiceMode.subscribe(() => {
  // Reads the live state: dismissing notifies listeners re-entrantly.
  const state = voiceMode.getState();
  // A thread that can open its own session, such as Shift's row, retries instead.
  if (
    state.phase === "idle" &&
    state.target !== null &&
    state.error !== null &&
    recoverMissingVoiceSession({ target: state.target, error: state.error })
  ) {
    voiceMode.dismiss();
    return;
  }
  const notice = resolveVoiceModeNotice(state);
  if (!notice) return;
  voiceMode.dismiss();
  Alert.alert(notice.title, notice.message);
});
