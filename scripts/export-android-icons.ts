#!/usr/bin/env node

// Renders the Android launcher and splash artwork from the shared keycap artwork and the
// Icon Composer background sources.
//
// Icon Composer exports already contain a rounded-square silhouette, and Android masks
// the central 72dp of a 108dp adaptive canvas, so exporting them as a foreground produces
// a double-framed icon with the keycap cropped by the mask. Instead, each variant gets a
// full-bleed background layer (the artwork behind the keycap mark) and a transparent
// foreground per design that keeps the keycap inside the safe zone.
//
// The Android 12+ splash screen masks its icon to a circle covering the central two thirds
// of a 288dp canvas, which is the same proportion the launcher crops. Composing the two
// adaptive layers into one 288dp image therefore makes the splash frame the keycap
// exactly like the launcher icon does.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

import { APP_ICON_ARTWORK } from "@t3tools/shared/appIcons";
import { renderAppIconPaths, type AppIconShape } from "@t3tools/shared/appIconArtwork";

import {
  APP_ICON_DESIGNS,
  resolveAndroidAppIconAssetPaths,
  type AppIconDesign,
} from "./lib/brand-assets.ts";

type IconVariant = "dev" | "nightly" | "prod";

// 108dp at xxxhdpi. Expo's prebuild derives every launcher density bucket from this.
const ADAPTIVE_CANVAS = 432;
// 288dp at xxxhdpi: the full Android 12+ splash canvas, so the icon needs no upscaling.
const SPLASH_CANVAS = 1152;
// The keycap occupies 16..112 of the 128-unit layer grid.
const MARK_BOX = { x: 16, y: 16, size: 96 };
// Keycap width as a fraction of the 108dp canvas: 54dp inside the 66dp guaranteed safe zone.
const MARK_FRACTION = 0.5;
// Android's monochrome and notification icons are flat silhouettes and may run larger.
const NOTIFICATION_CANVAS = 96;
const NOTIFICATION_FRACTION = 0.9;
// Icon Composer positions layers on a 1024pt canvas, with translation relative to center.
const COMPOSER_CANVAS_PT = 1024;
const SVG_DENSITY = 300;
const OUTPUT_DIRECTORY = "apps/mobile/assets";
// Production has no background artwork, so its splash composes onto the adaptive color.
const PRODUCTION_BACKGROUND_COLOR = "#000000";

export class AndroidIconRenderError extends Schema.TaggedError<AndroidIconRenderError>()(
  "AndroidIconRenderError",
  { layer: Schema.String, cause: Schema.Defect() },
) {}

export const markTransform = (size: number, fraction: number) => {
  const scale = (size * fraction) / MARK_BOX.size;
  const offset = (size - MARK_BOX.size * scale) / 2 - MARK_BOX.x * scale;
  return `translate(${offset.toFixed(3)} ${offset.toFixed(3)}) scale(${scale.toFixed(4)})`;
};

