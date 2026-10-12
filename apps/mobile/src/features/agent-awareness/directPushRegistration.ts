import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { request } from "@t3tools/client-runtime/rpc";
import {
  DEFAULT_DIRECT_PUSH_ALERT_KINDS,
  type EnvironmentId,
  PushRelayTokens,
  WS_METHODS,
} from "@t3tools/contracts";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AppState, Platform } from "react-native";

import * as MobilePreferences from "../../persistence/mobile-preferences";
import * as MobileSecureStorage from "../../persistence/mobile-secure-storage";
import * as MobileStorage from "../../persistence/mobile-storage";
import { configureAndroidAgentNotifications } from "./androidNotifications";
import { supportsAgentAwarenessPush } from "./capabilities";
import { registerWithPushRelay } from "./pushRelayClient";
import { resolveApsEnvironment } from "./registrationPayload";
import {
  getAgentAwarenessRelayIdentity,
  onAgentAwarenessRelayIdentityChange,
} from "./relayIdentity";

/**
 * Registers this phone's native push token with every connected environment
 * so the server can push agent alerts itself (`push.registerDevice`), for
 * setups that reach their servers directly instead of through T3 Connect.
 */

// The Android FCM handler drops pushes whose user id does not match the one it
// was configured with. Direct pushes reuse the Connect identity when signed in
// so both paths can deliver.
const DIRECT_ANDROID_USER_ID = "direct";
const UNREGISTERED = "unregistered";

export type DirectPushEnvironmentStatus = "registered" | "no-credentials" | "unavailable";

let statuses: ReadonlyMap<EnvironmentId, DirectPushEnvironmentStatus> = new Map();
const statusListeners = new Set<() => void>();
let requestRegistration: () => void = () => {};

function setStatus(environmentId: EnvironmentId, status: DirectPushEnvironmentStatus | null) {
  const next = new Map(statuses);
  if (status === null) next.delete(environmentId);
  else next.set(environmentId, status);
  statuses = next;
  for (const listener of statusListeners) listener();
}

