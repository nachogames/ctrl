import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Jwk from "effect/jose/Jwk";
import * as Jwt from "effect/jose/Jwt";

import { type FcmServiceAccount, sendFcm } from "./pushTransports.ts";

const testKeys = Effect.gen(function* () {
  const pair = yield* Jwk.generateKeyPair({ algorithm: "RS256" });
  const privateKey = yield* Jwk.importPrivate(pair.privateKey, "RS256");
  const pem = yield* Jwk.exportPkcs8(privateKey, { format: "pem" });
  return { pem: Redacted.value(pem), publicKey: yield* Jwk.importPublic(pair.publicKey, "RS256") };
}).pipe(Effect.provide(PlatformNodeCrypto.layer));

const testAccount = testKeys.pipe(
  Effect.map(({ pem }): FcmServiceAccount => ({
    project_id: "ctrl-test",
    client_email: "push@ctrl-test.iam.gserviceaccount.com",
    private_key: pem,
  })),
);

// Answers the OAuth exchange, then returns `send` for messages:send.
const fcmLayer = (
  send: { readonly status: number; readonly body: string },
  onOAuth: (form: URLSearchParams) => void = () => {},
) =>
  Layer.mergeAll(
    PlatformNodeCrypto.layer,
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        if (!request.url.startsWith("https://oauth2.googleapis.com/")) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(send.body, { status: send.status })),
          );
        }
        if (request.body._tag === "Uint8Array") {
          onOAuth(new URLSearchParams(new TextDecoder().decode(request.body.body)));
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response('{"access_token":"token"}', { status: 200 }),
          ),
        );
      }),
    ),
  );

const send = (account: FcmServiceAccount, nowMs = 1_800_000_000_000) =>
  sendFcm({
    account,
    registrationToken: "registration-token",
    packageName: "com.example.app",
    data: {},
    nowMs,
  });

it.effect("signs the FCM OAuth assertion with the service account's RS256 key", () =>
  Effect.gen(function* () {
    const { pem, publicKey } = yield* testKeys;
    // A fresh client_email skips the access token another test cached.
    const clientEmail = "signer@ctrl-test.iam.gserviceaccount.com";
    let assertion = "";
    yield* send({ project_id: "ctrl-test", client_email: clientEmail, private_key: pem }, 0).pipe(
      Effect.provide(
        fcmLayer({ status: 200, body: "{}" }, (form) => {
          assertion = form.get("assertion") ?? "";
        }),
      ),
    );
    const verified = yield* Jwt.verify(
      Schema.Struct({ scope: Schema.String }),
      assertion,
      publicKey,
      {
        issuer: clientEmail,
        audience: "https://oauth2.googleapis.com/token",
        typ: "JWT",
        requiredClaims: ["iat", "exp"],
      },
    ).pipe(Effect.provide(PlatformNodeCrypto.layer));
    assert.strictEqual(verified.protectedHeader.alg, "RS256");
    assert.strictEqual(verified.claims.scope, "https://www.googleapis.com/auth/firebase.messaging");
    assert.strictEqual(verified.registeredClaims.exp, 3600);
  }),
);

it.effect("treats an UNREGISTERED FCM error as a stale token", () =>
  Effect.gen(function* () {
    const result = yield* send(yield* testAccount).pipe(
      Effect.provide(
        fcmLayer({
          status: 404,
          body: '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}',
        }),
      ),
    );
    assert.strictEqual(result, "unregistered");
  }),
);

it.effect("keeps devices when FCM 404s for the project itself", () =>
  Effect.gen(function* () {
    const result = yield* send(yield* testAccount).pipe(
      Effect.provide(
        fcmLayer({
          status: 404,
          body: '{"error":{"status":"NOT_FOUND","message":"Requested entity was not found."}}',
        }),
      ),
      Effect.flip,
    );
    assert.strictEqual(result._tag, "PushSendError");
  }),
);
