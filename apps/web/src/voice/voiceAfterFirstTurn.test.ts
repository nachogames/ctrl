import { describe, expect, it } from "vite-plus/test";

import {
  clearVoiceAfterFirstTurn,
  startVoiceAfterFirstTurn,
  voiceAfterFirstTurnStatus,
} from "./voiceAfterFirstTurn";

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
