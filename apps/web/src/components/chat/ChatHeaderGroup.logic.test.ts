import { describe, expect, it } from "vite-plus/test";

import {
  breadcrumbNaturalWidth,
  groupChatCountLabel,
  shouldShowGroupChips,
} from "./ChatHeaderGroup.logic";

describe("breadcrumbNaturalWidth", () => {
  const project = { boxWidth: 90, labelBoxWidth: null, labelTextWidth: 300, ellipsisWidth: 0 };

  it("counts a stretched title at its text width, not the row it fills", () => {
    // The title item fills the header (600px) while its text is 120px wide.
    const title = { boxWidth: 600, labelBoxWidth: 580, labelTextWidth: 120, ellipsisWidth: 0 };
    expect(breadcrumbNaturalWidth([project, title], 12)).toBe(90 + 12 + 140);
  });

  it("counts a truncated or collapsed label at its full text", () => {
    const truncated = { boxWidth: 80, labelBoxWidth: 80, labelTextWidth: 200, ellipsisWidth: 0 };
    const collapsed = { boxWidth: 12, labelBoxWidth: 0, labelTextWidth: 150, ellipsisWidth: 12 };
    expect(breadcrumbNaturalWidth([truncated, collapsed], 0)).toBe(200 + 150);
  });

  it("ignores the overflow of width-capped labels", () => {
    expect(breadcrumbNaturalWidth([project], 12)).toBe(90);
  });
});

describe("shouldShowGroupChips", () => {
  const base = {
    headerWidth: 600,
    breadcrumbWidth: 300,
    chipsWidth: 200,
    groupPanelVisible: false,
  };

  it("shows the chips when the breadcrumb and chips both fit", () => {
    expect(shouldShowGroupChips(base)).toBe(true);
    expect(shouldShowGroupChips({ ...base, chipsWidth: 300 })).toBe(true);
  });

  it("shows the chips beside a short title that is stretched across a wide header", () => {
    const project = { boxWidth: 90, labelBoxWidth: null, labelTextWidth: 90, ellipsisWidth: 0 };
    const title = { boxWidth: 898, labelBoxWidth: 878, labelTextWidth: 160, ellipsisWidth: 0 };
    const breadcrumbWidth = breadcrumbNaturalWidth([project, title], 12);
    expect(
      shouldShowGroupChips({ ...base, headerWidth: 1000, breadcrumbWidth, chipsWidth: 212 }),
    ).toBe(true);
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
