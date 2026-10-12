import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { DirectPushDeviceRegistration } from "@t3tools/contracts";
import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as DirectPush from "./DirectPush.ts";

const phone: DirectPushDeviceRegistration = {
  deviceId: "device-1",
  label: "Pixel 7",
  platform: "android",
  token: "fcm-token",
  bundleId: "com.example.app",
  androidUserId: "direct",
  notificationsEnabled: true,
};

const makeService = (pushDir: string, httpClientLayer?: Layer.Layer<HttpClient.HttpClient>) =>
  DirectPush.make({ pushDir, ...(httpClientLayer ? { httpClientLayer } : {}) }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ServerConfig.ServerConfig)({} as ServerConfig.ServerConfig["Service"]),
        Layer.mock(ServerEnvironment.ServerEnvironment)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
      ),
    ),
  );

// Relay phones keep their push token to themselves, so Reset can cut a computer off.
const { token: _phoneToken, ...phoneWithoutToken } = phone;
const relayPhone: DirectPushDeviceRegistration = {
  ...phoneWithoutToken,
  relayUrl: "https://relay.test",
  relayToken: "send-token",
};

const awaiting = {
  environmentId: "env-1",
  threadId: "thread-1",
  projectTitle: "Ctrl",
  threadTitle: "Fix the build",
  phase: "waiting_for_input",
  headline: "",
  modelTitle: "Claude",
  updatedAt: "2026-10-12T00:00:00.000Z",
  deepLink: "/threads/env-1/thread-1",
} as AgentAwarenessState;

/** Answers every request with `status` and records what was sent. */
function fakeRelay(status: number) {
  const requests: Array<{ url: string; body: unknown }> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : null;
        requests.push({ url: request.url, body });
        return HttpClientResponse.fromWeb(request, new Response("{}", { status }));
      }),
    ),
  );
  return { requests, layer };
}

it.layer(NodeServices.layer)("DirectPush", (it) => {
  it.effect("persists registrations and reports which platforms have keys", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const pushDir = yield* fs.makeTempDirectoryScoped({ prefix: "direct-push-" });
      const devicesPath = path.join(pushDir, "devices.json");
      const service = yield* makeService(pushDir);

      assert.deepStrictEqual(yield* service.registerDevice(phone), { ios: false, android: false });

      const accountPath = path.join(pushDir, "fcm.json");
      yield* fs.writeFileString(
        accountPath,
        '{"project_id":"p","client_email":"c@example.com","private_key":"k"}',
      );
      yield* fs.writeFileString(
        path.join(pushDir, "config.json"),
        `{"fcm":{"serviceAccountPath":"${accountPath}"}}`,
      );
      // Keys dropped in later are picked up without a restart.
      assert.deepStrictEqual(yield* service.registerDevice(phone), { ios: false, android: true });

      const stored = yield* fs.readFileString(devicesPath);
      assert.include(stored, '"deviceId":"device-1"');
      assert.include(stored, '"token":"fcm-token"');
      assert.strictEqual((yield* fs.stat(devicesPath)).mode & 0o777, 0o600);

      // A restarted server still knows the device; unregistering forgets it.
      const restarted = yield* makeService(pushDir);
      yield* restarted.unregisterDevice("device-1");
      assert.strictEqual(yield* fs.readFileString(devicesPath), "[]");
    }),
  );

  it.effect("resolves relative key paths against the push directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const pushDir = yield* fs.makeTempDirectoryScoped({ prefix: "direct-push-" });
      yield* fs.writeFileString(
        path.join(pushDir, "fcm.json"),
        '{"project_id":"p","client_email":"c@example.com","private_key":"k"}',
      );
      yield* fs.writeFileString(
        path.join(pushDir, "config.json"),
        '{"fcm":{"serviceAccountPath":"fcm.json"}}',
      );
      const service = yield* makeService(pushDir);

      assert.deepStrictEqual(yield* service.registerDevice(phone), { ios: false, android: true });
    }),
  );

  it.effect("sends relay devices' alerts to the relay, with no local keys", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pushDir = yield* fs.makeTempDirectoryScoped({ prefix: "direct-push-" });
      const relay = fakeRelay(200);
      const service = yield* makeService(pushDir, relay.layer);

      // No config.json: the relay makes the device ready anyway.
      assert.deepStrictEqual(yield* service.registerDevice(relayPhone), {
        ios: true,
        android: true,
      });
      yield* service.notify(awaiting, "input");

      assert.strictEqual(relay.requests.length, 1);
      assert.strictEqual(relay.requests[0]?.url, "https://relay.test/send");
      assert.deepStrictEqual(relay.requests[0]?.body, {
        sendToken: "send-token",
        message: {
          type: "alert",
          kind: "input",
          environmentId: "env-1",
          threadId: "thread-1",
          threadTitle: "Fix the build",
          projectTitle: "Ctrl",
          updatedAt: "2026-10-12T00:00:00.000Z",
        },
      });
    }),
  );

  it.effect("forgets a device whose relay token is dead or reset", () =>
    Effect.gen(function* () {
      for (const status of [410, 404]) {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const pushDir = yield* fs.makeTempDirectoryScoped({ prefix: "direct-push-" });
        const service = yield* makeService(pushDir, fakeRelay(status).layer);
        yield* service.registerDevice(relayPhone);
        yield* service.notify(awaiting, "input");
        assert.strictEqual(yield* fs.readFileString(path.join(pushDir, "devices.json")), "[]");
      }
    }),
  );

  it.effect("keeps the device when the relay is busy or failing", () =>
    Effect.gen(function* () {
      for (const status of [429, 502]) {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const pushDir = yield* fs.makeTempDirectoryScoped({ prefix: "direct-push-" });
        const service = yield* makeService(pushDir, fakeRelay(status).layer);
        yield* service.registerDevice(relayPhone);
        yield* service.notify(awaiting, "input");
        assert.include(yield* fs.readFileString(path.join(pushDir, "devices.json")), "device-1");
      }
    }),
  );

  it.effect("a dead token does not delete the phone's newer relay registration", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const pushDir = yield* fs.makeTempDirectoryScoped({ prefix: "direct-push-" });
      let service: DirectPush.DirectPush["Service"] | undefined;
      // The phone resets and re-registers while the send with its old token is in flight.
      const relay = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            yield* service!.registerDevice({ ...relayPhone, relayToken: "new-token" });
            return HttpClientResponse.fromWeb(request, new Response("{}", { status: 404 }));
          }),
        ),
      );
      service = yield* makeService(pushDir, relay);
      yield* service.registerDevice(relayPhone);
      yield* service.notify(awaiting, "input");
      assert.include(yield* fs.readFileString(path.join(pushDir, "devices.json")), "new-token");
    }),
  );
});
