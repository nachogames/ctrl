import { setAudioModeAsync } from "expo-audio";

// Expo audio-mode changes must finish before a successor configures the shared native session.
let pending = Promise.resolve();

export function setVoiceAudioActive(active: boolean): Promise<void> {
  const result = pending.then(() =>
    setAudioModeAsync(
      active
        ? {
            allowsRecording: true,
            playsInSilentMode: true,
            interruptionMode: "doNotMix",
            // A conversation continues like a call when the app leaves the screen.
            shouldPlayInBackground: true,
            shouldRouteThroughEarpiece: false,
          }
        : {
            allowsRecording: false,
            playsInSilentMode: true,
            interruptionMode: "mixWithOthers",
            shouldPlayInBackground: false,
            shouldRouteThroughEarpiece: false,
          },
    ),
  );
  pending = result.catch(() => {});
  return result;
}
