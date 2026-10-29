import type { ExpoConfig } from "expo/config";

import {
  APP_ICON_DESIGNS,
  BRAND_ASSET_PATHS,
  resolveAndroidAppIconAssetPaths,
  resolveAppIconDesignAssetPaths,
} from "../../scripts/lib/brand-assets.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

type AppVariant = "development" | "preview" | "production";

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);

const APP_VARIANT = resolveAppVariant(repoEnv.APP_VARIANT);
const isIosPersonalTeamBuild = repoEnv.T3CODE_IOS_PERSONAL_TEAM === "1";
const runtimeVersionPolicy =
  process.env.MOBILE_VERSION_POLICY ??
  (APP_VARIANT === "development" ? "appVersion" : "fingerprint");

const personalTeamBundleIdentifier = repoEnv.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID?.trim();
const IOS_BUNDLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

// Compiled into the native project. Without a relay, Observe's native side could dispatch to
// Expo's own ingest before observe.ts turns it off; `.invalid` never resolves (RFC 6761).
const observeEndpointUrl = repoEnv.T3CODE_RELAY_URL?.trim()
  ? new URL("/v1/mobile/observe", repoEnv.T3CODE_RELAY_URL.trim()).toString()
  : "https://observe.invalid";

const fromRepoRoot = (relativePath: string) => `../../${relativePath}`;
const androidAdaptiveForeground = "./assets/android-icon-foreground.png";

if (
  isIosPersonalTeamBuild &&
  (!personalTeamBundleIdentifier ||
    !IOS_BUNDLE_IDENTIFIER_PATTERN.test(personalTeamBundleIdentifier))
) {
  throw new Error(
    "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID must be a reverse-DNS identifier such as com.example.t3code when T3CODE_IOS_PERSONAL_TEAM=1.",
  );
}

const DEVELOPMENT_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIosIconPng),
  androidAdaptiveForeground,
  androidAdaptiveBackgroundColor: "#347FF8",
  androidAdaptiveBackgroundImage: "./assets/android-icon-background-dev.png",
  androidSplashIcon: "./assets/android-splash-icon-dev.png",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#00639B",
} as const;

const PREVIEW_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIosIconPng),
  androidAdaptiveForeground,
  androidAdaptiveBackgroundColor: "#111533",
  androidAdaptiveBackgroundImage: "./assets/android-icon-background-nightly.png",
  androidSplashIcon: "./assets/android-splash-icon-nightly.png",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#7565C7",
} as const;

const RELEASE_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIosIconPng),
  androidAdaptiveForeground,
  androidAdaptiveBackgroundColor: "#000000",
  androidAdaptiveBackgroundImage: undefined,
  androidSplashIcon: "./assets/android-splash-icon-prod.png",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#FFFFFF",
} as const;

const VARIANT_CONFIG = {
  development: {
    appName: "Ctrl Dev",
    scheme: "t3code-dev",
    iosBundleIdentifier: "com.nachogames.ctrl.dev",
    androidPackage: "com.nachogames.ctrl.dev",
    relyingParty: "clerk.t3.codes",
    assets: DEVELOPMENT_ASSETS,
  },
  preview: {
    appName: "Ctrl Preview",
    scheme: "t3code-preview",
    iosBundleIdentifier: "com.nachogames.ctrl.preview",
    androidPackage: "com.nachogames.ctrl.preview",
    relyingParty: "clerk.t3.codes",
    assets: PREVIEW_ASSETS,
  },
  production: {
    appName: "Ctrl",
    scheme: "t3code",
    iosBundleIdentifier: "com.nachogames.ctrl",
    androidPackage: "com.nachogames.ctrl",
    relyingParty: "clerk.t3.codes",
    assets: RELEASE_ASSETS,
  },
} as const;

function resolveAppVariant(value: string | undefined): AppVariant {
  switch (value) {
    case "development":
    case "preview":
    case "production":
      return value;
    default:
      return "production";
  }
}

const variant = VARIANT_CONFIG[APP_VARIANT];
const APP_ICON_BRAND = {
  development: "development",
  preview: "nightly",
  production: "production",
} as const;
const appIconBrand = APP_ICON_BRAND[APP_VARIANT];
const appIconPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "./plugins/withCtrlAppIcons.cjs",
  {
    ios: {
      outline: fromRepoRoot(resolveAppIconDesignAssetPaths(appIconBrand, "outline").iosPng),
      mac: fromRepoRoot(resolveAppIconDesignAssetPaths(appIconBrand, "mac").iosPng),
    },
    android: {
      backgroundImage: variant.assets.androidAdaptiveBackgroundImage ?? null,
      backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
      designs: Object.fromEntries(
        APP_ICON_DESIGNS.map((design) => [
          design,
          {
            ...resolveAndroidAppIconAssetPaths(design),
            legacy: fromRepoRoot(resolveAppIconDesignAssetPaths(appIconBrand, design).iosPng),
          },
        ]),
      ),
    },
  },
];
const iosBundleIdentifier = isIosPersonalTeamBuild
  ? personalTeamBundleIdentifier!
  : variant.iosBundleIdentifier;

