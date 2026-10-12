import type { DeviceStore, Env, Limiter } from "./env.ts";

/** In-memory KV that counts writes, so tests can hold the relay to its write budget. */
export function memoryStore() {
  const entries = new Map<string, { value: string; ttl?: number }>();
  let writes = 0;
  const store: DeviceStore = {
    get: async (key) => entries.get(key)?.value ?? null,
    put: async (key, value, options) => {
      writes += 1;
      entries.set(key, {
        value,
        ...(options?.expirationTtl ? { ttl: options.expirationTtl } : {}),
      });
    },
    delete: async (key) => {
      writes += 1;
      entries.delete(key);
    },
  };
  return { store, entries, writes: () => writes };
}

export function limiter(allow = true): Limiter {
  return { limit: async () => ({ success: allow }) };
}

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DEVICES: memoryStore().store,
    REGISTER_LIMITER: limiter(),
    SEND_LIMITER: limiter(),
    ALLOWED_BUNDLE_IDS: "com.nachogames.ctrl",
    APNS_TEAM_ID: "TEAM",
    APNS_KEY_ID: "KEY",
    APNS_PRIVATE_KEY: "",
    FCM_SERVICE_ACCOUNT: "",
    ...overrides,
  };
}
