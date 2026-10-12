import * as NodeHttp2 from "node:http2";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { importPKCS8, SignJWT } from "jose";

/**
 * Minimal APNs and FCM senders for direct push. Volume is a handful of alerts
 * per hour from one machine, so each APNs send opens its own HTTP/2 session
 * (APNs only speaks HTTP/2, which fetch-based HttpClient does not negotiate).
 */

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKeyPem: string;
}

export const FcmServiceAccount = Schema.Struct({
  project_id: Schema.NonEmptyString,
  client_email: Schema.NonEmptyString,
  private_key: Schema.NonEmptyString,
});
export type FcmServiceAccount = typeof FcmServiceAccount.Type;

export type PushSendResult = "sent" | "unregistered";

export class PushSendError extends Schema.TaggedError<PushSendError>()("PushSendError", {
  service: Schema.Literals(["apns", "fcm"]),
  status: Schema.NullOr(Schema.Number),
  reason: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `${this.service.toUpperCase()} push failed (${this.status ?? "no response"}${this.reason ? ` ${this.reason}` : ""}).`;
  }
}

const SEND_TIMEOUT = "10 seconds";

const decodeReason = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ reason: Schema.String })),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// APNs rejects provider tokens refreshed more often than every 20 minutes and
// expires them after an hour.
const apnsTokens = new Map<string, { readonly token: string; readonly issuedAt: number }>();

const apnsProviderToken = (credentials: ApnsCredentials, nowMs: number) => {
  const cacheKey = `${credentials.teamId}:${credentials.keyId}`;
  const cached = apnsTokens.get(cacheKey);
  if (cached && nowMs - cached.issuedAt < 40 * 60_000) return Effect.succeed(cached.token);
  return Effect.tryPromise({
    try: async () =>
      new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: credentials.keyId })
        .setIssuer(credentials.teamId)
        .setIssuedAt(Math.floor(nowMs / 1000))
        .sign(await importPKCS8(credentials.privateKeyPem, "ES256")),
    catch: (cause) =>
      new PushSendError({ service: "apns", status: null, reason: "InvalidSigningKey", cause }),
  }).pipe(
    Effect.tap((token) => Effect.sync(() => apnsTokens.set(cacheKey, { token, issuedAt: nowMs }))),
  );
};

const http2Post = (input: {
  readonly origin: string;
  readonly headers: NodeHttp2.OutgoingHttpHeaders;
  readonly body: string;
}) =>
  Effect.callback<{ readonly status: number; readonly text: string }, PushSendError>((resume) => {
    const session = NodeHttp2.connect(input.origin);
    const fail = (cause: unknown) => {
      session.destroy();
      resume(Effect.fail(new PushSendError({ service: "apns", status: null, cause })));
    };
    session.on("error", fail);
    const request = session.request({ ":method": "POST", ...input.headers });
    let status = 0;
    let text = "";
    request.setEncoding("utf8");
    request.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    request.on("data", (chunk: string) => {
      text += chunk;
    });
    request.on("end", () => {
      session.close();
      resume(Effect.succeed({ status, text }));
    });
    request.on("error", fail);
    request.end(input.body);
    return Effect.sync(() => session.destroy());
  });

export const sendApns = Effect.fn("DirectPush.sendApns")(function* (input: {
  readonly credentials: ApnsCredentials;
  readonly environment: "sandbox" | "production";
  readonly deviceToken: string;
  readonly topic: string;
  readonly payload: unknown;
  /** Background pushes wake the app silently; Apple requires priority 5 for them. */
  readonly pushType?: "alert" | "background";
  readonly nowMs: number;
}) {
  const pushType = input.pushType ?? "alert";
  const providerToken = yield* apnsProviderToken(input.credentials, input.nowMs);
  const response = yield* http2Post({
    origin:
      input.environment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com",
    headers: {
      ":path": `/3/device/${input.deviceToken}`,
      authorization: `bearer ${providerToken}`,
      "apns-push-type": pushType,
      "apns-topic": input.topic,
      "apns-priority": pushType === "alert" ? "10" : "5",
      "content-type": "application/json",
    },
    body: encodeJson(input.payload),
  }).pipe(
    Effect.timeoutOrElse({
      duration: SEND_TIMEOUT,
      orElse: () => Effect.fail(new PushSendError({ service: "apns", status: null })),
    }),
  );
  if (response.status === 200) return "sent" as PushSendResult;
  const reason = Option.getOrUndefined(decodeReason(response.text))?.reason;
  // BadDeviceToken also means a sandbox/production mismatch, so it is an error,
  // not proof the device is gone.
  if (response.status === 410 || reason === "Unregistered") {
    return "unregistered" as PushSendResult;
  }
  if (reason === "ExpiredProviderToken") apnsTokens.clear();
  return yield* new PushSendError({
    service: "apns",
    status: response.status,
    ...(reason ? { reason } : {}),
  });
});

