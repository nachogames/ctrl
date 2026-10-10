import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { APP_ICONS, DEFAULT_CLIENT_SETTINGS, type AppIcon } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopAppIcon from "./DesktopAppIcon.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const baseInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/Applications/Ctrl.app/Contents/Resources/app.asar",
  isPackaged: true,
  resourcesPath: "/Applications/Ctrl.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

interface Calls {
  readonly dock: string[];
  readonly window: string[];
}

function harness(input: {
  readonly calls: Calls;
  readonly environment?: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput>;
  readonly stored?: AppIcon;
  readonly packagedResources?: ReadonlySet<string>;
  readonly sourceTreeFiles?: ReadonlySet<string>;
}) {
  const resources =
    input.packagedResources ??
    new Set([
      "app-icons/outline/icon.png",
      "app-icons/outline/icon.ico",
      "app-icons/mac/icon.png",
      "app-icons/mac/icon.ico",
    ]);
  const fakeWindow = {
    setIcon: (path: string) => input.calls.window.push(path),
  } as unknown as Electron.BrowserWindow;
  return Layer.mergeAll(
    DesktopAppIcon.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(DesktopAssets.DesktopAssets, {
            iconPaths: Effect.succeed({
              ico: Option.some("/res/icon.ico"),
              icns: Option.none(),
              png: Option.some("/res/icon.png"),
            }),
            resolveResourcePath: (fileName) =>
              Effect.succeed(
                resources.has(fileName) ? Option.some(`/res/${fileName}`) : Option.none(),
              ),
          } satisfies DesktopAssets.DesktopAssets["Service"]),
          Layer.mock(ElectronApp.ElectronApp)({
            setDockIcon: (path) => Effect.sync(() => void input.calls.dock.push(path)),
          }),
          Layer.mock(ElectronWindow.ElectronWindow)({
            syncAllAppearance: (sync) => sync(fakeWindow),
          }),
          DesktopClientSettings.layerTest(
            input.stored === undefined
              ? Option.none()
              : Option.some({ ...DEFAULT_CLIENT_SETTINGS, appIcon: input.stored }),
          ),
          FileSystem.layerNoop({
            exists: (path) => Effect.succeed(input.sourceTreeFiles?.has(path) ?? false),
          }),
          DesktopEnvironment.layer({ ...baseInput, ...input.environment }).pipe(
            Layer.provide(
              Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest({})),
            ),
          ),
        ),
      ),
    ),
  );
}

const emptyCalls = (): Calls => ({ dock: [], window: [] });

describe("resolveAppIconActions", () => {
  const paths = {
    ico: Option.some("/i.ico"),
    icns: Option.none<string>(),
    png: Option.some("/i.png"),
  };

  it("leaves a packaged macOS bundle icon alone for the default design", () => {
    const actions = DesktopAppIcon.resolveAppIconActions({
      platform: "darwin",
      isPackaged: true,
      design: "solid",
      dockCustomized: false,
      iconPaths: paths,
    });
    assert.isTrue(Option.isNone(actions.dockIcon));
    assert.isTrue(Option.isNone(actions.windowIcon));
  });

  it("restores the packaged dock icon after switching back to solid", () => {
    const actions = DesktopAppIcon.resolveAppIconActions({
      platform: "darwin",
      isPackaged: true,
      design: "solid",
      dockCustomized: true,
      iconPaths: paths,
    });
    assert.deepEqual(actions.dockIcon, Option.some("/i.png"));
  });

  it("uses ico windows icons on Windows and png on Linux", () => {
    const base = {
      isPackaged: true,
      design: "mac",
      dockCustomized: false,
      iconPaths: paths,
    } as const;
    assert.deepEqual(
      DesktopAppIcon.resolveAppIconActions({ ...base, platform: "win32" }).windowIcon,
      Option.some("/i.ico"),
    );
    assert.deepEqual(
      DesktopAppIcon.resolveAppIconActions({ ...base, platform: "linux" }).windowIcon,
      Option.some("/i.png"),
    );
  });
});

describe("DesktopAppIcon", () => {
  it.effect.each(APP_ICONS)(
    "applies the stored %s design to the macOS dock at startup",
    (design) => {
      const calls = emptyCalls();
      return Effect.gen(function* () {
        const appIcon = yield* DesktopAppIcon.DesktopAppIcon;
        yield* appIcon.initialize;
        assert.deepEqual(
          calls.dock,
          design === "solid" ? [] : [`/res/app-icons/${design}/icon.png`],
        );
      }).pipe(Effect.provide(harness({ calls, stored: design })));
    },
  );

  it.effect("switches away from solid and back within one session", () => {
    const calls = emptyCalls();
    return Effect.gen(function* () {
      const appIcon = yield* DesktopAppIcon.DesktopAppIcon;
      yield* appIcon.initialize;
      yield* appIcon.apply("outline");
      yield* appIcon.apply("solid");
      assert.deepEqual(calls.dock, ["/res/app-icons/outline/icon.png", "/res/icon.png"]);
      assert.deepEqual(yield* appIcon.iconPaths, {
        ico: Option.some("/res/icon.ico"),
        icns: Option.none(),
        png: Option.some("/res/icon.png"),
      });
    }).pipe(Effect.provide(harness({ calls })));
  });

  it.effect("sets every window icon on Windows", () => {
    const calls = emptyCalls();
    return Effect.gen(function* () {
      yield* (yield* DesktopAppIcon.DesktopAppIcon).apply("mac");
      assert.deepEqual(calls.window, ["/res/app-icons/mac/icon.ico"]);
      assert.deepEqual(calls.dock, []);
    }).pipe(
      Effect.provide(
        harness({ calls, environment: { platform: "win32", homeDirectory: "C:\\Users\\alice" } }),
      ),
    );
  });

  it.effect("falls back to the bundled icon when a design's runtime file is missing", () => {
    const calls = emptyCalls();
    return Effect.gen(function* () {
      yield* (yield* DesktopAppIcon.DesktopAppIcon).apply("outline");
      assert.deepEqual(calls.window, ["/res/icon.png"]);
    }).pipe(
      Effect.provide(
        harness({
          calls,
          environment: { platform: "linux", homeDirectory: "/home/alice" },
          packagedResources: new Set(),
        }),
      ),
    );
  });

  it.effect("uses exported source-tree assets for unpackaged runs", () => {
    const calls = emptyCalls();
    const file = "/repo/assets/prod/black-mac-ios-1024.png";
    return Effect.gen(function* () {
      yield* (yield* DesktopAppIcon.DesktopAppIcon).apply("mac");
      assert.deepEqual(calls.window, [file]);
    }).pipe(
      Effect.provide(
        harness({
          calls,
          environment: { platform: "linux", homeDirectory: "/home/alice", isPackaged: false },
          sourceTreeFiles: new Set([file]),
        }),
      ),
    );
  });
});
