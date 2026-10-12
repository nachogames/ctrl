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

A run takes about 20 minutes. Installed apps pick it up on their next update check, or right away through the app's check-for-updates action.

## One-time setup

Auto-update on macOS only installs a build signed by the same Developer ID as the running app. The workflow refuses to publish when any signing secret is missing.

Secrets live in the `release` environment, which only accepts `ctrl-v*` tags. Pull requests, including ones from forks, and branch pushes never receive them.

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

Download the `.dmg` from the latest release once and drag Ctrl into Applications. Builds made outside this workflow (local or ad-hoc signed) have no update feed and never update; replace them with a release build.

Releases are public because the repository is. Anyone can download the app, and its signature shows the Developer ID name. User data, provider credentials, and push credentials stay in `~/.ctrl` on each machine and are never part of a build.
