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
  type PushRelayMessage,
} from "@t3tools/contracts";
import {
  type AgentAwarenessPhase,
  type AgentAwarenessState,
  projectThreadAwarenessV2,
} from "@t3tools/shared/agentAwareness";
import * as NodeOS from "node:os";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { shouldPublishAgentAwarenessEvent } from "../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../serverActivation.ts";
import {
  apnsAlertPayload,
  apnsClearPayload,
  apnsPushType,
  fcmAlertData,
  fcmClearData,
} from "@t3tools/shared/pushPayloads";
import { alertKind, alertMessage, answeredKind, deviceWantsAlert } from "./directPushAlerts.ts";
import {
  type ApnsCredentials,
  FcmServiceAccount,
  type PushSendResult,
  sendApns,
  sendFcm,
  sendRelay,
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
    /** Removes a thread's alerts from phones that got its `kind` alert. */
    readonly clear: (
      thread: { readonly environmentId: string; readonly threadId: string },
      kind: DirectPushAlertKind,
    ) => Effect.Effect<void>;
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
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
}) {
  const httpClientLayer = options?.httpClientLayer ?? FetchHttpClient.layer;
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

  // Config paths may start with `~/`; other relative paths resolve against the push dir.
  const resolveConfigPath = (filePath: string) =>
    filePath.startsWith("~/")
      ? pathService.join(NodeOS.homedir(), filePath.slice(2))
      : pathService.resolve(pushDir, filePath);
  const readOptionalFile = (filePath: string) =>
    fileSystem.readFileString(resolveConfigPath(filePath)).pipe(Effect.option);

  const storedDevices = yield* readOptionalFile(devicesPath);
  if (Option.isSome(storedDevices)) {
    const decoded = decodeStoredDevices(storedDevices.value);
    if (Option.isNone(decoded)) {
      yield* Effect.logWarning("Ignoring unreadable direct push device list", { devicesPath });
    }
    for (const device of Option.getOrElse(decoded, () => [])) devices.set(device.deviceId, device);
  }

  // Writes share one temp file, so they must not overlap.
  const saveLock = yield* Semaphore.make(1);
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
    saveLock.withPermits(1),
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
    message: PushRelayMessage,
    credentials: PushCredentials,
  ) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      let result: PushSendResult;
      if (device.relayUrl !== undefined && device.relayToken !== undefined) {
        result = yield* sendRelay({
          relayUrl: device.relayUrl,
          relayToken: device.relayToken,
          message,
        });
      } else if (device.platform === "ios") {
        if (credentials.apns === null) {
          return yield* Effect.logWarning("Direct push skipped: APNs is not configured");
        }
        result = yield* sendApns({
          credentials: credentials.apns,
          environment: device.apsEnvironment ?? "production",
          deviceToken: device.token,
          topic: device.bundleId,
          payload: message.type === "alert" ? apnsAlertPayload(message) : apnsClearPayload(message),
          pushType: apnsPushType(message),
          nowMs,
        });
      } else {
        if (credentials.fcm === null) {
          return yield* Effect.logWarning("Direct push skipped: FCM is not configured");
        }
        const identity = { deviceId: device.deviceId, userId: device.androidUserId ?? "", nowMs };
        result = yield* sendFcm({
          account: credentials.fcm,
          registrationToken: device.token,
          packageName: device.bundleId,
          data:
            message.type === "alert"
              ? fcmAlertData({ alert: message, ...identity })
              : fcmClearData({ clear: message, ...identity }),
          nowMs,
        });
      }
      // The phone may have re-registered with a new token while this send was in flight.
      if (result === "unregistered" && devices.get(device.deviceId)?.token === device.token) {
        devices.delete(device.deviceId);
        yield* saveDevices;
        yield* Effect.logInfo(
          "Removed direct push device the push service or relay no longer accepts",
          {
            label: device.label,
          },
        );
      }
    }).pipe(
      Effect.provide(httpClientLayer),
      Effect.catchCause((cause) =>
        Effect.logWarning("Direct push delivery failed", { label: device.label, cause }),
      ),
    );

  const sendToDevices = Effect.fn("DirectPush.sendToDevices")(function* (
    kind: DirectPushAlertKind,
    message: PushRelayMessage,
  ) {
    const targets = [...devices.values()].filter(
      (device) => device.notificationsEnabled && deviceWantsAlert(device.alertOn, kind),
    );
    if (targets.length === 0) return;
    // Relay devices need no local keys, so only read them for direct devices.
    const credentials = targets.some((device) => device.relayToken === undefined)
      ? yield* readCredentials
      : ({ apns: null, fcm: null } satisfies PushCredentials);
    yield* Effect.forEach(targets, (device) => sendToDevice(device, message, credentials), {
      concurrency: "unbounded",
      discard: true,
    });
  });

  const notify = (state: AgentAwarenessState, kind: DirectPushAlertKind) =>
    sendToDevices(kind, alertMessage(state, kind));

  const clear = (
    thread: { readonly environmentId: string; readonly threadId: string },
    kind: DirectPushAlertKind,
  ) =>
    sendToDevices(kind, {
      type: "clear",
      environmentId: thread.environmentId,
      threadId: thread.threadId,
    });

  const handleThread = Effect.fn("DirectPush.handleThread")(function* (
    threadId: ThreadId,
    sendScope: Scope.Scope,
  ) {
    const shell = yield* threads.getThreadShell(threadId);
    // Subagents never project activity; their parent thread carries it.
    if (shell?.lineage.relationshipToParent === "subagent") return;
    const project =
      shell === null || shell.archivedAt !== null
        ? Option.none()
        : yield* projects.getById(shell.projectId);
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const state =
      shell !== null && Option.isSome(project)
        ? projectThreadAwarenessV2({ environmentId, project: project.value, thread: shell })
        : null;
    const previousPhase = phases.get(threadId);
    phases.set(threadId, state?.phase ?? null);
    const finishedSinceStart =
      shell?.latestRunCompletedAt != null &&
      DateTime.toEpochMillis(shell.latestRunCompletedAt) > startedAt;
    const nowMs = yield* Clock.currentTimeMillis;
    const kind = alertKind({ state, previousPhase, finishedSinceStart, nowMs });
    const answered = answeredKind(previousPhase, state?.phase ?? null);
    const alert = state !== null && kind !== null ? { state, kind } : null;
    if (answered === null && alert === null) return;
    if (answered !== null) {
      yield* Effect.logInfo("Clearing answered direct push alert", { threadId, kind: answered });
    }
    if (alert !== null) {
      yield* Effect.logInfo("Sending direct push alert", { threadId, kind: alert.kind });
    }
    // Sends run in the background so a slow push service cannot delay, and
    // miss phases of, the events behind this one. The clear goes first so it
    // cannot remove a finished-run alert sent for the same change.
    yield* Effect.gen(function* () {
      if (answered !== null) yield* clear({ environmentId, threadId }, answered);
      if (alert !== null) yield* notify(alert.state, alert.kind);
    }).pipe(Effect.forkIn(sendScope));
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
    const relay = registration.relayToken !== undefined && registration.relayUrl !== undefined;
    const credentials = yield* readCredentials;
    return { ios: relay || credentials.apns !== null, android: relay || credentials.fcm !== null };
  });

  const unregisterDevice = Effect.fn("DirectPush.unregisterDevice")(function* (deviceId: string) {
    if (devices.delete(deviceId)) yield* saveDevices;
  });

  const start = Effect.fn("DirectPush.start")(function* () {
    const sendScope = yield* Effect.scope;
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event: OrchestrationV2DomainEvent) =>
        shouldPublishAgentAwarenessEvent(event)
          ? handleThread(event.threadId, sendScope).pipe(
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

  return DirectPush.of({ registerDevice, unregisterDevice, notify, clear, start });
});

export const layer = Layer.effect(DirectPush, make());
