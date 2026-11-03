import * as Electron from "electron";

/**
 * Grants every request, as a session without a handler does, except macOS
 * microphone capture, which asks the OS first so dictation gets the system
 * prompt instead of silence.
 */
export function installMainWindowPermissions(
  webContents: Electron.WebContents,
  platform: NodeJS.Platform,
): void {
  webContents.session.setPermissionRequestHandler((requester, permission, callback, details) => {
    const wantsMicrophone =
      platform === "darwin" &&
      permission === "media" &&
      requester === webContents &&
      "mediaTypes" in details &&
      details.mediaTypes?.includes("audio") === true;
    if (!wantsMicrophone) {
      callback(true);
      return;
    }
    void Electron.systemPreferences
      .askForMediaAccess("microphone")
      .then(callback, () => callback(false));
  });
}
