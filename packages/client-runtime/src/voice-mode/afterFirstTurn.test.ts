import { describe, expect, it } from "vite-plus/test";

import {
  clearVoiceAfterFirstTurn,
  onVoiceSessionMissing,
  recoverMissingVoiceSession,
  startVoiceAfterFirstTurn,
  voiceAfterFirstTurnStatus,
} from "./afterFirstTurn.ts";

const target = { environmentId: "env", threadId: "thread" };

describe("voiceAfterFirstTurnStatus", () => {
  it("waits until the first turn has run and ended", () => {
    expect(voiceAfterFirstTurnStatus(target, "ready")).toBe("none");
    startVoiceAfterFirstTurn(target);
    // Before the turn starts the thread already looks ready; its session does not exist yet.
    expect(voiceAfterFirstTurnStatus(target, "ready")).toBe("waiting");
    expect(voiceAfterFirstTurnStatus(target, "running")).toBe("waiting");
    expect(voiceAfterFirstTurnStatus(target, "ready")).toBe("ready");
    clearVoiceAfterFirstTurn(target);
    expect(voiceAfterFirstTurnStatus(target, "ready")).toBe("none");
  });
});

describe("recoverMissingVoiceSession", () => {
  const missing = "The provider session is no longer running. Send a message first.";

  it("hands only a missing session to the thread's recovery, while it is registered", () => {
    let recoveries = 0;
    const unregister = onVoiceSessionMissing(target, () => {
      recoveries += 1;
      return recoveries === 1;
    });
    expect(recoverMissingVoiceSession({ target, error: "Microphone denied" })).toBe(false);
    expect(
      recoverMissingVoiceSession({ target: { ...target, threadId: "other" }, error: missing }),
    ).toBe(false);
    expect(recoverMissingVoiceSession({ target, error: missing })).toBe(true);
    // A recovery that declines, such as a second try, leaves the failure to be reported.
    expect(recoverMissingVoiceSession({ target, error: missing })).toBe(false);
    unregister();
    expect(recoverMissingVoiceSession({ target, error: missing })).toBe(false);
    expect(recoveries).toBe(2);
  });
});
