# Mobile notifications

Sign in to T3 Connect, link your environments, and enable **Device Notifications** in **Settings → Notifications** to receive alerts when an agent finishes, fails, needs approval, or asks for input. Tap a notification to open its thread. Your environment must have agent activity publishing enabled.

Enable **Ongoing Agent Activity** on Android or **Live Activity Updates** on iOS to follow work without opening the app. Finished results remain visible for up to 15 minutes. You can dismiss an Android activity card without disabling alerts; turn off ongoing activity in Settings to stop future cards.

Ordinary alerts stay quiet while the mobile app is in the foreground. Ongoing activity continues to update. Viewing a thread on another device does not silence your phone's alerts.

Android notifications require Android 7.0 or newer and Google Play services. Android 16 and newer can promote ongoing activity to a Live Update, subject to system settings and device support. Other devices show a regular ongoing notification. Android 7's battery-saving modes can delay removal of expired cards.

Notification permission and Android notification channels are controlled in system Settings. Background delivery requires T3 Connect or server notifications (below); a direct or Tailscale connection alone does not deliver alerts while the app is closed. The mobile app does not need to maintain a connection to your environment. Force-stopping the Android app in system Settings prevents push delivery until you open it again.

## Server notifications without T3 Connect

Your servers can alert your phone without a T3 Connect account. Turn on **Settings → Notifications → Server Notifications** in the mobile app, then choose which events alert you. By default you are alerted when an agent needs approval or asks for input; you can also turn on alerts for finished and failed runs. Every server the phone is connected to can then alert it, and the servers need no setup. Each connected server shows **Ready** once it has registered this device.

Alerts go through Ctrl's push relay. The relay sees the thread title and project name it delivers, and an address that reaches only your phone. **Reset alerts** in the same screen gives your phone a new address, so a computer you no longer use stops reaching it.

Once you answer a question, from any device, its alert is removed from your phone. iOS may delay this, and skips it while the app is force-quit. Server notifications do not drive Live Activities or ongoing activity cards.

### Using your own push keys

If you build the app yourself with your own Apple team or Firebase project, the relay cannot push to it. Give each server your keys instead:

1. On the server machine, create `push/config.json` in the server's data directory (for example `~/.t3/userdata/push/config.json`). Include whichever platforms you use:

   ```json
   {
     "apns": {
       "teamId": "ABCDE12345",
       "keyId": "XYZ9876543",
       "keyPath": "AuthKey_XYZ9876543.p8"
     },
     "fcm": { "serviceAccountPath": "firebase-service-account.json" }
   }
   ```

   The APNs key needs the Apple Push Notifications service enabled. The Firebase file is a service account key from **Project settings → Service accounts**. Relative paths are read from the `push` folder; absolute and `~/` paths also work. Changes take effect without restarting the server.

2. Set `CTRL_PUSH_RELAY_URL` to an empty value when building the app, so phones register with your servers directly.

Turning the switch off removes this device from your servers.
