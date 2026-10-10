// Registers the outline/mac keycaps as iOS alternate icons and adds one Android launcher
// activity-alias per design (solid enabled). modules/ctrl-app-icon switches between them.
const fs = require("node:fs");
const path = require("node:path");
const {
  AndroidConfig,
  IOSConfig,
  withAndroidManifest,
  withDangerousMod,
  withXcodeProject,
} = require("expo/config-plugins");

const DESIGNS = ["outline", "solid", "mac"];
const IOS_ALTERNATE_ICON_SETS = { outline: "AppIconOutline", mac: "AppIconMac" };
const aliasSuffix = (design) => `AppIcon${design[0].toUpperCase()}${design.slice(1)}`;
const LAUNCHER = "android.intent.category.LAUNCHER";

function copy(projectRoot, from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.resolve(projectRoot, from), to);
}

function withIosAlternateIcons(config, options) {
  config = withDangerousMod(config, [
    "ios",
    (cfg) => {
      const catalog = path.join(
        cfg.modRequest.platformProjectRoot,
        cfg.modRequest.projectName,
        "Images.xcassets",
      );
      fs.mkdirSync(catalog, { recursive: true });
      const catalogContents = path.join(catalog, "Contents.json");
      if (!fs.existsSync(catalogContents)) {
        fs.writeFileSync(
          catalogContents,
          JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2),
        );
      }
      for (const [design, setName] of Object.entries(IOS_ALTERNATE_ICON_SETS)) {
        const directory = path.join(catalog, `${setName}.appiconset`);
        fs.rmSync(directory, { recursive: true, force: true });
        copy(
          cfg.modRequest.projectRoot,
          options.ios[design],
          path.join(directory, "icon-1024.png"),
        );
        fs.writeFileSync(
          path.join(directory, "Contents.json"),
          JSON.stringify(
            {
              images: [
                {
                  filename: "icon-1024.png",
                  idiom: "universal",
                  platform: "ios",
                  size: "1024x1024",
                },
              ],
              info: { author: "xcode", version: 1 },
            },
            null,
            2,
          ),
        );
      }
      return cfg;
    },
  ]);
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const { target } = IOSConfig.XcodeUtils.getApplicationNativeTarget({
      project,
      projectName: cfg.modRequest.projectName,
    });
    for (const [, buildConfiguration] of IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
      project,
      target.buildConfigurationList,
    )) {
      buildConfiguration.buildSettings.ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = `"${Object.values(IOS_ALTERNATE_ICON_SETS).join(" ")}"`;
      buildConfiguration.buildSettings.ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS = "YES";
    }
    return cfg;
  });
}

function withAndroidLauncherAliases(config, options) {
  config = withDangerousMod(config, [
    "android",
    (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      const res = path.join(cfg.modRequest.platformProjectRoot, "app/src/main/res");
      if (options.android.backgroundImage) {
        copy(
          projectRoot,
          options.android.backgroundImage,
          path.join(res, "drawable-nodpi/ctrl_icon_background.png"),
        );
      } else {
        fs.mkdirSync(path.join(res, "drawable"), { recursive: true });
        fs.writeFileSync(
          path.join(res, "drawable/ctrl_icon_background.xml"),
          `<?xml version="1.0" encoding="utf-8"?>\n<color xmlns:android="http://schemas.android.com/apk/res/android" android:color="${options.android.backgroundColor}"/>\n`,
        );
      }
      for (const design of DESIGNS) {
        const assets = options.android.designs[design];
        copy(
          projectRoot,
          assets.foreground,
          path.join(res, `drawable-nodpi/ctrl_icon_${design}_foreground.png`),
        );
        copy(
          projectRoot,
          assets.monochrome,
          path.join(res, `drawable-nodpi/ctrl_icon_${design}_monochrome.png`),
        );
        // API 24-25 have no adaptive icons; they use the flat iOS render.
        copy(projectRoot, assets.legacy, path.join(res, `mipmap-nodpi/ctrl_icon_${design}.png`));
        fs.mkdirSync(path.join(res, "mipmap-anydpi-v26"), { recursive: true });
        fs.writeFileSync(
          path.join(res, `mipmap-anydpi-v26/ctrl_icon_${design}.xml`),
          [
            '<?xml version="1.0" encoding="utf-8"?>',
            '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">',
            '  <background android:drawable="@drawable/ctrl_icon_background"/>',
            `  <foreground android:drawable="@drawable/ctrl_icon_${design}_foreground"/>`,
            `  <monochrome android:drawable="@drawable/ctrl_icon_${design}_monochrome"/>`,
            "</adaptive-icon>",
            "",
          ].join("\n"),
        );
      }
      return cfg;
    },
  ]);
  return withAndroidManifest(config, (cfg) => {
    const packageName = cfg.android?.package;
    if (!packageName) throw new Error("withCtrlAppIcons requires android.package.");
    const manifest = cfg.modResults;
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
    const filters = mainActivity["intent-filter"] ?? [];
    const isLauncher = (filter) =>
      (filter.category ?? []).some((category) => category.$["android:name"] === LAUNCHER);
    const launcherFilter = filters.find(isLauncher) ?? {
      action: [{ $: { "android:name": "android.intent.action.MAIN" } }],
      category: [{ $: { "android:name": LAUNCHER } }],
    };
    // The aliases own the launcher entry; MainActivity keeps its deep-link filters.
    mainActivity["intent-filter"] = filters.filter((filter) => !isLauncher(filter));
    application["activity-alias"] = [
      ...(application["activity-alias"] ?? []).filter(
        (alias) =>
          !DESIGNS.some(
            (design) => alias.$["android:name"] === `${packageName}.${aliasSuffix(design)}`,
          ),
      ),
      ...DESIGNS.map((design) => ({
        $: {
          "android:name": `${packageName}.${aliasSuffix(design)}`,
          "android:enabled": design === "solid" ? "true" : "false",
          "android:exported": "true",
          "android:icon": `@mipmap/ctrl_icon_${design}`,
          "android:roundIcon": `@mipmap/ctrl_icon_${design}`,
          "android:targetActivity": mainActivity.$["android:name"],
        },
        "intent-filter": [JSON.parse(JSON.stringify(launcherFilter))],
      })),
    ];
    return cfg;
  });
}

module.exports = function withCtrlAppIcons(config, options) {
  return withAndroidLauncherAliases(withIosAlternateIcons(config, options), options);
};
