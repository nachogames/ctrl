/**
 * Builds the APNs and FCM payloads for agent alerts and clears. Shared by the
 * server's direct push and the push relay so both emit identical pushes, which
 * the app's native handlers already understand.
 */
import type {
  DirectPushAlertKind,
  PushAlertMessage,
  PushClearMessage,
  PushRelayMessage,
} from "@t3tools/contracts";
import { hashTelemetryId } from "./telemetryId.ts";

const STATUS: Record<DirectPushAlertKind, string> = {
  approval: "Approval",
  input: "Input",
  completed: "Done",
  failed: "Failed",
};

/** The thread route the app opens on tap. Always derived, never caller-supplied. */
export function threadDeepLink(environmentId: string, threadId: string): string {
  return `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

function alertText(alert: PushAlertMessage) {
  return {
    title: alert.threadTitle.slice(0, 120),
    body: `${STATUS[alert.kind]}: ${alert.projectTitle}`.slice(0, 240),
  };
}

const threadGroup = (message: PushRelayMessage) =>
  JSON.stringify([message.environmentId, message.threadId]);

export function apnsAlertPayload(alert: PushAlertMessage) {
  return {
    aps: {
      alert: alertText(alert),
      sound: "default",
      "thread-id": `${alert.environmentId}/${alert.threadId}`,
    },
    environmentId: alert.environmentId,
    threadId: alert.threadId,
    deepLink: threadDeepLink(alert.environmentId, alert.threadId),
  };
}

// Builds from the 20261125 upstream sync match `user_hash`; older ones only `user_id`.
function androidRecipientData(userId: string, deviceId: string) {
  return {
    device_id: deviceId,
    user_id: userId,
    user_hash: hashTelemetryId(`${userId}:${deviceId}`),
  };
}

/** Data message handled natively by the app's AgentMessagingService. */
export function fcmAlertData(input: {
  readonly alert: PushAlertMessage;
  readonly deviceId: string;
  readonly userId: string;
  readonly nowMs: number;
}): Record<string, string> {
  const { alert } = input;
  const text = alertText(alert);
  return {
    t3_kind: "agent_activity",
    updated_at: String(input.nowMs),
    ...androidRecipientData(input.userId, input.deviceId),
    alert_id: JSON.stringify([alert.environmentId, alert.threadId, alert.kind, alert.updatedAt]),
    alert_group: threadGroup(alert),
    alert_title: text.title,
    alert_body: text.body,
    alert_path: threadDeepLink(alert.environmentId, alert.threadId),
    active: "false",
  };
}

/** Silent push the app handles natively by removing the thread's alerts. */
export function apnsClearPayload(clear: PushClearMessage) {
  return {
    aps: { "content-available": 1 },
    t3_clear_thread: `${clear.environmentId}/${clear.threadId}`,
  };
}

export function fcmClearData(input: {
  readonly clear: PushClearMessage;
  readonly deviceId: string;
  readonly userId: string;
  readonly nowMs: number;
}): Record<string, string> {
  return {
    t3_kind: "agent_alert_clear",
    updated_at: String(input.nowMs),
    ...androidRecipientData(input.userId, input.deviceId),
    alert_group: threadGroup(input.clear),
  };
}

/** Clears wake the app silently; Apple requires the background push type for them. */
export function apnsPushType(message: PushRelayMessage): "alert" | "background" {
  return message.type === "alert" ? "alert" : "background";
}