const decodeAccessToken = Schema.decodeUnknownEffect(
  Schema.Struct({ access_token: Schema.NonEmptyString }),
);
const fcmAccessTokens = new Map<string, { readonly token: string; readonly expiresAt: number }>();

const fcmAccessToken = Effect.fn("DirectPush.fcmAccessToken")(function* (
  account: FcmServiceAccount,
  nowMs: number,
) {
  const cached = fcmAccessTokens.get(account.client_email);
  if (cached && cached.expiresAt > nowMs) return cached.token;
  const client = yield* HttpClient.HttpClient;
  const issuedAt = Math.floor(nowMs / 1000);
  const fail = (cause: unknown, status: number | null = null) =>
    new PushSendError({ service: "fcm", status, reason: "OAuth", cause });
  const assertion = yield* Effect.tryPromise({
    try: async () =>
      new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" })
        .setProtectedHeader({ alg: "RS256", typ: "JWT" })
        .setIssuer(account.client_email)
        .setAudience("https://oauth2.googleapis.com/token")
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + 3600)
        .sign(await importPKCS8(account.private_key, "RS256")),
    catch: (cause) => fail(cause),
  });
  const response = yield* client
    .execute(
      HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
      ),
    )
    .pipe(
      Effect.timeout(SEND_TIMEOUT),
      Effect.mapError((cause) => fail(cause)),
    );
  if (response.status !== 200) return yield* fail(undefined, response.status);
  const { access_token } = yield* response.json.pipe(
    Effect.flatMap(decodeAccessToken),
    Effect.mapError((cause) => fail(cause, response.status)),
  );
  fcmAccessTokens.set(account.client_email, {
    token: access_token,
    expiresAt: nowMs + 50 * 60_000,
  });
  return access_token;
});

export const sendFcm = Effect.fn("DirectPush.sendFcm")(function* (input: {
  readonly account: FcmServiceAccount;
  readonly registrationToken: string;
  readonly packageName: string;
  readonly data: Readonly<Record<string, string>>;
  readonly nowMs: number;
}) {
  const client = yield* HttpClient.HttpClient;
  const accessToken = yield* fcmAccessToken(input.account, input.nowMs);
  const response = yield* HttpClientRequest.post(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(input.account.project_id)}/messages:send`,
  ).pipe(
    HttpClientRequest.bearerToken(accessToken),
    HttpClientRequest.bodyJson({
      message: {
        token: input.registrationToken,
        data: input.data,
        android: { priority: "HIGH", ttl: "300s", restricted_package_name: input.packageName },
      },
    }),
    Effect.flatMap(client.execute),
    Effect.timeout(SEND_TIMEOUT),
    Effect.mapError((cause) => new PushSendError({ service: "fcm", status: null, cause })),
  );
  if (response.status >= 200 && response.status < 300) return "sent" as PushSendResult;
  if (response.status === 401) fcmAccessTokens.delete(input.account.client_email);
  const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
  // Only the UNREGISTERED error code means a stale token. A bare 404 can also be
  // a wrong project or a disabled API, which must not drop every device.
  if (text.includes('"UNREGISTERED"')) {
    return "unregistered" as PushSendResult;
  }
  return yield* new PushSendError({ service: "fcm", status: response.status });
});
