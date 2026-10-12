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

interface Tokens {
  readonly sendToken: string;
  readonly manageToken: string;
}

const register = (env: ReturnType<typeof testEnv>, body: unknown) =>
  handle(
    new Request("https://relay.test/register", { method: "POST", body: JSON.stringify(body) }),
    env,
    deps,
  );

const tokensOf = async (response: Response) => (await response.json()) as Tokens;

describe("POST /register", () => {
  it("signs up a new phone and stores only token hashes", async () => {
    const kv = memoryStore();
    const env = testEnv({ DEVICES: kv.store });
    const response = await register(env, phone);
    expect(response.status).toBe(200);
    const { sendToken, manageToken } = await tokensOf(response);
    expect(sendToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(manageToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(manageToken).not.toBe(sendToken);
    expect([...kv.entries.keys()]).toEqual([await hashSendToken(sendToken)]);
    const stored = JSON.stringify([...kv.entries.values()]);
    expect(stored).not.toContain(sendToken);
    expect(stored).not.toContain(manageToken);
    expect(await readDevice(kv.store, await hashSendToken(sendToken))).toMatchObject({
      pushToken: "fcm-1",
      deviceId: "device-1",
      lastSeenAt: 1_000,
    });
  });

  it("keeps the same tokens when the phone re-registers with them, updating a rotated push token", async () => {
    const kv = memoryStore();
    const env = testEnv({ DEVICES: kv.store });
    const current = await tokensOf(await register(env, phone));
    const again = await register(env, { ...phone, pushToken: "fcm-2", current });
    expect(await again.json()).toEqual(current);
    expect((await readDevice(kv.store, await hashSendToken(current.sendToken)))?.pushToken).toBe(
      "fcm-2",
    );
  });

  it("does not rewrite an unchanged record when the phone re-registers", async () => {
    const kv = memoryStore();
    const env = testEnv({ DEVICES: kv.store });
    const current = await tokensOf(await register(env, phone));
    const writes = kv.writes();
    await register(env, { ...phone, current });
    expect(kv.writes()).toBe(writes);
  });

  it("reset issues new tokens and kills the old send token", async () => {
    const kv = memoryStore();
    const env = testEnv({ DEVICES: kv.store });
    const old = await tokensOf(await register(env, phone));
    const fresh = await tokensOf(await register(env, { ...phone, reset: true, current: old }));
    expect(fresh.sendToken).not.toBe(old.sendToken);
    expect(await readDevice(kv.store, await hashSendToken(old.sendToken))).toBeNull();
    expect(await readDevice(kv.store, await hashSendToken(fresh.sendToken))).not.toBeNull();
  });

  it("a computer holding only the send token cannot redirect or reset the phone's record", async () => {
    const kv = memoryStore();
    const env = testEnv({ DEVICES: kv.store });
    const victim = await tokensOf(await register(env, phone));
    const forged = { sendToken: victim.sendToken, manageToken: victim.sendToken };
    const takeover = await tokensOf(
      await register(env, { ...phone, pushToken: "attacker", current: forged }),
    );
    await register(env, { ...phone, reset: true, current: forged });
    expect(takeover.sendToken).not.toBe(victim.sendToken);
    expect((await readDevice(kv.store, await hashSendToken(victim.sendToken)))?.pushToken).toBe(
      "fcm-1",
    );
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
