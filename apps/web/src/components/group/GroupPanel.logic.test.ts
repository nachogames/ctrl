import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupChatSubtitle, groupStatusPill, splitInlineCode } from "./GroupPanel.logic";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const current = ThreadId.make("current");
const source = ThreadId.make("source");

function thread(overrides: Partial<Parameters<typeof groupChatSubtitle>[0]["thread"]> = {}) {
  return {
    id: ThreadId.make("member"),
    handedOffFrom: null,
    handedOffTo: null,
    createdAt: "2026-10-09T12:00:00.000Z",
    latestUserMessageAt: "2026-10-10T09:00:00.000Z",
    unsettledAt: null,
    ...overrides,
  };
}

function subtitle(
  overrides: Partial<Parameters<typeof groupChatSubtitle>[0]["thread"]> = {},
  status: Parameters<typeof groupChatSubtitle>[0]["status"] = "ready",
) {
  return groupChatSubtitle({
    thread: thread(overrides),
    currentThreadId: current,
    threadsById: new Map([[source, { title: "Rework session tokens" }]]),
    status,
    now: NOW,
  });
}

describe("groupChatSubtitle", () => {
  it("marks the open chat", () => {
    expect(subtitle({ id: current, handedOffTo: source })).toBe("this chat");
  });

  it("marks a chat that handed off, with its age", () => {
    expect(subtitle({ handedOffTo: current })).toBe("handed off · 3h");
  });

  it("names the chat a member was started from", () => {
    expect(subtitle({ handedOffFrom: source })).toBe("started from Rework session tokens");
    expect(subtitle({ handedOffFrom: current })).toBe("started from this chat");
  });

  it("falls back to idle time when the source chat is unknown", () => {
    expect(subtitle({ handedOffFrom: ThreadId.make("gone") })).toBe("idle 3h");
  });

  it("does not call a busy chat idle", () => {
    expect(subtitle({}, "working")).toBe("3h ago");
  });

  it("reads activity from the last user message, not the creation time", () => {
    expect(subtitle({ latestUserMessageAt: null })).toBe("idle 1d");
    expect(subtitle({ latestUserMessageAt: "2026-10-10T11:59:59.000Z" })).toBe("idle");
  });
});

describe("groupStatusPill", () => {
  it("labels statuses that need attention or are in motion", () => {
    expect(groupStatusPill("working")?.label).toBe("Working");
    expect(groupStatusPill("approval")?.label).toBe("Approval");
    expect(groupStatusPill("failed")?.label).toBe("Failed");
  });

  it("shows nothing for a chat at rest or an empty group", () => {
    expect(groupStatusPill("ready")).toBeNull();
    expect(groupStatusPill(null)).toBeNull();
  });
});

describe("splitInlineCode", () => {
  it("splits code spans out of the text", () => {
    expect(splitInlineCode("Next: revoke in `tokenStore.ts`, then tests.")).toEqual([
      { text: "Next: revoke in ", code: false, start: 0 },
      { text: "tokenStore.ts", code: true, start: 16 },
      { text: ", then tests.", code: false, start: 31 },
    ]);
  });

  it("keeps unmatched backticks and line breaks literal", () => {
    expect(splitInlineCode("a `b\nc` d")).toEqual([{ text: "a `b\nc` d", code: false, start: 0 }]);
  });
});
