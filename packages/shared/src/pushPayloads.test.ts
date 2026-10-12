import type { PushAlertMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  apnsAlertPayload,
  apnsClearPayload,
  apnsPushType,
  fcmAlertData,
  fcmClearData,
  threadDeepLink,
} from "./pushPayloads.ts";

const alert: PushAlertMessage = {
  type: "alert",
  kind: "approval",
  environmentId: "env-1",
  threadId: "thread-1",
  threadTitle: "Fix the build",
  projectTitle: "Ctrl",
  updatedAt: "2026-10-12T00:00:00.000Z",
};
const clear = { type: "clear", environmentId: "env-1", threadId: "thread-1" } as const;

describe("pushPayloads", () => {
  it("derives the deep link from ids, encoding them", () => {
    expect(threadDeepLink("env 1", "t/1")).toBe("/threads/env%201/t%2F1");
  });

  it("builds the APNs alert the app routes on", () => {
    expect(apnsAlertPayload(alert)).toEqual({
      aps: {
        alert: { title: "Fix the build", body: "Approval: Ctrl" },
        sound: "default",
        "thread-id": "env-1/thread-1",
      },
      environmentId: "env-1",
      threadId: "thread-1",
      deepLink: "/threads/env-1/thread-1",
    });
  });

  it("caps long titles", () => {
    const long = apnsAlertPayload({ ...alert, threadTitle: "x".repeat(500) });
    expect(long.aps.alert.title).toHaveLength(120);
  });

  it("builds the FCM data the Android handler checks", () => {
    expect(fcmAlertData({ alert, deviceId: "d", userId: "u", nowMs: 5 })).toEqual({
      t3_kind: "agent_activity",
      updated_at: "5",
      device_id: "d",
      user_id: "u",
      alert_id: JSON.stringify(["env-1", "thread-1", "approval", "2026-10-12T00:00:00.000Z"]),
      alert_group: JSON.stringify(["env-1", "thread-1"]),
      alert_title: "Fix the build",
      alert_body: "Approval: Ctrl",
      alert_path: "/threads/env-1/thread-1",
      active: "false",
    });
  });

  it("clears by the same thread grouping the alerts use", () => {
    expect(apnsClearPayload(clear)).toEqual({
      aps: { "content-available": 1 },
      t3_clear_thread: apnsAlertPayload(alert).aps["thread-id"],
    });
    expect(fcmClearData({ clear, deviceId: "d", userId: "u", nowMs: 5 })).toEqual({
      t3_kind: "agent_alert_clear",
      updated_at: "5",
      device_id: "d",
      user_id: "u",
      alert_group: fcmAlertData({ alert, deviceId: "d", userId: "u", nowMs: 5 }).alert_group,
    });
  });

  it("sends clears to APNs as background pushes", () => {
    expect(apnsPushType(alert)).toBe("alert");
    expect(apnsPushType(clear)).toBe("background");
  });
});
