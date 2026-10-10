import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import { sanitizePreferences } from "./mobile-preferences";

describe("sanitizePreferences appIcon", () => {
  it("keeps a valid design", () => {
    expect(sanitizePreferences({ appIcon: "mac" }).appIcon).toBe("mac");
  });

  it("drops an unknown design without losing other preferences", () => {
    const preferences = sanitizePreferences({
      appIcon: "round" as never,
      codeWordBreak: true,
      followUpBehavior: "steer",
    });
    expect(preferences).not.toHaveProperty("appIcon");
    expect(preferences.codeWordBreak).toBe(true);
    expect(preferences.followUpBehavior).toBe("steer");
  });

  it("leaves older blobs without appIcon untouched", () => {
    expect(sanitizePreferences({ baseFontSize: 17 })).toEqual({ baseFontSize: 17 });
  });
});