export function subscribeDirectPushStatuses(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function getDirectPushStatuses(): ReadonlyMap<EnvironmentId, DirectPushEnvironmentStatus> {
  return statuses;
}

const PUSH_RELAY_TOKENS_KEY = "ctrl.push-relay.tokens";
const PushRelayTokensJson = Schema.fromJsonString(PushRelayTokens);
const decodeStoredRelayTokens = Schema.decodeUnknownOption(PushRelayTokensJson);
const encodeRelayTokens = Schema.encodeSync(PushRelayTokensJson);

/** Ctrl's push relay (apps/push-relay), from the app config. */
function pushRelayUrl(): string | null {
  const url = Constants.expoConfig?.extra?.pushRelayUrl;
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

let resetRequested = false;

/** Swaps this phone's relay send token for a new one, cutting off computers it is no longer connected to. */
export function resetDirectPushRelay(): void {
  resetRequested = true;
  requestRegistration();
}

/** Re-runs registration now, e.g. after the user flips the setting. */
export function requestDirectPushRegistration(): void {
  requestRegistration();
}

const readPushToken = Effect.gen(function* () {
  if ((Platform.OS !== "ios" && Platform.OS !== "android") || !supportsAgentAwarenessPush()) {
    return null;
  }
  const permissions = yield* Effect.promise(() => Notifications.getPermissionsAsync());
  if (!permissions.granted) return null;
  const token = yield* Effect.promise(() => Notifications.getDevicePushTokenAsync());
  return token.type === Platform.OS && typeof token.data === "string" && token.data.trim()
    ? token.data.trim()
    : null;
}).pipe(Effect.orElseSucceed(() => null));

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const storage = yield* MobileStorage.MobileStorage;
    const secureStorage = yield* MobileSecureStorage.MobileSecureStorage;
    const preferencesStore = yield* MobilePreferences.MobilePreferencesStore;
    const requests = yield* Queue.sliding<void>(1);
    requestRegistration = () => Queue.offerUnsafe(requests, undefined);
    // What each environment last accepted (a token signature, or UNREGISTERED),
    // so reconnects do not re-send.
    const accepted = new Map<EnvironmentId, string>();

    const sync = Effect.gen(function* () {
      const preferences: MobilePreferences.Preferences = yield* preferencesStore.load.pipe(
        Effect.orElseSucceed(() => ({})),
      );
      // Never turned on: nothing to register or take back.
      if (preferences.directPushEnabled === undefined) return;
      const enabled = preferences.directPushEnabled;
      const deviceId = yield* storage.loadOrCreateAgentAwarenessDeviceId;
      const token = enabled ? yield* readPushToken : null;
      const androidUserId = getAgentAwarenessRelayIdentity() ?? DIRECT_ANDROID_USER_ID;
      if (token !== null && Platform.OS === "android" && !getAgentAwarenessRelayIdentity()) {
        configureAndroidAgentNotifications(deviceId, androidUserId, false);
      }
      const bundleId =
        (Platform.OS === "android"
          ? Constants.expoConfig?.android?.package
          : Constants.expoConfig?.ios?.bundleIdentifier
        )?.trim() ?? "";
      const relayUrl = pushRelayUrl();
      let relayToken: string | null = null;
      if (token !== null && bundleId && relayUrl !== null) {
        const stored = yield* secureStorage
          .getItem(PUSH_RELAY_TOKENS_KEY)
          .pipe(Effect.orElseSucceed(() => null));
        const current = stored === null ? null : Option.getOrNull(decodeStoredRelayTokens(stored));
        const reset = resetRequested;
        resetRequested = false;
        const registered = yield* Effect.promise(() =>
          registerWithPushRelay({
            relayUrl,
            current,
            reset,
            request: {
              deviceId,
              platform: Platform.OS === "android" ? "android" : "ios",
              pushToken: token,
              bundleId,
              ...(Platform.OS === "ios"
                ? {
                    apsEnvironment: resolveApsEnvironment(Constants.expoConfig?.extra?.appVariant),
                  }
                : { androidUserId }),
            },
          }),
        );
        // An unreachable or busy relay must not switch computers off the relay:
        // keep using the saved tokens, and retry a reset on the next sync.
        if (registered === null && reset) resetRequested = true;
        relayToken = (registered ?? current)?.sendToken ?? null;
        if (registered !== null && registered.sendToken !== current?.sendToken) {
          yield* secureStorage
            .setItem(PUSH_RELAY_TOKENS_KEY, encodeRelayTokens(registered))
            .pipe(Effect.ignore);
        }
      }
      const entries = yield* SubscriptionRef.get(registry.entries);
      yield* Effect.forEach(
        entries.keys(),
        (environmentId) => {
          if (token === null || !bundleId) {
            setStatus(environmentId, enabled ? "unavailable" : null);
            if (accepted.get(environmentId) === UNREGISTERED) return Effect.void;
            // Turning the setting off is the way back out: the server forgets
            // this device. Sent once per session since earlier sessions may
            // have registered it.
            return registry
              .run(environmentId, request(WS_METHODS.pushUnregisterDevice, { deviceId }))
              .pipe(
                Effect.tap(() => Effect.sync(() => accepted.set(environmentId, UNREGISTERED))),
                Effect.ignore,
              );
          }
          const alertOn = preferences.directPushAlertOn ?? DEFAULT_DIRECT_PUSH_ALERT_KINDS;
          const signature = `${token}|${androidUserId}|${alertOn.join(",")}|${relayToken ?? ""}`;
          if (accepted.get(environmentId) === signature) return Effect.void;
          return registry
            .run(
              environmentId,
              request(WS_METHODS.pushRegisterDevice, {
                deviceId,
                label:
                  Constants.deviceName?.trim() ||
                  (Platform.OS === "android" ? "Android device" : "iPhone"),
                platform: Platform.OS === "android" ? "android" : "ios",
                // With the relay, computers get only the send token, so Reset alerts
                // can cut one off; the raw push token would let it sign up again.
                ...(relayUrl !== null && relayToken !== null
                  ? { relayUrl, relayToken }
                  : { token }),
                bundleId,
                ...(Platform.OS === "ios"
                  ? {
                      apsEnvironment: resolveApsEnvironment(
                        Constants.expoConfig?.extra?.appVariant,
                      ),
                    }
                  : { androidUserId }),
                notificationsEnabled: true,
                alertOn,
              }),
            )
            .pipe(
              Effect.tap((status) =>
                Effect.sync(() => {
                  accepted.set(environmentId, signature);
                  const ready = Platform.OS === "android" ? status.android : status.ios;
                  setStatus(environmentId, ready ? "registered" : "no-credentials");
                }),
              ),
              Effect.catchCause(() =>
                Effect.sync(() => {
                  accepted.delete(environmentId);
                  setStatus(environmentId, "unavailable");
                }),
              ),
            );
        },
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(Effect.ignore, Effect.withSpan("mobile.directPush.sync"));

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        // Re-send on every foreground: the server may have dropped this device
        // (a stale token, a restored devices.json) without telling the phone,
        // and an unchanged registration costs the server nothing.
        const appState = AppState.addEventListener("change", (state) => {
          if (state !== "active") return;
          accepted.clear();
          requestRegistration();
        });
        const tokenListener = Notifications.addPushTokenListener(() => {
          accepted.clear();
          requestRegistration();
        });
        // Connect sign-in changes reset the Android FCM handler; re-apply ours
        // and re-register with the identity the handler now expects.
        const removeIdentityListener = onAgentAwarenessRelayIdentityChange(() => {
          accepted.clear();
          requestRegistration();
        });
        return { appState, tokenListener, removeIdentityListener };
      }),
      ({ appState, tokenListener, removeIdentityListener }) =>
        Effect.sync(() => {
          appState.remove();
          tokenListener.remove();
          removeIdentityListener();
          requestRegistration = () => {};
        }),
    );
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.runForEach(() => Effect.sync(requestRegistration)),
      Effect.forkScoped,
    );
    yield* Stream.fromQueue(requests).pipe(
      Stream.debounce("500 millis"),
      Stream.runForEach(() => sync),
      Effect.forkScoped,
    );
  }),
);