const dmSansFonts = {
  regular: "@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf",
  medium: "@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf",
  bold: "@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf",
} as const;

const widgetsPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-widgets",
  {
    bundleIdentifier: `${iosBundleIdentifier}.widgets`,
    groupIdentifier: `group.${iosBundleIdentifier}`,
    enablePushNotifications: true,
    // Frequent updates need the iOS entitlement to avoid early throttling.
    frequentUpdates: true,
    enableAndroid: true,
    widgets: [
      {
        name: "SubscriptionUsage",
        displayName: "Subscription usage",
        description: "Subscription quotas from your connected Ctrl environments.",
        ios: {
          configuration: {
            title: "Subscription usage",
            description:
              "Both shows Session and Weekly when available. The Lock Screen shows the tightest selected limit.",
            parameters: {
              codexPeriod: {
                title: "Codex limits",
                type: "enum",
                default: "auto",
                values: [
                  { name: "Both", value: "auto" },
                  { name: "Session", value: "session" },
                  { name: "Weekly", value: "weekly" },
                ],
              },
              claudePeriod: {
                title: "Claude limits",
                type: "enum",
                default: "auto",
                values: [
                  { name: "Both", value: "auto" },
                  { name: "Session", value: "session" },
                  { name: "Weekly", value: "weekly" },
                ],
              },
            },
          },
          supportedFamilies: [
            "systemSmall",
            "systemMedium",
            "systemLarge",
            "systemExtraLarge",
            "accessoryRectangular",
          ],
        },
        android: {
          minWidth: 250,
          minHeight: 180,
          targetCellWidth: 4,
          targetCellHeight: 3,
          resizeMode: "both",
          // The embedded layout renders before first launch; publishing replaces it with stored props.
          initialLayout: "./src/widgets/SubscriptionUsage.android.tsx",
        },
      },
      {
        name: "AgentActivity",
        displayName: "Agent Activity",
        description: "Shows the current state of active Ctrl agents.",
        // Live Activity companion; there is no Android presentation for it.
        android: null,
        ios: { supportedFamilies: ["systemSmall", "systemMedium", "accessoryRectangular"] },
      },
    ],
  },
];

const sharingPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-sharing",
  {
    ios: {
      // Personal Teams cannot sign App Groups or extension targets; keep local builds usable.
      enabled: !isIosPersonalTeamBuild,
      extensionBundleIdentifier: `${iosBundleIdentifier}.sharing`,
      appGroupId: `group.${iosBundleIdentifier}`,
      activationRule: {
        supportsText: true,
        supportsWebUrlWithMaxCount: 1,
        supportsImageWithMaxCount: 8,
        supportsMovieWithMaxCount: 8,
        supportsFileWithMaxCount: 8,
      },
    },
    android: {
      enabled: true,
      singleShareMimeTypes: ["*/*"],
      multipleShareMimeTypes: ["*/*"],
    },
  },
];

// Match iOS PostScript names on Android so RN and the native composer share fonts before runtime loading.

