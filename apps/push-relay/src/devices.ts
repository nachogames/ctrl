import * as Schema from "effect/Schema";

import type { DeviceStore } from "./env.ts";

export const DEVICE_TTL_SECONDS = 90 * 24 * 60 * 60;
/** KV's free tier allows 1,000 writes a day, so records are rewritten at most weekly. */
export const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export const DeviceRecord = Schema.Struct({
  platform: Schema.Literals(["ios", "android"]),
  pushToken: Schema.String,
  bundleId: Schema.String,
  apsEnvironment: Schema.optionalKey(Schema.Literals(["sandbox", "production"])),
  /** Echoed in FCM data: the Android handler drops pushes for another device or user. */
  deviceId: Schema.String,
  androidUserId: Schema.optionalKey(Schema.String),
  lastSeenAt: Schema.Number,
});
export type DeviceRecord = typeof DeviceRecord.Type;

const DeviceRecordJson = Schema.fromJsonString(DeviceRecord);
const decodeRecord = Schema.decodeUnknownOption(DeviceRecordJson);
const encodeRecord = Schema.encodeSync(DeviceRecordJson);

export async function readDevice(store: DeviceStore, hash: string): Promise<DeviceRecord | null> {
  const raw = await store.get(hash);
  if (raw === null) return null;
  const decoded = decodeRecord(raw);
  return decoded._tag === "Some" ? decoded.value : null;
}

export function writeDevice(store: DeviceStore, hash: string, record: DeviceRecord) {
  return store.put(hash, encodeRecord(record), { expirationTtl: DEVICE_TTL_SECONDS });
}

export function isStale(record: DeviceRecord, nowMs: number): boolean {
  return nowMs - record.lastSeenAt > REFRESH_AFTER_MS;
}
