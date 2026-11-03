import { describe, expect, it } from "vite-plus/test";

import { VoiceConversation } from "./voiceConversation";

const idle = {
  phase: "idle" as const,
  speaking: false,
  running: false,
  error: null,
  quietError: (error: string) => error === "No speech was detected.",
};

describe("VoiceConversation", () => {
  it("does nothing until Talk starts it", () => {
    const conversation = new VoiceConversation();
    expect(conversation.sync(idle)).toBeNull();
  });

  it("listens after Talk, and not again while a turn is in flight", () => {
    const conversation = new VoiceConversation();
    conversation.begin();
    expect(conversation.sync(idle)).toBe("listen");
    expect(conversation.sync({ ...idle, phase: "recording" })).toBeNull();
    expect(conversation.sync({ ...idle, phase: "transcribing" })).toBeNull();
  });

  it("keeps the microphone closed after a turn until its reply is read", () => {
    const conversation = new VoiceConversation();
    conversation.begin();
    conversation.turnSent();
    expect(conversation.getSnapshot()).toEqual({ active: true, waiting: true });
    expect(conversation.sync(idle)).toBeNull();
    expect(conversation.sync({ ...idle, running: true })).toBeNull();
    // The reply starts being read: listen through it, so speaking interrupts it.
    expect(conversation.sync({ ...idle, running: true, speaking: true })).toBe("listen");
    expect(conversation.getSnapshot().waiting).toBe(false);
  });

  it("listens again when the thread finishes without anything read aloud", () => {
    const conversation = new VoiceConversation();
    conversation.begin();
    conversation.turnSent();
    // Not running yet: the turn has not reached the agent, so this is no reply.
    expect(conversation.sync(idle)).toBeNull();
    expect(conversation.sync({ ...idle, running: true })).toBeNull();
    expect(conversation.sync(idle)).toBe("listen");
  });

  it("listens again after a turn with no words, but ends on a real failure", () => {
    const conversation = new VoiceConversation();
    conversation.begin();
    expect(
      conversation.sync({ ...idle, phase: "error", error: "No speech was detected." }),
    ).toBeNull();
    expect(conversation.active).toBe(true);
    expect(conversation.sync(idle)).toBe("listen");
    conversation.sync({ ...idle, phase: "error", error: "Microphone access was denied." });
    expect(conversation.active).toBe(false);
    expect(conversation.sync(idle)).toBeNull();
  });

  it("a pause waits for the next reply, and end stops everything", () => {
    const conversation = new VoiceConversation();
    let changes = 0;
    conversation.subscribe(() => changes++);
    conversation.begin();
    conversation.pause();
    expect(conversation.sync(idle)).toBeNull();
    expect(conversation.sync({ ...idle, speaking: true })).toBe("listen");
    conversation.end();
    expect(conversation.getSnapshot()).toEqual({ active: false, waiting: false });
    expect(conversation.sync({ ...idle, speaking: true })).toBeNull();
    expect(changes).toBe(4);
  });
});
