import { describe, expect, it } from "vite-plus/test";

import { handoffNeedsCollapse, parseHandoffSummary } from "./GroupHandoffSection.logic";

const withoutKeys = (summary: string) =>
  parseHandoffSummary(summary).map(({ key: _key, ...block }) => block);

describe("parseHandoffSummary", () => {
  it("labels known headings, keeps next steps as a list, and leaves other text as is", () => {
    expect(
      withoutKeys(
        [
          "Goal: Ship login.",
          "",
          "Current state:",
          "Tests pass.",
          "## Next steps",
          "- Wire the sidebar",
          "2. Add docs",
          "**Don’t touch:** the migrations",
          "Goal is to keep it small.",
          "Must not touch: billing",
        ].join("\n"),
      ),
    ).toEqual([
      { kind: "heading", label: "Goal", warning: false },
      { kind: "text", text: "Ship login." },
      { kind: "heading", label: "Current state", warning: false },
      { kind: "text", text: "Tests pass." },
      { kind: "heading", label: "Next steps", warning: false },
      { kind: "list", items: ["Wire the sidebar", "Add docs"] },
      { kind: "heading", label: "Don't touch", warning: true },
      { kind: "text", text: "the migrations\nGoal is to keep it small." },
      { kind: "heading", label: "Must not touch", warning: true },
      { kind: "text", text: "billing" },
    ]);
  });

  it("keeps a summary without headings as one text block", () => {
    expect(withoutKeys("Done.\n- a bullet stays text")).toEqual([
      { kind: "text", text: "Done.\n- a bullet stays text" },
    ]);
  });

  it("gives every block a distinct key", () => {
    const keys = parseHandoffSummary("Goal: a\nb\nNext steps:\n- c\n- d").map((block) => block.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("handoffNeedsCollapse", () => {
  it("collapses beyond three lines or a long paragraph", () => {
    expect(handoffNeedsCollapse("one\ntwo\nthree")).toBe(false);
    expect(handoffNeedsCollapse("one\ntwo\nthree\nfour")).toBe(true);
    expect(handoffNeedsCollapse("x".repeat(241))).toBe(true);
  });
});
