import { PushRelayRegisterRequest } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { type DeviceRecord, isStale, readDevice, writeDevice } from "./devices.ts";
import type { Deps, Env } from "./env.ts";
import { json, readJson } from "./http.ts";
import { hashSendToken, newSendToken } from "./tokens.ts";

const decodeRegister = Schema.decodeUnknownOption(PushRelayRegisterRequest);

/**
 * Signs a phone up, or updates it. Computers hold the send token, so changing
 * or resetting a record also needs the manage token, which never leaves the
 * phone. Anything else gets fresh tokens and a new record, so neither a send
 * token nor a device id lets anyone take over or break another phone's record.
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

  const fields = {
    platform: body.platform,
    pushToken: body.pushToken,
    bundleId: body.bundleId,
    ...(body.apsEnvironment ? { apsEnvironment: body.apsEnvironment } : {}),
    deviceId: body.deviceId,
    ...(body.androidUserId !== undefined ? { androidUserId: body.androidUserId } : {}),
    lastSeenAt: deps.now(),
  };

  const current = body.current;
  const currentHash = current === undefined ? null : await hashSendToken(current.sendToken);
  const existing = currentHash === null ? null : await readDevice(env.DEVICES, currentHash);
  const owned =
    current !== undefined &&
    existing !== null &&
    existing.manageHash === (await hashSendToken(current.manageToken));

  if (owned && currentHash !== null && existing !== null && body.reset !== true) {
    const record: DeviceRecord = { ...fields, manageHash: existing.manageHash };
    const changed =
      existing.pushToken !== record.pushToken ||
      existing.apsEnvironment !== record.apsEnvironment ||
      existing.androidUserId !== record.androidUserId ||
      existing.bundleId !== record.bundleId;
    if (changed || isStale(existing, record.lastSeenAt)) {
      await writeDevice(env.DEVICES, currentHash, record);
    }
    return json(200, current);
  }

  const sendToken = newSendToken();
  const manageToken = newSendToken();
  await writeDevice(env.DEVICES, await hashSendToken(sendToken), {
    ...fields,
    manageHash: await hashSendToken(manageToken),
  });
  if (owned && currentHash !== null) await env.DEVICES.delete(currentHash);
  return json(200, { sendToken, manageToken });
}
