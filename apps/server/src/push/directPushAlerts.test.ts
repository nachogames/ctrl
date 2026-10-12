import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  alertKind,
  answeredKind,
  apnsAlertPayload,
  apnsClearPayload,
  deviceWantsAlert,
  fcmAlertData,
  fcmClearData,
} from "./directPushAlerts.ts";

const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-10T12:00:00.000Z"));
const isoAt = (epochMillis: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMillis));

function state(
  phase: AgentAwarenessState["phase"],
  updatedAt = isoAt(NOW - 5_000),
): AgentAwarenessState {
  return {
    environmentId: "env-1" as EnvironmentId,
    threadId: "thread-1" as ThreadId,
    projectTitle: "Ctrl",
    threadTitle: "Fix the build",
    phase,
    headline: "",
    modelTitle: "Claude",
    updatedAt,
    deepLink: "/threads/env-1/thread-1",
  };
}

const kindFor = (
  phase: AgentAwarenessState["phase"] | null,
  previousPhase: AgentAwarenessState["phase"] | null | undefined,
  options: { finishedSinceStart?: boolean; updatedAt?: string } = {},
) =>
  alertKind({
    state: phase === null ? null : state(phase, options.updatedAt),
    previousPhase,
    finishedSinceStart: options.finishedSinceStart ?? true,
    nowMs: NOW,
  });

describe("alertKind", () => {
  it("names each event a phone can choose to hear about", () => {
    expect(kindFor("waiting_for_input", "running")).toBe("input");
    expect(kindFor("waiting_for_approval", "running")).toBe("approval");
    expect(kindFor("completed", "running")).toBe("completed");
    expect(kindFor("failed", "running")).toBe("failed");
  });

  it("stays quiet for progress, unchanged phases, and missing threads", () => {
    expect(kindFor("running", "starting")).toBeNull();
    expect(kindFor("waiting_for_input", "waiting_for_input")).toBeNull();
    expect(kindFor(null, "running")).toBeNull();
  });

  it("does not replay finished runs from before the server started, or stale ones", () => {
    expect(kindFor("completed", undefined, { finishedSinceStart: false })).toBeNull();
    expect(kindFor("completed", undefined, { finishedSinceStart: true })).toBe("completed");
    expect(kindFor("waiting_for_input", undefined, { finishedSinceStart: false })).toBe("input");
    expect(kindFor("failed", "running", { updatedAt: isoAt(NOW - 5 * 60_000) })).toBeNull();
  });
});

describe("answeredKind", () => {
  it("names the question a thread stopped waiting on", () => {
    expect(answeredKind("waiting_for_input", "running")).toBe("input");
    expect(answeredKind("waiting_for_approval", "running")).toBe("approval");
    expect(answeredKind("waiting_for_approval", "failed")).toBe("approval");
    expect(answeredKind("waiting_for_input", null)).toBe("input");
  });

  it("does not clear for other changes, or when a new question replaces the old one", () => {
    expect(answeredKind("running", "completed")).toBeNull();
    expect(answeredKind(undefined, "running")).toBeNull();
    expect(answeredKind("waiting_for_input", "waiting_for_input")).toBeNull();
    expect(answeredKind("waiting_for_approval", "waiting_for_input")).toBeNull();
  });
});

describe("deviceWantsAlert", () => {
  it("defaults to agents blocked on the user", () => {
    expect(deviceWantsAlert(undefined, "input")).toBe(true);
    expect(deviceWantsAlert(undefined, "approval")).toBe(true);
    expect(deviceWantsAlert(undefined, "completed")).toBe(false);
  });

  it("follows the device's own choice", () => {
    expect(deviceWantsAlert(["completed"], "completed")).toBe(true);
    expect(deviceWantsAlert(["completed"], "input")).toBe(false);
    expect(deviceWantsAlert([], "approval")).toBe(false);
  });
});

describe("payloads", () => {
  it("carries the thread route the app opens on tap", () => {
    const apns = apnsAlertPayload(state("waiting_for_input"));
    expect(apns.aps.alert).toEqual({ title: "Fix the build", body: "Input: Ctrl" });
    expect(apns.deepLink).toBe("/threads/env-1/thread-1");

    const fcm = fcmAlertData({
      state: state("waiting_for_approval"),
      deviceId: "d",
      userId: "u",
      nowMs: NOW,
    });
    expect(fcm).toMatchObject({
      t3_kind: "agent_activity",
      device_id: "d",
      user_id: "u",
      updated_at: String(NOW),
      alert_body: "Approval: Ctrl",
      alert_path: "/threads/env-1/thread-1",
    });
  });

  it("clears by the same thread grouping the alerts use", () => {
    const thread = { environmentId: "env-1", threadId: "thread-1" };
    expect(apnsClearPayload(thread)).toEqual({
      aps: { "content-available": 1 },
      t3_clear_thread: apnsAlertPayload(state("waiting_for_input")).aps["thread-id"],
    });
    const alert = fcmAlertData({
      state: state("waiting_for_input"),
      deviceId: "d",
      userId: "u",
      nowMs: NOW,
    });
    expect(fcmClearData({ thread, deviceId: "d", userId: "u", nowMs: NOW })).toEqual({
      t3_kind: "agent_alert_clear",
      updated_at: String(NOW),
      device_id: "d",
      user_id: "u",
      alert_group: alert.alert_group,
    });
  });
});
