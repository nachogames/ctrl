import { APP_ICONS, DEFAULT_CLIENT_SETTINGS, type AppIcon } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

type RuntimeDesign = Exclude<AppIcon, "solid">;
type RuntimeExt = "ico" | "png";

/** Packaged builds stage runtime designs here (scripts/build-desktop-artifact.ts). */
export function resolvePackagedAppIconResource(design: RuntimeDesign, ext: RuntimeExt): string {
  return `app-icons/${design}/icon.${ext}`;
}

/** Unpackaged runs read the exports in assets/<brand>/ (scripts/lib/brand-assets.ts naming). */
export function resolveSourceTreeAppIconFile(
  brand: "dev" | "prod",
  design: RuntimeDesign,
  ext: RuntimeExt,
  platform: NodeJS.Platform,
): string {
  const stem = `${brand === "dev" ? "blueprint" : "black"}-${design}`;
  if (ext === "ico") return `${stem}-windows.ico`;
  return platform === "darwin" ? `${stem}-macos-1024.png` : `${stem}-ios-1024.png`;
}

export interface AppIconActions {
  readonly dockIcon: Option.Option<string>;
  readonly windowIcon: Option.Option<string>;
}

export function resolveAppIconActions(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly design: AppIcon;
  /** Whether this session already replaced the dock tile. */
  readonly dockCustomized: boolean;
  readonly iconPaths: DesktopAssets.DesktopIconPaths;
}): AppIconActions {
  if (input.platform === "darwin") {
    // A packaged bundle shows the solid key from Info.plist (or a custom icon the user
    // attached). Only touch the dock for another design, or to restore after one.
    const keepBundleIcon = input.isPackaged && input.design === "solid" && !input.dockCustomized;
    return {
      dockIcon: keepBundleIcon ? Option.none() : input.iconPaths.png,
      windowIcon: Option.none(),
    };
  }
  return {
    dockIcon: Option.none(),
    windowIcon: input.platform === "win32" ? input.iconPaths.ico : input.iconPaths.png,
  };
}

export class DesktopAppIcon extends Context.Service<
  DesktopAppIcon,
  {
    /** Icon paths for the current design, for new windows. */
    readonly iconPaths: Effect.Effect<DesktopAssets.DesktopIconPaths>;
    readonly apply: (design: AppIcon) => Effect.Effect<void>;
    /** Applies the persisted client setting; run once at bootstrap. */
    readonly initialize: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopAppIcon") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const fileSystem = yield* FileSystem.FileSystem;
  const bundled = yield* assets.iconPaths;

  const resolveRuntimePath = (
    design: RuntimeDesign,
    ext: RuntimeExt,
  ): Effect.Effect<Option.Option<string>> => {
    if (environment.isPackaged) {
      return assets
        .resolveResourcePath(resolvePackagedAppIconResource(design, ext))
        .pipe(Effect.orElseSucceed(() => Option.none<string>()));
    }
    const brand = environment.isDevelopment ? "dev" : "prod";
    const file = environment.path.join(
      environment.rootDir,
      "assets",
      brand,
      resolveSourceTreeAppIconFile(brand, design, ext, environment.platform),
    );
    return fileSystem.exists(file).pipe(
      Effect.orElseSucceed(() => false),
      Effect.map((exists) => (exists ? Option.some(file) : Option.none<string>())),
    );
  };

  const pathsFor = Effect.fn("desktop.appIcon.pathsFor")(function* (design: AppIcon) {
    if (design === "solid") return bundled;
    const [ico, png] = yield* Effect.all([
      resolveRuntimePath(design, "ico"),
      resolveRuntimePath(design, "png"),
    ]);
    return {
      ico: Option.orElse(ico, () => bundled.ico),
      icns: bundled.icns,
      png: Option.orElse(png, () => bundled.png),
    } satisfies DesktopAssets.DesktopIconPaths;
  });

  const pathsByDesign = new Map<AppIcon, DesktopAssets.DesktopIconPaths>();
  for (const design of APP_ICONS) pathsByDesign.set(design, yield* pathsFor(design));
  const current = yield* Ref.make<AppIcon>(DEFAULT_CLIENT_SETTINGS.appIcon);
  const dockCustomized = yield* Ref.make(false);

  const apply = Effect.fn("desktop.appIcon.apply")(function* (design: AppIcon) {
    yield* Ref.set(current, design);
    const actions = resolveAppIconActions({
      platform: environment.platform,
      isPackaged: environment.isPackaged,
      design,
      dockCustomized: yield* Ref.get(dockCustomized),
      iconPaths: pathsByDesign.get(design)!,
    });
    if (Option.isSome(actions.dockIcon)) {
      yield* electronApp.setDockIcon(actions.dockIcon.value);
      yield* Ref.set(dockCustomized, true);
    }
    if (Option.isSome(actions.windowIcon)) {
      const icon = actions.windowIcon.value;
      yield* electronWindow.syncAllAppearance((window) => Effect.sync(() => window.setIcon(icon)));
    }
  });

  const initialize = clientSettings.get.pipe(
    Effect.map(
      Option.match({
        onNone: () => DEFAULT_CLIENT_SETTINGS.appIcon,
        onSome: (settings) => settings.appIcon,
      }),
    ),
    Effect.orElseSucceed(() => DEFAULT_CLIENT_SETTINGS.appIcon),
    Effect.flatMap(apply),
    Effect.withSpan("desktop.appIcon.initialize"),
  );

  return DesktopAppIcon.of({
    iconPaths: Ref.get(current).pipe(Effect.map((design) => pathsByDesign.get(design)!)),
    apply,
    initialize,
  });
});

export const layer = Layer.effect(DesktopAppIcon, make);
