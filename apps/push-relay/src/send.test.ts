import { exportPKCS8, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { type DeviceRecord, writeDevice } from "./devices.ts";
import type { Deps, Env } from "./env.ts";
import { limiter, memoryStore, testEnv } from "./testing.ts";
import { hashSendToken } from "./tokens.ts";
import { handle } from "./worker.ts";

let apnsKey = "";
let fcmAccount = "";
beforeAll(async () => {
  const ec = await generateKeyPair("ES256", { extractable: true });
  apnsKey = await exportPKCS8(ec.privateKey);
  const rsa = await generateKeyPair("RS256", { extractable: true });
  fcmAccount = JSON.stringify({
    project_id: "ctrl-test",
    client_email: "relay@ctrl-test.iam.gserviceaccount.com",
    private_key: await exportPKCS8(rsa.privateKey),
  });
});

const NOW = 10 * 24 * 60 * 60 * 1000;
const alert = {
  type: "alert",
  kind: "input",
  environmentId: "env-1",
  threadId: "thread-1",
  threadTitle: "Fix the build",
  projectTitle: "Ctrl",
  updatedAt: "2026-10-12T00:00:00.000Z",
};
const android: DeviceRecord = {
  platform: "android",
  pushToken: "fcm-1",
  bundleId: "com.nachogames.ctrl",
  deviceId: "device-1",
  androidUserId: "direct",
  lastSeenAt: NOW - 1_000,
  manageHash: "manage",
};
const iphone: DeviceRecord = {
  platform: "ios",
  pushToken: "apns-1",
  bundleId: "com.nachogames.ctrl",
  apsEnvironment: "sandbox",
  deviceId: "device-2",
  lastSeenAt: NOW - 1_000,
  manageHash: "manage",
};

/** Fakes Google OAuth, FCM and APNs; `pushStatus`/`pushBody` answer the push itself. */
function fakeServices(pushStatus = 200, pushBody = "{}") {
  const calls: Array<{ url: string; headers: Headers; body: string }> = [];
  const fetch: Deps["fetch"] = async (input, init) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: "google-token" }));
    }
    return new Response(pushBody, { status: pushStatus });
  };
  return { calls, deps: { fetch, now: () => NOW } satisfies Deps };
}

async function setup(record: DeviceRecord, overrides: Partial<Env> = {}) {
  const kv = memoryStore();
  await writeDevice(kv.store, await hashSendToken("token-1"), record);
  const writesBefore = kv.writes();
  const env = testEnv({
    DEVICES: kv.store,
    APNS_PRIVATE_KEY: apnsKey,
    FCM_SERVICE_ACCOUNT: fcmAccount,
    ...overrides,
  });
  return { kv, env, writesSinceSetup: () => kv.writes() - writesBefore };
}

const send = (env: Env, deps: Deps, body: unknown) =>
  handle(
    new Request("https://relay.test/send", { method: "POST", body: JSON.stringify(body) }),
    env,
    deps,
  );

describe("POST /send", () => {
  it("pushes an alert to Android through FCM with the shared payload", async () => {
    const { env, writesSinceSetup } = await setup(android);
    const services = fakeServices();
    const response = await send(env, services.deps, { sendToken: "token-1", message: alert });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: "sent" });
    const push = services.calls.find((call) => call.url.includes("fcm.googleapis.com"));
    expect(push?.url).toBe("https://fcm.googleapis.com/v1/projects/ctrl-test/messages:send");
    expect(push?.headers.get("authorization")).toBe("Bearer google-token");
    const message = JSON.parse(push?.body ?? "{}").message;
    expect(message.token).toBe("fcm-1");
    expect(message.android.restricted_package_name).toBe("com.nachogames.ctrl");
    expect(message.data).toMatchObject({
      t3_kind: "agent_activity",
      device_id: "device-1",
      user_id: "direct",
      alert_path: "/threads/env-1/thread-1",
    });
    // A fresh record is not rewritten: sends must not spend KV writes.
    expect(writesSinceSetup()).toBe(0);
  });

  it("pushes to iOS through APNs, clears as background pushes", async () => {
    const { env } = await setup(iphone);
    const services = fakeServices();
    await send(env, services.deps, { sendToken: "token-1", message: alert });
    await send(env, services.deps, {
      sendToken: "token-1",
      message: { type: "clear", environmentId: "env-1", threadId: "thread-1" },
    });
    const [alertCall, clearCall] = services.calls;
    expect(alertCall?.url).toBe("https://api.sandbox.push.apple.com/3/device/apns-1");
    expect(alertCall?.headers.get("apns-topic")).toBe("com.nachogames.ctrl");
    expect(alertCall?.headers.get("apns-push-type")).toBe("alert");
    expect(alertCall?.headers.get("authorization")).toMatch(/^bearer ey/);
    expect(JSON.parse(alertCall?.body ?? "{}").aps.alert.body).toBe("Input: Ctrl");
    expect(clearCall?.headers.get("apns-push-type")).toBe("background");
    expect(clearCall?.headers.get("apns-priority")).toBe("5");
    expect(JSON.parse(clearCall?.body ?? "{}").t3_clear_thread).toBe("env-1/thread-1");
  });

  it("deletes the phone and answers 410 when the push service says the token is dead", async () => {
    const { kv, env } = await setup(android);
    const services = fakeServices(404, '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}');
    const response = await send(env, services.deps, { sendToken: "token-1", message: alert });
    expect(response.status).toBe(410);
    expect(kv.entries.size).toBe(0);
  });

  it("answers 502 without deleting on other push failures", async () => {
    const { kv, env } = await setup(iphone);
    const response = await send(env, fakeServices(500).deps, {
      sendToken: "token-1",
      message: alert,
    });
    expect(response.status).toBe(502);
    expect(kv.entries.size).toBe(1);
  });

  it("answers 404 for unknown tokens and 429 when over the limit", async () => {
    const { env } = await setup(android);
    const unknown = await send(env, fakeServices().deps, { sendToken: "nope", message: alert });
    expect(unknown.status).toBe(404);
    const limited = (await setup(android, { SEND_LIMITER: limiter(false) })).env;
    const flooded = await send(limited, fakeServices().deps, {
      sendToken: "token-1",
      message: alert,
    });
    expect(flooded.status).toBe(429);
  });

  it("rejects malformed and free-form bodies with 400", async () => {
    const { env } = await setup(android);
    const deps = fakeServices().deps;
    const freeForm = await send(env, deps, {
      sendToken: "token-1",
      message: { type: "alert", aps: {} },
    });
    expect(freeForm.status).toBe(400);
    const notJson = await handle(
      new Request("https://relay.test/send", { method: "POST", body: "{nope" }),
      env,
      deps,
    );
    expect(notJson.status).toBe(400);
  });

  it("refreshes a record's expiry when it is older than a week", async () => {
    const { env, writesSinceSetup } = await setup({ ...android, lastSeenAt: 0 });
    await send(env, fakeServices().deps, { sendToken: "token-1", message: alert });
    expect(writesSinceSetup()).toBe(1);
  });
});
