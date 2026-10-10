export const BRAND_ASSET_PATHS = {
  developmentIconComposerProject: "assets/dev/app-icon.icon",
  developmentIosIconPng: "assets/dev/blueprint-ios-1024.png",
  developmentUniversalIconPng: "assets/dev/blueprint-universal-1024.png",

  productionIconComposerProject: "assets/prod/app-icon.icon",
  productionIosIconPng: "assets/prod/black-ios-1024.png",
  productionMacIconPng: "assets/prod/black-macos-1024.png",
  productionLinuxIconPng: "assets/prod/black-universal-1024.png",
  productionWindowsIconIco: "assets/prod/t3-black-windows.ico",
  productionWebFaviconIco: "assets/prod/t3-black-web-favicon.ico",
  productionWebFavicon16Png: "assets/prod/t3-black-web-favicon-16x16.png",
  productionWebFavicon32Png: "assets/prod/t3-black-web-favicon-32x32.png",
  productionWebAppleTouchIconPng: "assets/prod/t3-black-web-apple-touch-180.png",

  nightlyIconComposerProject: "assets/nightly/app-icon.icon",
  nightlyIosIconPng: "assets/nightly/nightly-ios-1024.png",
  nightlyMacIconPng: "assets/nightly/nightly-macos-1024.png",
  nightlyLinuxIconPng: "assets/nightly/nightly-universal-1024.png",
  nightlyWindowsIconIco: "assets/nightly/nightly-windows.ico",
  nightlyWebFaviconIco: "assets/nightly/nightly-web-favicon.ico",
  nightlyWebFavicon16Png: "assets/nightly/nightly-web-favicon-16x16.png",
  nightlyWebFavicon32Png: "assets/nightly/nightly-web-favicon-32x32.png",
  nightlyWebAppleTouchIconPng: "assets/nightly/nightly-web-apple-touch-180.png",

  developmentDesktopIconPng: "assets/dev/blueprint-macos-1024.png",
  developmentWindowsIconIco: "assets/dev/blueprint-windows.ico",
  developmentWebFaviconIco: "assets/dev/blueprint-web-favicon.ico",
  developmentWebFavicon16Png: "assets/dev/blueprint-web-favicon-16x16.png",
  developmentWebFavicon32Png: "assets/dev/blueprint-web-favicon-32x32.png",
  developmentWebAppleTouchIconPng: "assets/dev/blueprint-web-apple-touch-180.png",
} as const;

export const APP_ICON_DESIGNS = ["outline", "solid", "mac"] as const;
export type AppIconDesign = (typeof APP_ICON_DESIGNS)[number];
export type IconBrand = WebAssetBrand;

export interface AppIconDesignAssetPaths {
  readonly iconComposerProject: string;
  readonly iosPng: string;
  readonly macPng: string;
  readonly universalPng: string;
  readonly windowsIco: string;
  /** Only the bundled (solid) design ships a favicon.ico; live swaps use PNG links. */
  readonly webFaviconIco: string | null;
  readonly webFavicon16Png: string;
  readonly webFavicon32Png: string;
  readonly webAppleTouchPng: string;
}

const SOLID_ASSET_PATHS: Record<IconBrand, AppIconDesignAssetPaths> = {
  development: {
    iconComposerProject: BRAND_ASSET_PATHS.developmentIconComposerProject,
    iosPng: BRAND_ASSET_PATHS.developmentIosIconPng,
    macPng: BRAND_ASSET_PATHS.developmentDesktopIconPng,
    universalPng: BRAND_ASSET_PATHS.developmentUniversalIconPng,
    windowsIco: BRAND_ASSET_PATHS.developmentWindowsIconIco,
    webFaviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    webFavicon16Png: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    webFavicon32Png: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    webAppleTouchPng: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
  },
  nightly: {
    iconComposerProject: BRAND_ASSET_PATHS.nightlyIconComposerProject,
    iosPng: BRAND_ASSET_PATHS.nightlyIosIconPng,
    macPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
    universalPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
    windowsIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    webFaviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    webFavicon16Png: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    webFavicon32Png: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    webAppleTouchPng: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
  },
  production: {
    iconComposerProject: BRAND_ASSET_PATHS.productionIconComposerProject,
    iosPng: BRAND_ASSET_PATHS.productionIosIconPng,
    macPng: BRAND_ASSET_PATHS.productionMacIconPng,
    universalPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
    windowsIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    webFaviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    webFavicon16Png: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    webFavicon32Png: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    webAppleTouchPng: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
  },
};

