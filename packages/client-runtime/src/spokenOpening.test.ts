import { describe, expect, it } from "vite-plus/test";

import {
  plainSpokenText,
  SPOKEN_REPLY_MAX_CHARS,
  SPOKEN_REPLY_MAX_SENTENCES,
  spokenOpening,
} from "./spokenOpening.ts";

describe("spokenOpening", () => {
  it("reads every paragraph and list item, not just the first", () => {
    expect(
      spokenOpening("The build finished. Two things need you.\n\n- Review PR 12\n- Answer", false),
    ).toEqual({
      sentences: ["The build finished.", "Two things need you.", "Review PR 12.", "Answer."],
      complete: true,
    });
    expect(spokenOpening("Short answer\n\nDetails here.", false)).toEqual({
      sentences: ["Short answer.", "Details here."],
      complete: true,
    });
  });

  it("skips code blocks and tables but keeps the prose around them", () => {
    expect(spokenOpening("Here it is.\n```ts\nconst x = 1\n```\nThat's the fix.", false)).toEqual({
      sentences: ["Here it is.", "That's the fix."],
      complete: true,
    });
    expect(spokenOpening("| a | b |\n|---|---|\n| 1 | 2 |\nDone.", false).sentences).toEqual([
      "Done.",
    ]);
  });

  it("caps a reply at a dozen sentences and about 1200 characters", () => {
    const many = Array.from({ length: 20 }, (_, index) => `Line ${index}.`).join(" ");
    const capped = spokenOpening(many, false);
    expect(capped.sentences).toHaveLength(SPOKEN_REPLY_MAX_SENTENCES);
    expect(capped.complete).toBe(true);
    const long = `${"word ".repeat(400)}end.`;
    const [only] = spokenOpening(long, false).sentences;
    expect(only!.length).toBeLessThanOrEqual(SPOKEN_REPLY_MAX_CHARS);
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
    expect(spokenOpening("## Status\nAll good.", false).sentences).toEqual([
      "Status.",
      "All good.",
    ]);
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
      complete: false,
    });
    // Later paragraphs keep the message open: they are read too.
    expect(spokenOpening("Hey, the build finished. Two things need you.\n\nFirst", true)).toEqual({
      sentences: ["Hey, the build finished.", "Two things need you."],
      complete: false,
    });
  });

  it("never splits on a link or code span that is still arriving", () => {
    expect(spokenOpening("Opened [Fix it. Now", true).sentences).toEqual([]);
    expect(spokenOpening("Opened [Fix it. Now](t3-thread://v1", true).sentences).toEqual([]);
    expect(spokenOpening("Opened [Fix it. Now](t3-thread://v1/a) for you. ", true)).toEqual({
      sentences: ["Opened Fix it.", "Now for you."],
      complete: false,
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
      "Details follow.",
    ]);
  });
});
