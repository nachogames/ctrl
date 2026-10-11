import { describe, expect, it } from "vite-plus/test";

import { groupChatCountLabel, shouldShowGroupChips } from "./ChatHeaderGroup.logic";

describe("shouldShowGroupChips", () => {
  const base = {
    availableWidth: 600,
    breadcrumbWidth: 300,
    chipsWidth: 200,
    groupPanelVisible: false,
  };

  it("shows the chips when the breadcrumb and chips both fit", () => {
    expect(shouldShowGroupChips(base)).toBe(true);
    expect(shouldShowGroupChips({ ...base, chipsWidth: 300 })).toBe(true);
  });

  it("hides the chips before the title would have to truncate", () => {
    expect(shouldShowGroupChips({ ...base, chipsWidth: 300.5 })).toBe(false);
    expect(shouldShowGroupChips({ ...base, breadcrumbWidth: 700 })).toBe(false);
  });

  it("hides the chips while the Group surface is visible", () => {
    expect(shouldShowGroupChips({ ...base, groupPanelVisible: true })).toBe(false);
  });
});

describe("groupChatCountLabel", () => {
  it("pluralizes", () => {
    expect(groupChatCountLabel(1)).toBe("1 chat");
    expect(groupChatCountLabel(3)).toBe("3 chats");
  });
});
