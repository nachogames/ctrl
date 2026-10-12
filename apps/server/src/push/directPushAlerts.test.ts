import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  alertKind,
  alertMessage,
  answeredKind,
  deviceWantsAlert,
  otherAlertStillWaiting,
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

describe("alertMessage", () => {
  it("carries only the fixed alert fields", () => {
    expect(alertMessage(state("waiting_for_input"), "input")).toEqual({
      type: "alert",
      kind: "input",
      environmentId: "env-1",
      threadId: "thread-1",
      threadTitle: "Fix the build",
      projectTitle: "Ctrl",
      updatedAt: isoAt(NOW - 5_000),
    });
  });
});

describe("otherAlertStillWaiting", () => {
  const tracked = [
    ["child-a", { alertThreadId: "parent", phase: null }],
    ["child-b", { alertThreadId: "parent", phase: "waiting_for_input" }],
    ["other", { alertThreadId: "other", phase: "waiting_for_approval" }],
  ] as const;

  it("keeps the alert while a sibling still waits with the same kind", () => {
    expect(
      otherAlertStillWaiting({
        threadId: "child-a",
        alertThreadId: "parent",
        kind: "input",
        tracked,
      }),
    ).toBe(true);
  });

  it("clears when nothing else on that thread waits with that kind", () => {
    expect(
      otherAlertStillWaiting({
        threadId: "child-a",
        alertThreadId: "parent",
        kind: "approval",
        tracked,
      }),
    ).toBe(false);
    expect(
      otherAlertStillWaiting({
        threadId: "child-b",
        alertThreadId: "parent",
        kind: "input",
        tracked,
      }),
    ).toBe(false);
  });
});
