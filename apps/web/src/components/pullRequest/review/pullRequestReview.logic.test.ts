import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ranOnLabel, reviewPointMentionCounts } from "./pullRequestReview.logic";

describe("review tab helpers", () => {
  it("counts the user's messages sent about each point", () => {
    const counts = reviewPointMentionCounts([
      { role: "user", text: "[#2 build cache key]\nwhy?" },
      { role: "user", text: "[#2 build cache key]\nok, shorter" },
      { role: "assistant", text: "[#3 pin]\nnot a tag from the user" },
      { role: "user", text: "#3 decline" },
      { role: "user", createdBy: "system", text: "[#2 build cache key]\nrewrite" },
      { role: "user", createdBy: "agent", text: "[#2 build cache key]\nseed" },
    ]);
    expect([...counts]).toEqual([[2, 2]]);
  });

  it("names the model a local review ran on", () => {
    const providers = [
      { instanceId: "claudeAgent", models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5" }] },
    ] as unknown as ReadonlyArray<ServerProvider>;
    expect(
      ranOnLabel({ instanceId: "claudeAgent", model: "claude-opus-5-5" } as never, providers),
    ).toBe("Claude Opus 5.5");
    expect(ranOnLabel({ instanceId: "codex", model: "gpt-6" } as never, providers)).toBe("gpt-6");
    expect(ranOnLabel(null, providers)).toBeNull();
  });
});