const BRAND_DIRECTORY: Record<IconBrand, string> = {
  development: "assets/dev",
  nightly: "assets/nightly",
  production: "assets/prod",
};
const BRAND_FILE_PREFIX: Record<IconBrand, string> = {
  development: "blueprint",
  nightly: "nightly",
  production: "black",
};

export function resolveAppIconDesignAssetPaths(
  brand: IconBrand,
  design: AppIconDesign,
): AppIconDesignAssetPaths {
  if (design === "solid") return SOLID_ASSET_PATHS[brand];
  const directory = BRAND_DIRECTORY[brand];
  const stem = `${directory}/${BRAND_FILE_PREFIX[brand]}-${design}`;
  return {
    iconComposerProject: `${directory}/app-icon-${design}.icon`,
    iosPng: `${stem}-ios-1024.png`,
    macPng: `${stem}-macos-1024.png`,
    universalPng: `${stem}-ios-1024.png`,
    windowsIco: `${stem}-windows.ico`,
    webFaviconIco: null,
    webFavicon16Png: `${stem}-web-favicon-16x16.png`,
    webFavicon32Png: `${stem}-web-favicon-32x32.png`,
    webAppleTouchPng: `${stem}-web-apple-touch-180.png`,
  };
}

/** Android launcher layers, relative to apps/mobile. Solid keeps Expo's adaptive icon files. */
export function resolveAndroidAppIconAssetPaths(design: AppIconDesign): {
  readonly foreground: string;
  readonly monochrome: string;
} {
  return design === "solid"
    ? {
        foreground: "./assets/android-icon-foreground.png",
        monochrome: "./assets/android-icon-mark.png",
      }
    : {
        foreground: `./assets/android-icon-foreground-${design}.png`,
        monochrome: `./assets/android-icon-mark-${design}.png`,
      };
}

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export function resolveWebAssetBrandForPackageVersion(version: string): WebAssetBrand {
  return /^[^-+]+-(?:nightly|preview)\./.test(version) ? "nightly" : "production";
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  favicon16Png: "favicon-16x16.png",
  favicon32Png: "favicon-32x32.png",
  appleTouchIconPng: "apple-touch-icon.png",
} as const;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: {
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
  },
  nightly: {
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
  },
  production: {
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
  },
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return [
    {
      sourceRelativePath: sourcePaths.faviconIco,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconIco}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon16Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon16Png}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon32Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon32Png}`,
    },
    {
      sourceRelativePath: sourcePaths.appleTouchIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.appleTouchIconPng}`,
    },
    ...APP_ICON_DESIGNS.flatMap((design) => {
      const paths = resolveAppIconDesignAssetPaths(brand, design);
      const target = `${targetDirectory}/app-icons/${design}`;
      return [
        {
          sourceRelativePath: paths.webFavicon16Png,
          targetRelativePath: `${target}/favicon-16x16.png`,
        },
        {
          sourceRelativePath: paths.webFavicon32Png,
          targetRelativePath: `${target}/favicon-32x32.png`,
        },
        {
          sourceRelativePath: paths.webAppleTouchPng,
          targetRelativePath: `${target}/apple-touch-icon.png`,
        },
      ];
    }),
  ];
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const DEVELOPMENT_PUBLIC_ICON_OVERRIDES = resolveWebIconOverrides(
  "development",
  "apps/web/public",
);
