/**
 * DirectPush sends agent alerts from this server straight to APNs and FCM,
 * for phones that reach the environment directly (LAN, Tailscale) and are not
 * signed in to T3 Connect. Credentials are files the owner drops into
 * `<stateDir>/push/` (see `docs/user/mobile-notifications.md`); phones register
 * their push tokens over the `push.registerDevice` RPC.
 */
import {
  type DirectPushAlertKind,
  type DirectPushDeviceRegistration,
  DirectPushDeviceRegistration as DirectPushDeviceRegistrationSchema,
  type DirectPushStatus,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import {
  type AgentAwarenessPhase,
  type AgentAwarenessState,
  projectThreadAwarenessV2,
} from "@t3tools/shared/agentAwareness";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { shouldPublishAgentAwarenessEvent } from "../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../serverActivation.ts";
import { alertKind, apnsAlertPayload, deviceWantsAlert, fcmAlertData } from "./directPushAlerts.ts";
import {
  type ApnsCredentials,
  FcmServiceAccount,
  type PushSendResult,
  sendApns,
  sendFcm,
} from "./pushTransports.ts";

export class DirectPush extends Context.Service<
  DirectPush,
  {
    readonly registerDevice: (
      registration: DirectPushDeviceRegistration,
    ) => Effect.Effect<DirectPushStatus>;
    readonly unregisterDevice: (deviceId: string) => Effect.Effect<void>;
    /** Alerts every registered device about this state; exposed for tests. */
    readonly notify: (state: AgentAwarenessState, kind: DirectPushAlertKind) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/push/DirectPush") {}

const PushConfigFile = Schema.Struct({
  apns: Schema.optionalKey(
    Schema.Struct({ teamId: Schema.String, keyId: Schema.String, keyPath: Schema.String }),
  ),
  fcm: Schema.optionalKey(Schema.Struct({ serviceAccountPath: Schema.String })),
});
const decodePushConfig = Schema.decodeUnknownOption(Schema.fromJsonString(PushConfigFile));
const decodeFcmServiceAccount = Schema.decodeUnknownOption(
  Schema.fromJsonString(FcmServiceAccount),
);

const StoredDevice = Schema.Struct({
  ...DirectPushDeviceRegistrationSchema.fields,
  registeredAt: Schema.String,
});
type StoredDevice = typeof StoredDevice.Type;
const StoredDevicesJson = Schema.fromJsonString(Schema.Array(StoredDevice));
const decodeStoredDevices = Schema.decodeUnknownOption(StoredDevicesJson);
const encodeStoredDevices = Schema.encodeEffect(StoredDevicesJson);

interface PushCredentials {
  readonly apns: ApnsCredentials | null;
  readonly fcm: FcmServiceAccount | null;
}

function sameRegistration(a: DirectPushDeviceRegistration, b: DirectPushDeviceRegistration) {
  return (Object.keys(DirectPushDeviceRegistrationSchema.fields) as Array<keyof typeof a>).every(
    (key) => String(a[key]) === String(b[key]),
  );
}

export const make = Effect.fn("DirectPush.make")(function* (options?: {
  readonly pushDir?: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const pushDir = options?.pushDir ?? pathService.join(serverConfig.stateDir, "push");
  const configPath = pathService.join(pushDir, "config.json");
  const devicesPath = pathService.join(pushDir, "devices.json");
  const startedAt = yield* Clock.currentTimeMillis;
  const devices = new Map<string, StoredDevice>();
  const phases = new Map<ThreadId, AgentAwarenessPhase | null>();

  const homeDir = process.env.HOME ?? "";
  const readOptionalFile = (filePath: string) =>
    fileSystem
      .readFileString(
        filePath.startsWith("~/") ? pathService.join(homeDir, filePath.slice(2)) : filePath,
      )
      .pipe(Effect.option);

  const storedDevices = yield* readOptionalFile(devicesPath);
  if (Option.isSome(storedDevices)) {
    const decoded = decodeStoredDevices(storedDevices.value);
    if (Option.isNone(decoded)) {
      yield* Effect.logWarning("Ignoring unreadable direct push device list", { devicesPath });
    }
    for (const device of Option.getOrElse(decoded, () => [])) devices.set(device.deviceId, device);
  }

  const saveDevices = Effect.gen(function* () {
    yield* fileSystem.makeDirectory(pushDir, { recursive: true, mode: 0o700 });
    const temporaryPath = `${devicesPath}.tmp`;
    yield* fileSystem.writeFileString(
      temporaryPath,
      yield* encodeStoredDevices([...devices.values()]),
      { mode: 0o600 },
    );
    yield* fileSystem.rename(temporaryPath, devicesPath);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not save direct push devices", { devicesPath, cause }),
    ),
  );

  // Read on every use so credentials dropped in later work without a restart.
  const readCredentials = Effect.gen(function* () {
    const raw = yield* readOptionalFile(configPath);
    const config = Option.flatMap(raw, decodePushConfig);
    if (Option.isNone(config)) {
      if (Option.isSome(raw)) {
        yield* Effect.logWarning("Ignoring invalid push config", { configPath });
      }
      return { apns: null, fcm: null } satisfies PushCredentials;
    }
    const { apns, fcm } = config.value;
    const apnsKey = apns ? yield* readOptionalFile(apns.keyPath) : Option.none<string>();
    const fcmAccount = fcm
      ? Option.flatMap(yield* readOptionalFile(fcm.serviceAccountPath), decodeFcmServiceAccount)
      : Option.none<FcmServiceAccount>();
    return {
      apns:
        apns && Option.isSome(apnsKey)
          ? { teamId: apns.teamId, keyId: apns.keyId, privateKeyPem: apnsKey.value }
          : null,
      fcm: Option.getOrNull(fcmAccount),
    } satisfies PushCredentials;
  });

  const sendToDevice = (
    device: StoredDevice,
    state: AgentAwarenessState,
    credentials: PushCredentials,
  ) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      let result: PushSendResult;
      if (device.platform === "ios") {
        if (credentials.apns === null) {
          return yield* Effect.logWarning("Direct push skipped: APNs is not configured");
        }
        result = yield* sendApns({
          credentials: credentials.apns,
          environment: device.apsEnvironment ?? "production",
          deviceToken: device.token,
          topic: device.bundleId,
          payload: apnsAlertPayload(state),
          nowMs,
        });
      } else {
        if (credentials.fcm === null) {
          return yield* Effect.logWarning("Direct push skipped: FCM is not configured");
        }
        result = yield* sendFcm({
          account: credentials.fcm,
          registrationToken: device.token,
          packageName: device.bundleId,
          data: fcmAlertData({
            state,
            deviceId: device.deviceId,
            userId: device.androidUserId ?? "",
            nowMs,
          }),
          nowMs,
        });
      }
      if (result === "unregistered") {
        devices.delete(device.deviceId);
        yield* saveDevices;
        yield* Effect.logInfo("Removed direct push device the push service no longer accepts", {
          label: device.label,
        });
      }
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.catchCause((cause) =>
        Effect.logWarning("Direct push delivery failed", { label: device.label, cause }),
      ),
    );

  const notify = Effect.fn("DirectPush.notify")(function* (
    state: AgentAwarenessState,
    kind: DirectPushAlertKind,
  ) {
    const targets = [...devices.values()].filter(
      (device) => device.notificationsEnabled && deviceWantsAlert(device.alertOn, kind),
    );
    if (targets.length === 0) return;
    const credentials = yield* readCredentials;
    yield* Effect.forEach(targets, (device) => sendToDevice(device, state, credentials), {
      concurrency: "unbounded",
      discard: true,
    });
  });

  const handleThread = Effect.fn("DirectPush.handleThread")(function* (threadId: ThreadId) {
    const shell = yield* threads.getThreadShell(threadId);
    // Subagents never project activity; their parent thread carries it.
    if (shell?.lineage.relationshipToParent === "subagent") return;
    const project =
      shell === null || shell.archivedAt !== null
        ? Option.none()
        : yield* projects.getById(shell.projectId);
    const state =
      shell !== null && Option.isSome(project)
        ? projectThreadAwarenessV2({
            environmentId: yield* serverEnvironment.getEnvironmentId,
            project: project.value,
            thread: shell,
          })
        : null;
    const previousPhase = phases.get(threadId);
    phases.set(threadId, state?.phase ?? null);
    const finishedSinceStart =
      shell?.latestRunCompletedAt != null &&
      DateTime.toEpochMillis(shell.latestRunCompletedAt) > startedAt;
    const nowMs = yield* Clock.currentTimeMillis;
    const kind = alertKind({ state, previousPhase, finishedSinceStart, nowMs });
    if (state !== null && kind !== null) {
      yield* Effect.logInfo("Sending direct push alert", { threadId, kind });
      yield* notify(state, kind);
    }
  });

  const registerDevice = Effect.fn("DirectPush.registerDevice")(function* (
    registration: DirectPushDeviceRegistration,
  ) {
    const existing = devices.get(registration.deviceId);
    if (existing === undefined || !sameRegistration(existing, registration)) {
      devices.set(registration.deviceId, {
        ...registration,
        registeredAt: DateTime.formatIso(yield* DateTime.now),
      });
      yield* saveDevices;
      yield* Effect.logInfo("Registered direct push device", {
        label: registration.label,
        platform: registration.platform,
        notificationsEnabled: registration.notificationsEnabled,
      });
    }
    const credentials = yield* readCredentials;
    return { ios: credentials.apns !== null, android: credentials.fcm !== null };
  });

  const unregisterDevice = Effect.fn("DirectPush.unregisterDevice")(function* (deviceId: string) {
    if (devices.delete(deviceId)) yield* saveDevices;
  });

  const start = Effect.fn("DirectPush.start")(function* () {
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event: OrchestrationV2DomainEvent) =>
        shouldPublishAgentAwarenessEvent(event)
          ? handleThread(event.threadId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Direct push could not evaluate thread", {
                  threadId: event.threadId,
                  cause,
                }),
              ),
            )
          : Effect.void,
      ).pipe(Effect.catchCause((cause) => Effect.logWarning("Direct push stopped", { cause }))),
    );
  });

  return DirectPush.of({ registerDevice, unregisterDevice, notify, start });
});

export const layer = Layer.effect(DirectPush, make());
