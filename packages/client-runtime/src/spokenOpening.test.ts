import { describe, expect, it } from "vite-plus/test";

import { plainSpokenText, spokenOpening } from "./spokenOpening.ts";

describe("spokenOpening", () => {
  it("speaks the opening paragraph and stops at the first break", () => {
    expect(
      spokenOpening("The build finished. Two things need you.\n\n- Review PR 12\n- Answer", false),
    ).toEqual({ sentences: ["The build finished.", "Two things need you."], complete: true });
    expect(spokenOpening("All green.\n- one\n- two", false)).toEqual({
      sentences: ["All green."],
      complete: true,
    });
    expect(spokenOpening("Short answer\n\nDetails here.", false)).toEqual({
      sentences: ["Short answer"],
      complete: true,
    });
  });

  it("caps the opening at two sentences and about 300 characters", () => {
    expect(spokenOpening("One. Two. Three.", false).sentences).toEqual(["One.", "Two."]);
    const long = `${"word ".repeat(80)}end.`;
    const [only] = spokenOpening(long, false).sentences;
    expect(only!.length).toBeLessThanOrEqual(300);
    expect(only!.endsWith("word")).toBe(true);
    const second = `First is short. ${"x".repeat(300)}.`;
    expect(spokenOpening(second, false)).toEqual({
      sentences: ["First is short."],
      complete: true,
    });
  });

  it("strips markdown, links and code", () => {
    expect(
      plainSpokenText(
        "**Done.** See [Fix the build](t3-thread://v1/abc) and https://x.dev/y, run `vp test` ![img](a.png)",
      ),
    ).toBe("Done. See Fix the build and run vp test");
    expect(plainSpokenText("Use `a really long piece of code that goes on and on()` now")).toBe(
      "Use now",
    );
    expect(spokenOpening("```ts\nconst x = 1\n```\nThat's the fix.", false)).toEqual({
      sentences: [],
      complete: true,
    });
    expect(spokenOpening("## Status\nAll good.", false).sentences).toEqual([]);
  });

  it("releases sentences while streaming only once they are complete", () => {
    expect(spokenOpening("Hey, the build", true)).toEqual({ sentences: [], complete: false });
    expect(spokenOpening("Hey, the build finished.", true)).toEqual({
      sentences: [],
      complete: false,
    });
    expect(spokenOpening("Hey, the build finished. Two", true)).toEqual({
      sentences: ["Hey, the build finished."],
      complete: false,
    });
    expect(spokenOpening("Hey, the build finished. Two things need you.\n", true)).toEqual({
      sentences: ["Hey, the build finished.", "Two things need you."],
      complete: true,
    });
    expect(spokenOpening("Hey, the build finished. Two things need you.\n\nFirst", true)).toEqual({
      sentences: ["Hey, the build finished.", "Two things need you."],
      complete: true,
    });
  });

  it("never splits on a link or code span that is still arriving", () => {
    expect(spokenOpening("Opened [Fix it. Now", true).sentences).toEqual([]);
    expect(spokenOpening("Opened [Fix it. Now](t3-thread://v1", true).sentences).toEqual([]);
    expect(spokenOpening("Opened [Fix it. Now](t3-thread://v1/a) for you. ", true)).toEqual({
      sentences: ["Opened Fix it.", "Now for you."],
      complete: true,
    });
    expect(spokenOpening("Ran `a. b", true).sentences).toEqual([]);
  });

  it("keeps abbreviations and decimals inside a sentence", () => {
    expect(
      spokenOpening("Use a fast model, e.g. Haiku. Costs 0.5 cents.", false).sentences,
    ).toEqual(["Use a fast model, e.g. Haiku.", "Costs 0.5 cents."]);
  });

  it("each streamed result extends the previous one", () => {
    const message =
      "Got it. I'm handing the redesign to a deeper agent and will report back.\n\nDetails follow.";
    let previous: ReadonlyArray<string> = [];
    for (let end = 1; end <= message.length; end++) {
      const { sentences } = spokenOpening(message.slice(0, end), end < message.length);
      expect(sentences.slice(0, previous.length)).toEqual(previous);
      previous = sentences;
    }
    expect(previous).toEqual([
      "Got it.",
      "I'm handing the redesign to a deeper agent and will report back.",
    ]);
  });
});