const config: ExpoConfig = {
  name: variant.appName,
  slug: "ctrl",
  platforms: ["ios", "android"],
  scheme: variant.scheme,
  version: repoEnv.T3CODE_MOBILE_VERSION ?? "2.2.0",
  runtimeVersion: {
    // Skip costly fingerprinting on dev launches; preview and production OTAs require matching native projects.
    policy: runtimeVersionPolicy,
  },
  orientation: "portrait",
  icon: variant.assets.appIcon,
  userInterfaceStyle: "automatic",
  updates: {
    enabled: repoEnv.T3CODE_MOBILE_UPDATES_ENABLED !== "0",
    url: "https://u.expo.dev/e3c8dcee-1041-430b-9e57-026bd0ad2384",
    checkAutomatically: "ON_LOAD",
    // Cold starts wait briefly for a waiting update, so the launch that finds
    // one opens on it instead of needing a second launch. The check alone is
    // ~0.2s; on a stalled network the cached bundle starts after this cap.
    fallbackToCacheTimeout: 3000,
    // Ctrl builds its APKs outside EAS Build, so the channel is set here, not by an eas.json profile.
    ...(APP_VARIANT === "production"
      ? { requestHeaders: { "expo-channel-name": "production" } }
      : {}),
  },
  ios: {
    icon: variant.assets.iosIcon,
    supportsTablet: true,
    requireFullScreen: process.env.T3_SHOWCASE_CAPTURE_BUILD === "1",
    bundleIdentifier: iosBundleIdentifier,
    // Pin code signing to a paid team so non-interactive `expo run:ios` does
    // not fall back to a personal team (which cannot sign app groups, Sign in
    // with Apple, or push notification entitlements). Forks set their own.
    appleTeamId: repoEnv.T3CODE_IOS_TEAM_ID?.trim() || "ARK85ZXQ4Z",
    associatedDomains: [
      `applinks:${variant.relyingParty}`,
      `webcredentials:${variant.relyingParty}`,
    ],
    entitlements: {
      "keychain-access-groups": [`$(AppIdentifierPrefix)${variant.iosBundleIdentifier}`],
    },
    infoPlist: {
      UISupportedInterfaceOrientations: [
        "UIInterfaceOrientationPortrait",
        "UIInterfaceOrientationLandscapeLeft",
        "UIInterfaceOrientationLandscapeRight",
      ],
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
      },
      NSLocalNetworkUsageDescription:
        "Allow Ctrl to connect to Ctrl servers on your local network or tailnet.",
      NSPhotoLibraryAddUsageDescription: "Allow Ctrl to save images to your photo library.",
      // "Audio, AirPlay, and Picture in Picture": the browser screen's system
      // picture in picture needs it to start and to stay up outside the app.
      // "remote-notification" lets a silent push from the server remove an
      // alert whose question was answered elsewhere.
      UIBackgroundModes: ["audio", "remote-notification"],
      ITSAppUsesNonExemptEncryption: false,
      // Capture builds disable multitasking because iPadOS otherwise ignores orientation requests.
      ...(process.env.T3_SHOWCASE_CAPTURE_BUILD === "1"
        ? {
            "UISupportedInterfaceOrientations~ipad": [
              "UIInterfaceOrientationPortrait",
              "UIInterfaceOrientationPortraitUpsideDown",
              "UIInterfaceOrientationLandscapeLeft",
              "UIInterfaceOrientationLandscapeRight",
            ],
          }
        : {}),
    },
  },
  android: {
    icon: variant.assets.appIcon,
    package: variant.androidPackage,
    ...(repoEnv.T3CODE_ANDROID_GOOGLE_SERVICES_FILE
      ? { googleServicesFile: repoEnv.T3CODE_ANDROID_GOOGLE_SERVICES_FILE }
      : {}),
    adaptiveIcon: {
      backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
      ...(variant.assets.androidAdaptiveBackgroundImage
        ? { backgroundImage: variant.assets.androidAdaptiveBackgroundImage }
        : {}),
      foregroundImage: variant.assets.androidAdaptiveForeground,
      monochromeImage: variant.assets.androidMonochromeIcon,
    },
    // JS back dispatch needs RN's Android 16 shim and withAndroidPredictiveBackCompat on Android 13-15.
    predictiveBackGestureEnabled: true,
    // expo-sensors declares this for its pedometer, which the app does not use.
    blockedPermissions: ["android.permission.ACTIVITY_RECOGNITION"],
  },
  web: {
    favicon: variant.assets.appIcon,
  },
  plugins: [
    "expo-asset",
    "react-native-pdf-jsi",
    [
      "expo-font",
      {
        ios: {
          fonts: [dmSansFonts.regular, dmSansFonts.medium, dmSansFonts.bold],
        },
        android: {
          fonts: [
            {
              fontFamily: "DMSans-Regular",
              fontDefinitions: [{ path: dmSansFonts.regular, weight: 400 }],
            },
            {
              fontFamily: "DMSans-Medium",
              fontDefinitions: [{ path: dmSansFonts.medium, weight: 500 }],
            },
            {
              fontFamily: "DMSans-Bold",
              fontDefinitions: [{ path: dmSansFonts.bold, weight: 700 }],
            },
          ],
        },
      },
    ],
    "expo-secure-store",
    "expo-sqlite",
    ...(isIosPersonalTeamBuild
      ? [sharingPlugin]
      : ["./plugins/withShareExtensionDisplayName.cjs", sharingPlugin]),
    [
      "expo-notifications",
      {
        icon: variant.assets.androidNotificationIcon,
        color: variant.assets.androidNotificationColor,
        mode: APP_VARIANT === "development" ? "development" : "production",
      },
    ],
    // Gate Clerk here: withoutIosPersonalTeamCapabilities runs too early to strip its entitlement.
    ["@clerk/expo", { theme: "./clerk-theme.json", appleSignIn: !isIosPersonalTeamBuild }],
    "expo-web-browser",
    [
      "expo-quick-actions",
      {
        androidIcons: {
          shortcut_icon: {
            foregroundImage: variant.assets.androidAdaptiveForeground,
            backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
            ...(variant.assets.androidAdaptiveBackgroundImage
              ? { backgroundImage: variant.assets.androidAdaptiveBackgroundImage }
              : {}),
          },
        },
      },
    ],
    [
      "expo-audio",
      {
        microphonePermission: "Allow Ctrl to use your microphone for voice input.",
        recordAudioAndroid: false,
        enableBackgroundPlayback: false,
        enableBackgroundRecording: false,
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission: "Allow Ctrl to access your camera so you can scan pairing QR codes.",
        microphonePermission: false,
        barcodeScannerEnabled: true,
        recordAudioAndroid: false,
      },
    ],
    ["expo-image-picker", { photosPermission: false, microphonePermission: false }],
    [
      "expo-splash-screen",
      {
        image: variant.assets.splashIcon,
        resizeMode: "contain",
        backgroundColor: "#ffffff",
        imageWidth: 220,
        dark: {
          image: variant.assets.splashIcon,
          backgroundColor: "#0a0a0a",
        },
        android: {
          // Android 12+ masks the central two thirds of the 288dp canvas; adaptive layers avoid clipped corners.
          image: variant.assets.androidSplashIcon,
          imageWidth: 288,
          dark: { image: variant.assets.androidSplashIcon },
        },
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          minSdkVersion: 24,
          // SDK 58 lacks Kotlin 2.3's runtime-inert annotation. R8 needs explicit InputMerger constructors for widgets.
          extraProguardRules: [
            "-dontwarn kotlin.MustUseReturnValues",
            "-keep class * extends androidx.work.InputMerger { <init>(); }",
          ].join("\n"),
        },
        ios: {
          deploymentTarget: "18.0",
          // AppCheckCore 11.3+ includes Swift and needs module maps for these Objective-C dependencies.
          extraPods: [
            { name: "GoogleUtilities", modular_headers: true },
            { name: "RecaptchaInterop", modular_headers: true },
          ],
        },
      },
    ],
    "./plugins/withIosCocoaPodsUuidCache.cjs",
    // Compile out the unused pedometer to avoid an iOS motion purpose string.
    ["expo-sensors", { motionPermission: false }],
    // Mods run in reverse order; expo-widgets must create and wipe the target before assets are added.
    ...(!isIosPersonalTeamBuild ? ["./plugins/withWidgetLogoAsset.cjs", widgetsPlugin] : []),
    "./plugins/withAndroidNetworkSecurityConfig.cjs",
    "./plugins/withAndroidGradleHeap.cjs",
    "./plugins/withAndroidInputBackground.cjs",
    "./plugins/withAndroidModernPopupMenu.cjs",
    "./plugins/withAndroidModernAlertDialog.cjs",
    "./plugins/withAndroidPredictiveBackCompat.cjs",
    "./plugins/withAndroidTabletOrientation.cjs",
    appIconPlugin,
    ...(isIosPersonalTeamBuild ? ["./plugins/withoutIosPersonalTeamCapabilities.cjs"] : []),
  ],
  extra: {
    appVariant: APP_VARIANT,
    iosPersonalTeamBuild: isIosPersonalTeamBuild,
    // Ctrl's push relay (apps/push-relay). Public: a send token, not this URL, is the permission.
    pushRelayUrl: repoEnv.CTRL_PUSH_RELAY_URL ?? "https://ctrl-push-relay.mceachinm.workers.dev",
    relay: {
      url: repoEnv.T3CODE_RELAY_URL ?? null,
    },
    clerk: {
      publishableKey: repoEnv.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null,
      jwtTemplate: repoEnv.EXPO_PUBLIC_CLERK_JWT_TEMPLATE ?? null,
    },
    // Clerk reads these exact names at prebuild. Omit unset values: manifest null becomes truthy {}.
    EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME,
    observability: {
      tracesUrl: repoEnv.EXPO_PUBLIC_OTLP_TRACES_URL ?? "https://api.axiom.co/v1/traces",
      tracesDataset: repoEnv.EXPO_PUBLIC_OTLP_TRACES_DATASET ?? null,
      tracesToken: repoEnv.EXPO_PUBLIC_OTLP_TRACES_TOKEN ?? null,
    },
    eas: {
      // Ctrl: the fork's own Expo project (OTA updates), not upstream's.
      projectId: "e3c8dcee-1041-430b-9e57-026bd0ad2384",
      observe: { endpointUrl: observeEndpointUrl },
    },
  },
  owner: "mceachinm",
  experiments: {
    // Metro only runs babel-plugin-react-compiler when this is set; see src/reactCompilerCoverage.test.ts.
    reactCompiler: true,
  },
};

export default config;
