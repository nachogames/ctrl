import { describe, expect, it } from "vite-plus/test";

import { readDevice } from "./devices.ts";
import type { Deps } from "./env.ts";
import { limiter, memoryStore, testEnv } from "./testing.ts";
import { hashSendToken } from "./tokens.ts";
import { handle } from "./worker.ts";

const deps: Deps = { fetch: () => Promise.reject(new Error("no network")), now: () => 1_000 };
const phone = {
  deviceId: "device-1",
  platform: "android",
  pushToken: "fcm-1",
  bundleId: "com.nachogames.ctrl",
  androidUserId: "direct",
};

const register = (env: ReturnType<typeof testEnv>, body: unknown, token?: string) =>
  handle(
    new Request("https://relay.test/register", {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body),
    }),
    env,
    deps,
  );

const tokenOf = async (response: Response) =>
  ((await response.json()) as { sendToken: string }).sendToken;

describe("POST /register", () => {
  it("signs up a new phone and stores only the token hash", async () => {
    const kv = memoryStore();
    const env = testEnv({ DEVICES: kv.store });
    const response = await register(env, phone);
    expect(response.status).toBe(200);
    const sendToken = await tokenOf(response);
    expect(sendToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect([...kv.entries.keys()]).toEqual([await hashSendToken(sendToken)]);
    expect(JSON.stringify([...kv.entries.values()])).not.toContain(sendToken);
    expect(await readDevice(kv.store, await hashSendToken(sendToken))).toMatchObject({
      pushToken: "fcm-1",
      deviceId: "device-1",
      lastSeenAt: 1_000,
    });
  });

  it("keeps the same token when the phone re-registers with it, updating a rotated push token", async () => {
    const kv = memoryStore();
    const env = testEnv({ DEVICES: kv.store });
    const sendToken = await tokenOf(await register(env, phone));
    const again = await register(env, { ...phone, pushToken: "fcm-2" }, sendToken);
    expect(await again.json()).toEqual({ sendToken });
    expect((await readDevice(kv.store, await hashSendToken(sendToken)))?.pushToken).toBe("fcm-2");
  });

  it("reset issues a new token and kills the old one", async () => {
    const kv = memoryStore();
    const env = testEnv({ DEVICES: kv.store });
    const old = await tokenOf(await register(env, phone));
    const fresh = await tokenOf(await register(env, { ...phone, reset: true }, old));
    expect(fresh).not.toBe(old);
    expect(await readDevice(kv.store, await hashSendToken(old))).toBeNull();
    expect(await readDevice(kv.store, await hashSendToken(fresh))).not.toBeNull();
  });

  it("treats an unknown bearer token as a new sign-up, so nobody can adopt another phone's record", async () => {
    const sendToken = await tokenOf(await register(testEnv(), phone, "not-a-real-token"));
    expect(sendToken).not.toBe("not-a-real-token");
  });

  it("rejects apps the keys cannot push to, bad bodies, and floods", async () => {
    expect((await register(testEnv(), { ...phone, bundleId: "com.other.app" })).status).toBe(400);
    expect((await register(testEnv(), { pushToken: "x" })).status).toBe(400);
    expect((await register(testEnv({ REGISTER_LIMITER: limiter(false) }), phone)).status).toBe(429);
  });

  it("answers 404 for unknown routes", async () => {
    const response = await handle(new Request("https://relay.test/nope"), testEnv(), deps);
    expect(response.status).toBe(404);
  });
});
