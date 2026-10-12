import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  DirectPushDeviceRegistration,
  PushRelayMessage,
  PushRelaySendRequest,
} from "./directPush.ts";

const decodeRegistration = Schema.decodeUnknownOption(DirectPushDeviceRegistration);
const decodeMessage = Schema.decodeUnknownOption(PushRelayMessage);

const base = {
  deviceId: "d",
  label: "Pixel",
  platform: "android",
  token: "t",
  bundleId: "com.nachogames.ctrl",
  notificationsEnabled: true,
};

describe("DirectPushDeviceRegistration", () => {
  it("accepts an https relay with a token", () => {
    const decoded = decodeRegistration({
      ...base,
      relayUrl: "https://push.example.workers.dev",
      relayToken: "abc",
    });
    expect(decoded._tag).toBe("Some");
  });

  it("rejects a non-https relay", () => {
    expect(
      decodeRegistration({ ...base, relayUrl: "http://evil.test", relayToken: "abc" })._tag,
    ).toBe("None");
  });

  it("still accepts registrations without a relay", () => {
    expect(decodeRegistration(base)._tag).toBe("Some");
  });
});

describe("PushRelayMessage", () => {
  it("accepts alerts and clears", () => {
    expect(
      decodeMessage({
        type: "alert",
        kind: "input",
        environmentId: "env",
        threadId: "thread",
        threadTitle: "Fix the build",
        projectTitle: "Ctrl",
        updatedAt: "2026-10-12T00:00:00.000Z",
      })._tag,
    ).toBe("Some");
    expect(decodeMessage({ type: "clear", environmentId: "env", threadId: "thread" })._tag).toBe(
      "Some",
    );
  });

  it("rejects free-form payloads", () => {
    expect(decodeMessage({ type: "alert", aps: { alert: "hi" } })._tag).toBe("None");
    expect(decodeMessage({ type: "custom", body: "hi" })._tag).toBe("None");
  });

  it("requires a token to send", () => {
    const decode = Schema.decodeUnknownOption(PushRelaySendRequest);
    expect(decode({ message: { type: "clear", environmentId: "e", threadId: "t" } })._tag).toBe(
      "None",
    );
  });
});
