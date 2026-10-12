import type { PushRelayMessage } from "@t3tools/contracts";
import {
  apnsAlertPayload,
  apnsClearPayload,
  apnsPushType,
  fcmAlertData,
  fcmClearData,
} from "@t3tools/shared/pushPayloads";
import { importPKCS8, SignJWT } from "jose";

import type { DeviceRecord } from "./devices.ts";
import type { Deps, Env } from "./env.ts";

export type DeliveryResult = "sent" | "gone" | "failed";

// Provider tokens are reused across requests in one isolate. APNs accepts a
// token for up to an hour; Google access tokens last an hour.
let apnsToken: { readonly value: string; readonly issuedAt: number } | null = null;
let googleToken: { readonly value: string; readonly expiresAt: number } | null = null;

async function apnsProviderToken(env: Env, nowMs: number): Promise<string> {
  if (apnsToken && nowMs - apnsToken.issuedAt < 50 * 60_000) return apnsToken.value;
  const value = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: env.APNS_KEY_ID })
    .setIssuer(env.APNS_TEAM_ID)
    .setIssuedAt(Math.floor(nowMs / 1000))
    .sign(await importPKCS8(env.APNS_PRIVATE_KEY, "ES256"));
  apnsToken = { value, issuedAt: nowMs };
  return value;
}

async function sendApns(
  record: DeviceRecord,
  message: PushRelayMessage,
  env: Env,
  deps: Deps,
): Promise<DeliveryResult> {
  const host =
    record.apsEnvironment === "sandbox"
      ? "https://api.sandbox.push.apple.com"
      : "https://api.push.apple.com";
  const pushType = apnsPushType(message);
  const response = await deps.fetch(`${host}/3/device/${record.pushToken}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${await apnsProviderToken(env, deps.now())}`,
      "apns-push-type": pushType,
      "apns-topic": record.bundleId,
      "apns-priority": pushType === "alert" ? "10" : "5",
      "content-type": "application/json",
    },
    body: JSON.stringify(
      message.type === "alert" ? apnsAlertPayload(message) : apnsClearPayload(message),
    ),
  });
  if (response.status === 200) return "sent";
  const text = await response.text();
  // BadDeviceToken can mean a sandbox/production mismatch, so only Unregistered counts as gone.
  if (response.status === 410 || text.includes('"Unregistered"')) return "gone";
  if (text.includes("ExpiredProviderToken")) apnsToken = null;
  return "failed";
}

interface ServiceAccount {
  readonly project_id: string;
  readonly client_email: string;
  readonly private_key: string;
}

async function googleAccessToken(account: ServiceAccount, deps: Deps): Promise<string | null> {
  const nowMs = deps.now();
  if (googleToken && googleToken.expiresAt > nowMs) return googleToken.value;
  const issuedAt = Math.floor(nowMs / 1000);
  const assertion = await new SignJWT({
    scope: "https://www.googleapis.com/auth/firebase.messaging",
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(account.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 3600)
    .sign(await importPKCS8(account.private_key, "RS256"));
  const response = await deps.fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (response.status !== 200) return null;
  const { access_token } = (await response.json()) as { access_token?: string };
  if (!access_token) return null;
  googleToken = { value: access_token, expiresAt: nowMs + 50 * 60_000 };
  return access_token;
}

async function sendFcm(
  record: DeviceRecord,
  message: PushRelayMessage,
  env: Env,
  deps: Deps,
): Promise<DeliveryResult> {
  const account = JSON.parse(env.FCM_SERVICE_ACCOUNT) as ServiceAccount;
  const accessToken = await googleAccessToken(account, deps);
  if (accessToken === null) return "failed";
  const identity = {
    deviceId: record.deviceId,
    userId: record.androidUserId ?? "",
    nowMs: deps.now(),
  };
  const data =
    message.type === "alert"
      ? fcmAlertData({ alert: message, ...identity })
      : fcmClearData({ clear: message, ...identity });
  const response = await deps.fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          token: record.pushToken,
          data,
          android: { priority: "HIGH", ttl: "300s", restricted_package_name: record.bundleId },
        },
      }),
    },
  );
  if (response.status >= 200 && response.status < 300) return "sent";
  if (response.status === 401) googleToken = null;
  // Only UNREGISTERED proves a stale token; a bare 404 can be a project misconfiguration.
  return (await response.text()).includes('"UNREGISTERED"') ? "gone" : "failed";
}

/** Pushes one fixed-format message to one phone. Never throws. */
export async function deliver(
  record: DeviceRecord,
  message: PushRelayMessage,
  env: Env,
  deps: Deps,
): Promise<DeliveryResult> {
  try {
    return record.platform === "ios"
      ? await sendApns(record, message, env, deps)
      : await sendFcm(record, message, env, deps);
  } catch (cause) {
    // @effect-diagnostics-next-line globalConsole:off -- plain Worker; console is its log sink
    console.warn("push delivery failed", { platform: record.platform, cause: String(cause) });
    return "failed";
  }
}
