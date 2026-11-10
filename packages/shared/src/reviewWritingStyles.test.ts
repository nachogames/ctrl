import { describe, expect, it } from "vite-plus/test";

import { deleteReviewStyle, saveReviewStyleDraft } from "./reviewWritingStyles.ts";

const setting = {
  selected: "Terse",
  custom: [
    { name: "Terse", instructions: "One line." },
    { name: "Long", instructions: "Explain." },
  ],
};

describe("review writing styles", () => {
  it("adds a new style under a free name and selects it", () => {
    expect(
      saveReviewStyleDraft(setting, { editing: null, name: "Terse", instructions: " Bullets. " }),
    ).toEqual({
      selected: "Terse 2",
      custom: [...setting.custom, { name: "Terse 2", instructions: "Bullets." }],
    });
  });

  it("renames an edited style unless the name is blank or taken, keeping the selection", () => {
    const renamed = saveReviewStyleDraft(setting, {
      editing: "Terse",
      name: "Brief",
      instructions: "One line.",
    });
    expect(renamed.selected).toBe("Brief");
    expect(renamed.custom.map((style) => style.name)).toEqual(["Brief", "Long"]);
    expect(
      saveReviewStyleDraft(setting, { editing: "Long", name: "outcome", instructions: "x" }),
    ).toEqual({
      selected: "Terse",
      custom: [setting.custom[0], { name: "Long", instructions: "x" }],
    });
  });

  it("falls back to the default only when the deleted style was selected", () => {
    expect(deleteReviewStyle(setting, "Terse").selected).toBe("outcome");
    expect(deleteReviewStyle(setting, "Long")).toEqual({
      selected: "Terse",
      custom: [setting.custom[0]],
    });
  });
});
