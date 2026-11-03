import { describe, expect, it, vi } from "vite-plus/test";

import { createDictationLevel } from "../dictation/dictationLevel";
import { localVoice } from "./localVoice";

const target = { environmentId: "env", threadId: "thread" };

describe("localVoice", () => {
  it("shows the composer's conversation and hands mute and stop back to it", () => {
    const stop = vi.fn();
    const setMuted = vi.fn();
    const changes = vi.fn();
    const unsubscribe = localVoice.subscribe(changes);
    localVoice.attach(target, { stop, setMuted }, createDictationLevel());
    expect(localVoice.getState()).toMatchObject({ phase: "connecting", target });

    const captions = [{ role: "user" as const, text: "what's running", final: false }];
    localVoice.update({ phase: "active", muted: false, captions });
    const seen = changes.mock.calls.length;
    // The composer rebuilds equal captions on every render; they are not news.
    localVoice.update({ phase: "active", muted: false, captions: [...captions] });
    expect(changes.mock.calls.length).toBe(seen);

    localVoice.toggleMuted();
    expect(setMuted).toHaveBeenCalledWith(true);
    localVoice.stop();
    expect(stop).toHaveBeenCalledOnce();

    localVoice.detach();
    expect(localVoice.getState().phase).toBe("idle");
    // A conversation that ended takes no more updates.
    localVoice.update({ phase: "active", muted: false, captions });
    expect(localVoice.getState().phase).toBe("idle");
    unsubscribe();
  });

  it("reports the microphone level, and silence while muted", () => {
    const microphone = createDictationLevel();
    const levels = vi.fn();
    localVoice.attach(target, { stop: vi.fn(), setMuted: vi.fn() }, microphone);
    localVoice.update({ phase: "active", muted: false, captions: [] });
    const unsubscribe = localVoice.subscribeLevels(levels);
    microphone.set(0.5);
    expect(levels).toHaveBeenLastCalledWith({ microphone: 0.5, speaker: 0 });
    localVoice.update({ phase: "active", muted: true, captions: [] });
    microphone.set(0.6);
    expect(levels).toHaveBeenLastCalledWith({ microphone: 0, speaker: 0 });
    unsubscribe();
    localVoice.detach();
  });
});
