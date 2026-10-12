import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Agent events a phone can choose to be alerted about. */
export const DirectPushAlertKind = Schema.Literals(["input", "approval", "completed", "failed"]);
export type DirectPushAlertKind = typeof DirectPushAlertKind.Type;

/** What a device hears about when it has not chosen: only agents blocked on the user. */
export const DEFAULT_DIRECT_PUSH_ALERT_KINDS: ReadonlyArray<DirectPushAlertKind> = [
  "input",
  "approval",
];

/**
 * A phone asking this environment to push agent alerts to it directly
 * (APNs/FCM sent by the server itself), with no T3 Connect relay involved.
 */
export const DirectPushDeviceRegistration = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  label: Schema.String,
  platform: Schema.Literals(["ios", "android"]),
  /** Raw APNs device token (hex) or FCM registration token. */
  token: TrimmedNonEmptyString,
  /** iOS bundle id or Android package; the APNs topic / FCM restricted package. */
  bundleId: TrimmedNonEmptyString,
  apsEnvironment: Schema.optionalKey(Schema.Literals(["sandbox", "production"])),
  /** Android only: the identity the native FCM handler was configured with. */
  androidUserId: Schema.optionalKey(Schema.String),
  notificationsEnabled: Schema.Boolean,
  /** Omitted by older apps; the server then uses DEFAULT_DIRECT_PUSH_ALERT_KINDS. */
  alertOn: Schema.optionalKey(Schema.Array(DirectPushAlertKind)),
  /** Push relay the phone signed up with; the server sends there instead of using local keys. */
  relayUrl: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^https:\/\//))),
  /** The phone's relay send token. It reaches only this phone. */
  relayToken: Schema.optionalKey(TrimmedNonEmptyString),
});
export type DirectPushDeviceRegistration = typeof DirectPushDeviceRegistration.Type;

/** Which push services this environment has credentials for. */
export const DirectPushStatus = Schema.Struct({
  ios: Schema.Boolean,
  android: Schema.Boolean,
});
export type DirectPushStatus = typeof DirectPushStatus.Type;

export const DirectPushUnregisterInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
});
export type DirectPushUnregisterInput = typeof DirectPushUnregisterInput.Type;

/** An alert the relay turns into a push. Fixed shape: the relay never forwards free-form payloads. */
export const PushAlertMessage = Schema.Struct({
  type: Schema.Literal("alert"),
  kind: DirectPushAlertKind,
  environmentId: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
  threadTitle: Schema.String,
  projectTitle: Schema.String,
  updatedAt: Schema.String,
});
export type PushAlertMessage = typeof PushAlertMessage.Type;

/** Removes a thread's alerts from the phone once its question is answered. */
export const PushClearMessage = Schema.Struct({
  type: Schema.Literal("clear"),
  environmentId: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
});
export type PushClearMessage = typeof PushClearMessage.Type;

export const PushRelayMessage = Schema.Union([PushAlertMessage, PushClearMessage]);
export type PushRelayMessage = typeof PushRelayMessage.Type;

/** Phone → relay sign-up. Send the current send token as a Bearer header to keep it. */
export const PushRelayRegisterRequest = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  platform: Schema.Literals(["ios", "android"]),
  pushToken: TrimmedNonEmptyString,
  bundleId: TrimmedNonEmptyString,
  apsEnvironment: Schema.optionalKey(Schema.Literals(["sandbox", "production"])),
  androidUserId: Schema.optionalKey(Schema.String),
  /** Issue a new send token and kill the old one. */
  reset: Schema.optionalKey(Schema.Boolean),
});
export type PushRelayRegisterRequest = typeof PushRelayRegisterRequest.Type;

export const PushRelayRegisterResponse = Schema.Struct({ sendToken: TrimmedNonEmptyString });
export type PushRelayRegisterResponse = typeof PushRelayRegisterResponse.Type;

/** Computer → relay. */
export const PushRelaySendRequest = Schema.Struct({
  sendToken: TrimmedNonEmptyString,
  message: PushRelayMessage,
});
export type PushRelaySendRequest = typeof PushRelaySendRequest.Type;

export const PushRelaySendResponse = Schema.Struct({
  result: Schema.Literals(["sent", "gone"]),
});
export type PushRelaySendResponse = typeof PushRelaySendResponse.Type;
