import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { exportPKCS8, generateKeyPair } from "jose";

import { sendFcm } from "./pushTransports.ts";

const { privateKey } = await generateKeyPair("RS256", { extractable: true });
const account = {
  project_id: "ctrl-test",
  client_email: "push@ctrl-test.iam.gserviceaccount.com",
  private_key: await exportPKCS8(privateKey),
};

// Answers the OAuth exchange, then returns `send` for messages:send.
const fcmLayer = (send: { readonly status: number; readonly body: string }) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        request.url.startsWith("https://oauth2.googleapis.com/")
          ? HttpClientResponse.fromWeb(
              request,
              new Response('{"access_token":"token"}', { status: 200 }),
            )
          : HttpClientResponse.fromWeb(request, new Response(send.body, { status: send.status })),
      ),
    ),
  );

const send = sendFcm({
  account,
  registrationToken: "registration-token",
  packageName: "com.example.app",
  data: {},
  nowMs: 1_800_000_000_000,
});

it.effect("treats an UNREGISTERED FCM error as a stale token", () =>
  Effect.gen(function* () {
    const result = yield* send.pipe(
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
    const result = yield* send.pipe(
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
