import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { DirectPushDeviceRegistration } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

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

const makeService = (pushDir: string) =>
  DirectPush.make({ pushDir }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ServerConfig.ServerConfig)({} as ServerConfig.ServerConfig["Service"]),
        Layer.mock(ServerEnvironment.ServerEnvironment)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
      ),
    ),
  );

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
});
