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
});
