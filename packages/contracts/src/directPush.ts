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
