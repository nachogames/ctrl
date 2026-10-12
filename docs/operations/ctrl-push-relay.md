# Ctrl push relay

`apps/push-relay` is a Cloudflare Worker that holds Ctrl's APNs and FCM keys, so any computer a phone is paired with can alert that phone without keys of its own. Each phone gets a send token that reaches only that phone; KV stores only token hashes, and the relay forwards only fixed-format alerts and clears.

It runs at `https://ctrl-push-relay.mceachinm.workers.dev`, in the Cloudflare account wrangler is logged in to.

## Deploy

    cd apps/push-relay
    vp exec wrangler deploy

## Rotate keys

Replace a secret with `vp exec wrangler secret put <NAME>`: `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY` (the `.p8` file), `FCM_SERVICE_ACCOUNT` (the service account JSON). The originals are in 1Password, "Ctrl push keys". Phones and send tokens are unaffected.

## Watch it

    vp exec wrangler tail

## Constraints

- The address is built into the mobile app (`extra.pushRelayUrl`). Moving it breaks installed apps until they update, so keep the old address alive while they do.
- KV's free tier allows 1,000 writes a day. Sends never write unless a record is over a week old; keep it that way.
- Cloudflare rejects requests with Python's default `urllib` user agent (403). Use curl or set a user agent when testing.
