import { describe, expect, it } from "vite-plus/test";

import { checkDecisionQuote } from "./decisionQuote.ts";

const check = (latestUserMessage: string | null, quote: string, number: number) =>
  checkDecisionQuote({ latestUserMessage, quote, number });

describe("checkDecisionQuote", () => {
  it("accepts the user's own decision for that point", () => {
    expect(check("#3 decline: out of scope", "#3 decline: out of scope", 3)).toBeNull();
    expect(check("#3 decline: out of scope", '"decline: out of scope"', 3)).toBeNull();
    expect(check("Fix   it\nplease", "fix it", 1)).toBeNull();
    // A side chat discusses one point, so its messages need not name it.
    expect(check("decline, it is out of scope", "decline", 4)).toBeNull();
    // A message sent with #2 attached names it in its tag line.
    expect(check("[#2 build cache key]\ndecline it", "decline it", 2)).toBeNull();
  });

  it("never reads a question as a decision", () => {
    expect(check("why #2?", "why #2?", 2)).toBe("quote-is-question");
    expect(check("should we decline #2?", "decline", 2)).toBe("quote-is-question");
  });

  it("refuses words the user did not write, or wrote about another point", () => {
    expect(check(null, "fix", 1)).toBe("no-user-message");
    expect(check("fix it", " ", 1)).toBe("quote-missing");
    expect(check("fix it", "decline", 1)).toBe("quote-not-in-message");
    expect(check("#3 decline: out of scope", "decline: out of scope", 2)).toBe(
      "message-names-other-items",
    );
  });

  it("does not take a point tag's label for the user's words", () => {
    // The label comes from the point, which comes from a reviewer or the agent.
    expect(check("[#2 Fix: pin the version]\nwhat do you think?", "Fix: pin the version", 2)).toBe(
      "quote-not-in-message",
    );
    expect(check("[#2 fix the cache]\nwhat do you think", "fix the cache", 2)).toBe(
      "quote-not-in-message",
    );
    expect(check("[#2 fix the cache]\ndecline it", "decline it", 2)).toBeNull();
    // The tag names #2, so a body about another point is about that point.
    expect(check("[#2 x]\n#3 decline: out of scope", "decline: out of scope", 3)).toBeNull();
    expect(check("[#2 x]\n#3 decline: out of scope", "decline: out of scope", 4)).toBe(
      "message-names-other-items",
    );
    // A label that mentions #3 does not make the message about #3.
    expect(check("[#2 see #3]\ndecline it", "decline it", 3)).toBe("message-names-other-items");
  });

  it("ties the quote to its own point when the message names several", () => {
    const message = "ok fix #2. #3 decline: out of scope";
    expect(check(message, "decline: out of scope", 3)).toBeNull();
    expect(check(message, "#3 decline: out of scope", 3)).toBeNull();
    expect(check(message, "fix #2", 2)).toBeNull();
    expect(check(message, "fix #2", 3)).toBe("message-names-other-items");
    expect(check(message, "fix", 3)).toBe("message-names-other-items");
    expect(check(message, "ok fix", 3)).toBe("message-names-other-items");
    // A sentence naming two points decides neither on its own words.
    expect(check("#2 and #3: decline", "decline", 3)).toBe("message-names-other-items");
    // A sentence naming no point is about the tagged one.
    expect(check("[#2 x]\ndecline it. #3 fix it", "decline it", 2)).toBeNull();
    expect(check("[#2 x]\ndecline it. #3 fix it", "decline it", 3)).toBe(
      "message-names-other-items",
    );
    // The same words can appear twice; the one that names the point counts.
    expect(check("#2 fix. #3 fix", "fix", 3)).toBeNull();
    // One point named, however often: a plain tagged decision still passes.
    expect(check("[#2 build cache key]\nok decline it", "ok decline it", 2)).toBeNull();
    expect(check("ok decline it", "decline it", 2)).toBeNull();
  });
});
