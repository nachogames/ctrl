import { describe, expect, it } from "vite-plus/test";

import { isAppIcon, resolveAppIconPreference } from "./appIconPreference";
import { resolveBrandMarkVariant } from "./mobileBranding";

describe("app icon preference", () => {
  it.each(["outline", "solid", "mac"])("accepts %s", (value) => {
    expect(isAppIcon(value)).toBe(true);
    expect(resolveAppIconPreference(value)).toBe(value);
  });

  it.each([undefined, null, "round", 3])("falls back to solid for %s", (value) => {
    expect(resolveAppIconPreference(value)).toBe("solid");
  });

  it("maps Expo app variants to brand-mark artwork", () => {
    expect(resolveBrandMarkVariant("development")).toBe("development");
    expect(resolveBrandMarkVariant("preview")).toBe("preview");
    expect(resolveBrandMarkVariant(undefined)).toBe("production");
  });
});
