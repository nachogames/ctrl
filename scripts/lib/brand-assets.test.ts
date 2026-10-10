import { describe, expect, it } from "vite-plus/test";

import {
  BRAND_ASSET_PATHS,
  DEVELOPMENT_ICON_OVERRIDES,
  DEVELOPMENT_PUBLIC_ICON_OVERRIDES,
  resolveAndroidAppIconAssetPaths,
  resolveAppIconDesignAssetPaths,
  resolveWebAssetBrandForChannel,
  resolveWebAssetBrandForPackageVersion,
  resolveWebIconOverrides,
} from "./brand-assets.ts";

describe("brand-assets", () => {
  it("maps production web assets into the server package", () => {
    expect(resolveWebIconOverrides("production", "dist/client").slice(0, 4)).toEqual([
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFaviconIco,
        targetRelativePath: "dist/client/favicon.ico",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon16Png,
        targetRelativePath: "dist/client/favicon-16x16.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon32Png,
        targetRelativePath: "dist/client/favicon-32x32.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
        targetRelativePath: "dist/client/apple-touch-icon.png",
      },
    ]);
  });

  it("maps server build web assets to development icons", () => {
    expect(DEVELOPMENT_ICON_OVERRIDES[0]).toEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFaviconIco,
      targetRelativePath: "dist/client/favicon.ico",
    });
  });

  it("maps development web assets to the public splash and favicon files", () => {
    expect(DEVELOPMENT_PUBLIC_ICON_OVERRIDES.slice(0, 4)).toEqual([
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFaviconIco,
        targetRelativePath: "apps/web/public/favicon.ico",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
        targetRelativePath: "apps/web/public/favicon-16x16.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
        targetRelativePath: "apps/web/public/favicon-32x32.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
        targetRelativePath: "apps/web/public/apple-touch-icon.png",
      },
    ]);
  });

  it("can target hosted web dist directly", () => {
    expect(resolveWebIconOverrides("production", "apps/web/dist")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
      targetRelativePath: "apps/web/dist/apple-touch-icon.png",
    });
  });

  it("maps hosted nightly web assets to nightly icons", () => {
    expect(resolveWebIconOverrides("nightly", "apps/web/dist")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
      targetRelativePath: "apps/web/dist/favicon.ico",
    });
  });

  it("maps hosted release channels to web asset brands", () => {
    expect(resolveWebAssetBrandForChannel("latest")).toBe("production");
    expect(resolveWebAssetBrandForChannel("nightly")).toBe("nightly");
  });

  it("maps package versions to web asset brands", () => {
    expect(resolveWebAssetBrandForPackageVersion("0.0.29")).toBe("production");
    expect(resolveWebAssetBrandForPackageVersion("0.0.29-nightly.20260723.882")).toBe("nightly");
    expect(resolveWebAssetBrandForPackageVersion("0.0.29-preview.20260723.882")).toBe("nightly");
  });

  it("keeps development, nightly, and production icon families separate", () => {
    expect([
      BRAND_ASSET_PATHS.developmentIconComposerProject,
      BRAND_ASSET_PATHS.nightlyIconComposerProject,
      BRAND_ASSET_PATHS.productionIconComposerProject,
    ]).toEqual([
      "assets/dev/app-icon.icon",
      "assets/nightly/app-icon.icon",
      "assets/prod/app-icon.icon",
    ]);
    expect(BRAND_ASSET_PATHS.developmentDesktopIconPng).toMatch(/^assets\/dev\/blueprint-/);
    expect(BRAND_ASSET_PATHS.nightlyMacIconPng).toMatch(/^assets\/nightly\/nightly-/);
    expect(BRAND_ASSET_PATHS.productionMacIconPng).toMatch(/^assets\/prod\/black-/);
  });

  it("keeps solid on the bundled file names", () => {
    expect(resolveAppIconDesignAssetPaths("production", "solid")).toEqual({
      iconComposerProject: BRAND_ASSET_PATHS.productionIconComposerProject,
      iosPng: BRAND_ASSET_PATHS.productionIosIconPng,
      macPng: BRAND_ASSET_PATHS.productionMacIconPng,
      universalPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
      webFaviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
      webFavicon16Png: BRAND_ASSET_PATHS.productionWebFavicon16Png,
      webFavicon32Png: BRAND_ASSET_PATHS.productionWebFavicon32Png,
      webAppleTouchPng: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
    });
  });

  it("names runtime-only designs per channel", () => {
    expect(resolveAppIconDesignAssetPaths("development", "outline")).toEqual({
      iconComposerProject: "assets/dev/app-icon-outline.icon",
      iosPng: "assets/dev/blueprint-outline-ios-1024.png",
      macPng: "assets/dev/blueprint-outline-macos-1024.png",
      universalPng: "assets/dev/blueprint-outline-ios-1024.png",
      windowsIco: "assets/dev/blueprint-outline-windows.ico",
      webFaviconIco: null,
      webFavicon16Png: "assets/dev/blueprint-outline-web-favicon-16x16.png",
      webFavicon32Png: "assets/dev/blueprint-outline-web-favicon-32x32.png",
      webAppleTouchPng: "assets/dev/blueprint-outline-web-apple-touch-180.png",
    });
    expect(resolveAppIconDesignAssetPaths("nightly", "mac").macPng).toBe(
      "assets/nightly/nightly-mac-macos-1024.png",
    );
  });

  it("maps every design into app-icons/ for live favicon swaps", () => {
    const overrides = resolveWebIconOverrides("nightly", "apps/web/dist");
    expect(overrides).toHaveLength(4 + 3 * 3);
    expect(overrides).toContainEqual({
      sourceRelativePath: "assets/nightly/nightly-mac-web-favicon-32x32.png",
      targetRelativePath: "apps/web/dist/app-icons/mac/favicon-32x32.png",
    });
    expect(overrides).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
      targetRelativePath: "apps/web/dist/app-icons/solid/apple-touch-icon.png",
    });
  });

  it("keeps solid on the Expo adaptive icon files for Android", () => {
    expect(resolveAndroidAppIconAssetPaths("solid")).toEqual({
      foreground: "./assets/android-icon-foreground.png",
      monochrome: "./assets/android-icon-mark.png",
    });
    expect(resolveAndroidAppIconAssetPaths("mac")).toEqual({
      foreground: "./assets/android-icon-foreground-mac.png",
      monochrome: "./assets/android-icon-mark-mac.png",
    });
  });
});
