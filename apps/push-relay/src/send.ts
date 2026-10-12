import { PushRelaySendRequest } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { deliver } from "./delivery.ts";
import { isStale, readDevice, writeDevice } from "./devices.ts";
import type { Deps, Env } from "./env.ts";
import { json, readJson } from "./http.ts";
import { hashSendToken } from "./tokens.ts";

const decodeSend = Schema.decodeUnknownOption(PushRelaySendRequest);

/** Delivers one fixed-format alert or clear to the phone a send token reaches. */
export async function handleSend(request: Request, env: Env, deps: Deps): Promise<Response> {
  const decoded = decodeSend(await readJson(request));
  if (decoded._tag === "None") return json(400, { error: "invalid_body" });
  const hash = await hashSendToken(decoded.value.sendToken);
  if (!(await env.SEND_LIMITER.limit({ key: hash })).success) {
    return json(429, { error: "rate_limited" });
  }
  const record = await readDevice(env.DEVICES, hash);
  if (record === null) return json(404, { error: "unknown_token" });

  const result = await deliver(record, decoded.value.message, env, deps);
  if (result === "gone") {
    await env.DEVICES.delete(hash);
    return json(410, { result: "gone" });
  }
  if (result === "failed") return json(502, { error: "push_failed" });
  const nowMs = deps.now();
  if (isStale(record, nowMs)) {
    await writeDevice(env.DEVICES, hash, { ...record, lastSeenAt: nowMs });
  }
  return json(200, { result: "sent" });
}
