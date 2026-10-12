/** Workers KV, narrowed to what the relay uses so tests can supply a map. */
export interface DeviceStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Cloudflare's rate limiting binding. */
export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  readonly DEVICES: DeviceStore;
  readonly REGISTER_LIMITER: Limiter;
  readonly SEND_LIMITER: Limiter;
  /** Comma-separated app ids the keys can push to. */
  readonly ALLOWED_BUNDLE_IDS: string;
  readonly APNS_TEAM_ID: string;
  readonly APNS_KEY_ID: string;
  readonly APNS_PRIVATE_KEY: string;
  /** The Firebase service account JSON. */
  readonly FCM_SERVICE_ACCOUNT: string;
}

export interface Deps {
  readonly fetch: typeof fetch;
  readonly now: () => number;
}