const canvasSvg = (size: number, inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none">${inner}</svg>`;

// The layer sources clip to a 10pt rounded rectangle for the iOS silhouette. Android
// applies its own mask, so the layer must bleed to the canvas edge.
const fullBleed = (svg: string) =>
  svg.replace(/<rect width="128" height="128" rx="10"\/>/, '<rect width="128" height="128"/>');

const rasterize = (layer: string, svg: string, width: number, height = width) =>
  Effect.tryPromise({
    try: () =>
      sharp(Buffer.from(svg), { density: SVG_DENSITY }).resize(width, height).png().toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const composite = (
  layer: string,
  base: Buffer,
  overlays: ReadonlyArray<{ input: Buffer; left?: number; top?: number }>,
) =>
  Effect.tryPromise({
    try: () =>
      sharp(base)
        .composite([...overlays])
        .png()
        .toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const solidCanvas = (layer: string, size: number, background: string) =>
  Effect.tryPromise({
    try: () =>
      sharp({ create: { width: size, height: size, channels: 4, background } })
        .png()
        .toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const readLayerSource = Effect.fn("androidIcons.readLayerSource")(function* (
  repositoryRoot: string,
  variant: IconVariant,
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(
    path.join(repositoryRoot, "assets", variant, "app-icon.icon", "Assets", file),
  );
});

const shapesMarkup = (shapes: ReadonlyArray<AppIconShape>, currentColor?: string) =>
  renderAppIconPaths(shapes, currentColor === undefined ? {} : { currentColor })
    .split("\n")
    .join("");

const renderMark = (layer: string, shapes: string, size: number, fraction: number) =>
  rasterize(
    layer,
    canvasSvg(size, `<g transform="${markTransform(size, fraction)}">${shapes}</g>`),
    size,
  );

const renderForeground = (design: AppIconDesign, size: number) =>
  renderMark(
    `foreground-${design}`,
    shapesMarkup(APP_ICON_ARTWORK[design].color),
    size,
    MARK_FRACTION,
  );

const renderMonochrome = (design: AppIconDesign, size: number) =>
  renderMark(
    `monochrome-${design}`,
    shapesMarkup(APP_ICON_ARTWORK[design].mono, "#FFFFFF"),
    size,
    MARK_FRACTION,
  );

const renderDevelopmentBackground = Effect.fn("androidIcons.renderDevelopmentBackground")(
  function* (repositoryRoot: string, size: number) {
    // The annotation layer shares the keycap's coordinate space, so it is scaled and
    // centered the same way to keep the dimension lines around the keycap.
    const annotations = yield* readLayerSource(repositoryRoot, "dev", "annotations.svg");
    const defs = annotations.match(/<defs>[\s\S]*?<\/defs>/)?.[0] ?? "";
    const body = annotations.replace(/^[\s\S]*?<\/defs>/, "").replace(/<\/svg>\s*$/, "");
    const paper = yield* readLayerSource(repositoryRoot, "dev", "background.svg");
    const background = yield* rasterize("dev-background", fullBleed(paper), size);
    const overlay = yield* rasterize(
      "dev-annotations",
      canvasSvg(size, `${defs}<g transform="${markTransform(size, MARK_FRACTION)}">${body}</g>`),
      size,
    );
    return yield* composite("dev-background", background, [{ input: overlay }]);
  },
);

const renderNightlyBackground = Effect.fn("androidIcons.renderNightlyBackground")(function* (
  repositoryRoot: string,
  size: number,
) {
  // Positions mirror assets/nightly/app-icon.icon/icon.json. The SVG blur filter is
  // dropped because Icon Composer ignores it and it smears at this raster size.
  const clouds = [
    { file: "cloud-lower-left.svg", scale: 25, translation: [-309.6375, 268.66077693836917] },
    {
      file: "cloud-upper-right.svg",
      scale: 15,
      translation: [387.9605131881942, -134.30064713259117],
    },
  ] as const;
  const k = size / COMPOSER_CANVAS_PT;
  const overlays = yield* Effect.forEach(clouds, (cloud) =>
    Effect.gen(function* () {
      const width = Math.round(64 * cloud.scale * k);
      const height = Math.round(32 * cloud.scale * k);
      const left = Math.round((COMPOSER_CANVAS_PT / 2 + cloud.translation[0]) * k - width / 2);
      const top = Math.round((COMPOSER_CANVAS_PT / 2 + cloud.translation[1]) * k - height / 2);
      const source = yield* readLayerSource(repositoryRoot, "nightly", cloud.file);
      const png = yield* rasterize(
        cloud.file,
        source.replace(/ filter="url\(#soft\)"/, ""),
        width,
        height,
      );
      const x0 = Math.max(0, left);
      const y0 = Math.max(0, top);
      const x1 = Math.min(size, left + width);
      const y1 = Math.min(size, top + height);
      const clipped = yield* Effect.tryPromise({
        try: () =>
          sharp(png)
            .extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 })
            .png()
            .toBuffer(),
        catch: (cause) => new AndroidIconRenderError({ layer: cloud.file, cause }),
      });
      return { input: clipped, left: x0, top: y0 };
    }),
  );
  const sky = yield* readLayerSource(repositoryRoot, "nightly", "background.svg");
  const background = yield* rasterize("nightly-background", fullBleed(sky), size);
  return yield* composite("nightly-background", background, overlays);
});

const renderBackground = Effect.fn("androidIcons.renderBackground")(function* (
  repositoryRoot: string,
  variant: IconVariant,
  size: number,
) {
  switch (variant) {
    case "dev":
      return yield* renderDevelopmentBackground(repositoryRoot, size);
    case "nightly":
      return yield* renderNightlyBackground(repositoryRoot, size);
    case "prod":
      return yield* solidCanvas("prod-background", size, PRODUCTION_BACKGROUND_COLOR);
  }
});

const renderSplashIcon = Effect.fn("androidIcons.renderSplashIcon")(function* (
  repositoryRoot: string,
  variant: IconVariant,
) {
  const background = yield* renderBackground(repositoryRoot, variant, SPLASH_CANVAS);
  const foreground = yield* renderForeground("solid", SPLASH_CANVAS);
  return yield* composite(`${variant}-splash`, background, [{ input: foreground }]);
});

export const exportAndroidIcons = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const designOutputs = yield* Effect.forEach(APP_ICON_DESIGNS, (design) =>
    Effect.gen(function* () {
      const paths = resolveAndroidAppIconAssetPaths(design);
      return [
        [
          paths.foreground.replace("./assets/", ""),
          yield* renderForeground(design, ADAPTIVE_CANVAS),
        ],
        [
          paths.monochrome.replace("./assets/", ""),
          yield* renderMonochrome(design, ADAPTIVE_CANVAS),
        ],
      ] as const;
    }),
  );
  const outputs = [
    ...designOutputs.flat(),
    [
      "android-notification-icon.png",
      yield* renderMark(
        "notification",
        shapesMarkup(APP_ICON_ARTWORK.solid.mono, "#FFFFFF"),
        NOTIFICATION_CANVAS,
        NOTIFICATION_FRACTION,
      ),
    ],
    [
      "android-icon-background-dev.png",
      yield* renderDevelopmentBackground(repositoryRoot, ADAPTIVE_CANVAS),
    ],
    [
      "android-icon-background-nightly.png",
      yield* renderNightlyBackground(repositoryRoot, ADAPTIVE_CANVAS),
    ],
    ["android-splash-icon-dev.png", yield* renderSplashIcon(repositoryRoot, "dev")],
    ["android-splash-icon-nightly.png", yield* renderSplashIcon(repositoryRoot, "nightly")],
    ["android-splash-icon-prod.png", yield* renderSplashIcon(repositoryRoot, "prod")],
  ] as const;
  for (const [name, contents] of outputs) {
    yield* fs.writeFile(path.join(repositoryRoot, OUTPUT_DIRECTORY, name), contents);
    yield* Console.log(`wrote ${OUTPUT_DIRECTORY}/${name}`);
  }
});

if (import.meta.main) {
  exportAndroidIcons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
