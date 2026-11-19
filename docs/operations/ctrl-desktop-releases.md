# Ctrl desktop releases

Ctrl ships its own signed, notarized Apple Silicon build from this fork. Installed apps check `nachogames/ctrl`'s latest GitHub release and update themselves, so a machine needs the DMG only once.

The workflow is `.github/workflows/ctrl-release.yml`. Upstream's `release.yml` depends on maintainer runners and secrets this fork does not have; leave it disabled.

## Cut a release

```sh
git checkout main && git pull
git tag ctrl-v0.1.1
git push origin ctrl-v0.1.1
```

The version comes from the tag, not `package.json`, so upstream merges cannot move it. Each tag must be higher than the last one. Ctrl versions start at 0.1.0 so they stay ahead of upstream's 0.0.x and the mobile app does not offer upstream server updates.

A run takes about 10 minutes. Installed apps pick it up on their next update check, or right away through the app's check-for-updates action. This tag ships the desktop app only; the phone app has its own tag (see [Android](#android)).

GitHub's hosted macOS runners sometimes run out, and a job no runner picks up within about 15 minutes fails without running a step. `ctrl-release-retry.yml` re-runs such a release up to three times. A job that started and then failed is not retried.

## Release from a Mac

When no runner picks the job up, build the same release on an Apple Silicon Mac with the macOS 26 SDK. The result matches a workflow release, so installed apps update to it normally.

Prerequisites: the Developer ID Application identity in the login Keychain and the App Store Connect API key (`.p8`, key ID, issuer ID) from the setup below. The tag must already be pushed.

```sh
git worktree add --detach ../ctrl-release ctrl-v0.1.1   # a clean checkout, no .env
cd ../ctrl-release
vp install --filter=@t3tools/desktop... --filter=t3... --filter=@t3tools/scripts...
node scripts/update-release-package-versions.ts 0.1.1

export CSC_NAME="<Developer ID name, without the 'Developer ID Application: ' prefix>"
export APPLE_API_KEY=~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8
export APPLE_API_KEY_ID=<KEY_ID> APPLE_API_ISSUER=<ISSUER_ID>
export T3CODE_DESKTOP_UPDATE_REPOSITORY=nachogames/ctrl
vp run dist:desktop:artifact --platform mac --target dmg --arch arm64 \
  --build-version 0.1.1 --signed --verbose
```

`T3CODE_DESKTOP_UPDATE_REPOSITORY` gives the app its update feed. Without it, or without `--signed`, the build never updates. Before publishing, unzip `release/*.zip` and check the app with `codesign --verify --deep --strict`, `spctl --assess --type execute -vv` (expect "Notarized Developer ID") and `xcrun stapler validate`. Then publish and remove the worktree:

```sh
gh release create ctrl-v0.1.1 -R nachogames/ctrl --verify-tag --latest \
  --title "Ctrl 0.1.1" --generate-notes \
  release/*.dmg release/*.zip release/*.blockmap release/latest-mac.yml
```

Cancel the workflow run if it is still queued.

## One-time setup

Auto-update on macOS only installs a build signed by the same Developer ID as the running app. The workflow refuses to publish when any signing secret is missing.

Secrets live in the `release` environment, which only accepts `ctrl-v*` and `ctrl-android-v*` tags. Pull requests, including ones from forks, and branch pushes never receive them.

1. Export the **Developer ID Application** identity alone from Keychain Access (My Certificates → right-click → Export) as a `.p12` with a password.
2. Create an App Store Connect API key with the Developer role (Users and Access → Integrations → Team Keys). Note the key ID and issuer ID, and download the `.p8`. The APNs key cannot notarize.
3. Store them, then delete the local `.p12`:

```sh
R=nachogames/ctrl
base64 -i ctrl-devid.p12 | gh secret set CTRL_MAC_CERT_P12_BASE64 -R $R --env release
gh secret set CTRL_MAC_CERT_PASSWORD -R $R --env release        # prompts, hidden
gh secret set CTRL_ASC_API_KEY_P8 -R $R --env release < AuthKey_XXXXXXXXXX.p8
gh secret set CTRL_ASC_API_KEY_ID -R $R --env release
gh secret set CTRL_ASC_API_ISSUER -R $R --env release
rm ctrl-devid.p12
```

## Install on a new Mac

Download the `.dmg` from the latest release once and drag Ctrl into Applications. Builds made any other way, such as a plain local `dist:desktop` or an ad-hoc signed build, have no update feed and never update; replace them with a release build.

Releases are public because the repository is. Anyone can download the app, and its signature shows the Developer ID name. User data, provider credentials, and push credentials stay in `~/.ctrl` on each machine and are never part of a build.

## Android

The phone app ships separately: push a `ctrl-android-vX.Y.Z` tag to run `.github/workflows/ctrl-android-release.yml`. Desktop and phone releases never trigger or wait on each other. It creates a GitHub release only when it builds an APK, and that release is a prerelease, never "latest", because desktop apps update from the latest release. It publishes an OTA update to the `production` channel of the Expo project `@mceachinm/ctrl`, which hosts updates only; builds happen in the workflow, not EAS Build. When native code changed, that release holds a signed `Ctrl-<version>-android-<fingerprint>.apk`.

A cold start waits up to 3 seconds for a new update and opens on it, and a running app checks again when it returns after a minute away. A phone takes an OTA only when its APK has the same native fingerprint, which the workflow computes on the runner that builds and publishes. The job summary says when a release needs the new APK installed. Local builds are signed with a different key and keep `T3CODE_MOBILE_UPDATES_ENABLED=0` in `.env.local`, so install the release APK instead. The APK is arm64 only. Release builds carry no T3 Connect config, so the app offers only Ctrl's own server notifications.

Secrets in the `release` environment: `EXPO_TOKEN`, `CTRL_ANDROID_KEYSTORE_BASE64`, `CTRL_ANDROID_KEYSTORE_PASSWORD` (key alias `ctrl`), and `CTRL_ANDROID_GOOGLE_SERVICES_JSON`. The keystore's only other copy is `~/.ctrl-signing/ctrl-android-release.keystore` on Neil's Mac, with its password in the Keychain as `ctrl-android-keystore-password`. Losing the key means phones must uninstall to take a new APK, so back it up.
