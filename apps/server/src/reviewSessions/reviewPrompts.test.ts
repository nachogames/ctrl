import { describe, expect, it } from "vite-plus/test";

import {
  localReviewPrompt,
  reviewRequestText,
  sideChatPrompt,
  sideChatTitle,
} from "./reviewPrompts.ts";
import { itemFixture, localSourceFixture, sessionFixture } from "./testkit.ts";

const session = sessionFixture({ round: 2 });
const item = itemFixture(3, {
  sources: ["copilot", "local-review"],
  path: "apps/server/src/auth.ts",
  line: 40,
  summary: "Token refresh retries forever",
  shortName: "refresh loop",
  recommendation: "Cheap and safe to fix.",
  suggestedDecision: "fix",
  draftReply: "Fixed: one retry, then 401.",
});

describe("sideChatPrompt", () => {
  it("carries only the one point, where it is, and the decision rules", () => {
    const prompt = sideChatPrompt(session, item);
    expect(prompt).toContain(
      "point #3 of the review of https://github.com/nachogames/ctrl/pull/23 (round 2)",
    );
    expect(prompt).toContain("Where: apps/server/src/auth.ts:40");
    expect(prompt).toContain("Raised by: copilot, local-review");
    expect(prompt).toContain("Claude's call: fix. Cheap and safe to fix.");
    expect(prompt).toContain("Reply draft: Fixed: one retry, then 401.");
    expect(prompt).toContain("A question is never a decision.");
  });

  it("keeps the title short", () => {
    expect(sideChatTitle(item)).toBe("#3 · refresh loop");
  });
});

describe("localReviewPrompt", () => {
  it("runs /code-review on Claude and a plain review elsewhere, independent of Copilot", () => {
    const claude = localReviewPrompt({ session, driverKind: "claudeAgent" });
    expect(claude).toContain("/code-review");
    expect(claude).toContain("review_source_submit");
    expect(claude).toContain("Do not read the pull request's review comments");
    const codex = localReviewPrompt({ session, driverKind: "codex" });
    expect(codex).not.toContain("/code-review");
    expect(codex).toContain("Review this branch");
  });
});

describe("reviewRequestText", () => {
  it("names the round and the reviews to triage", () => {
    expect(
      reviewRequestText({
        session,
        request: { _tag: "triage" },
        item: null,
        sources: [
          localSourceFixture("PRR_1", {
            kind: "copilot",
            round: 2,
            author: "copilot-pull-request-reviewer",
          }),
          localSourceFixture("local:run-2", { round: 2 }),
          localSourceFixture("PRR_dan", { kind: "human", round: 2, author: "dan" }),
        ],
      }),
    ).toContain(
      "Triage round 2 of the review of https://github.com/nachogames/ctrl/pull/23: Copilot, your review, @dan.",
    );
  });

  it("tags a rewrite with its point", () => {
    expect(
      reviewRequestText({
        session,
        request: { _tag: "rewrite-reply", number: 3, style: "mention-commit" },
        item,
        sources: [],
      }),
    ).toMatch(/^\[#3 refresh loop\]\nRewrite the reply draft on #3: mention the commit/);
  });
});
