import { PushRelayRegisterRequest } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { type DeviceRecord, isStale, readDevice, writeDevice } from "./devices.ts";
import type { Deps, Env } from "./env.ts";
import { bearerToken, json, readJson } from "./http.ts";
import { hashSendToken, newSendToken } from "./tokens.ts";

const decodeRegister = Schema.decodeUnknownOption(PushRelayRegisterRequest);

/**
 * Signs a phone up, or updates it. Only the holder of the current send token
 * can keep or reset a record; anything else gets a fresh token, so knowing a
 * device id never lets anyone take over or break another phone's record.
 */
export async function handleRegister(request: Request, env: Env, deps: Deps): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await env.REGISTER_LIMITER.limit({ key: ip })).success) {
    return json(429, { error: "rate_limited" });
  }
  const decoded = decodeRegister(await readJson(request));
  if (decoded._tag === "None") return json(400, { error: "invalid_body" });
  const body = decoded.value;
  const allowed = env.ALLOWED_BUNDLE_IDS.split(",").map((id) => id.trim());
  if (!allowed.includes(body.bundleId)) return json(400, { error: "unsupported_app" });

  const record: DeviceRecord = {
    platform: body.platform,
    pushToken: body.pushToken,
    bundleId: body.bundleId,
    ...(body.apsEnvironment ? { apsEnvironment: body.apsEnvironment } : {}),
    deviceId: body.deviceId,
    ...(body.androidUserId !== undefined ? { androidUserId: body.androidUserId } : {}),
    lastSeenAt: deps.now(),
  };

  const presented = bearerToken(request);
  const presentedHash = presented === null ? null : await hashSendToken(presented);
  const existing = presentedHash === null ? null : await readDevice(env.DEVICES, presentedHash);

  if (presented !== null && presentedHash !== null && existing !== null && body.reset !== true) {
    const changed =
      existing.pushToken !== record.pushToken ||
      existing.apsEnvironment !== record.apsEnvironment ||
      existing.androidUserId !== record.androidUserId ||
      existing.bundleId !== record.bundleId;
    if (changed || isStale(existing, record.lastSeenAt)) {
      await writeDevice(env.DEVICES, presentedHash, record);
    }
    return json(200, { sendToken: presented });
  }

  const sendToken = newSendToken();
  await writeDevice(env.DEVICES, await hashSendToken(sendToken), record);
  if (presentedHash !== null && existing !== null) await env.DEVICES.delete(presentedHash);
  return json(200, { sendToken });
}
