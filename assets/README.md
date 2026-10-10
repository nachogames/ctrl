# Brand icons

The three Icon Composer projects are the source of truth for full application icons:

- `dev/app-icon.icon`
- `nightly/app-icon.icon`
- `prod/app-icon.icon`

Each project uses `text.svg` for the keycap mark and `background.svg` when the background is a vector layer. Additional layers use semantic names that describe their role and placement.

Run `vp run icons:export` from the repository root to regenerate the tracked iOS, Linux, Windows, and web assets. The development web exports are also copied to `apps/web/public` for the browser favicon and splash screen. Run `vp run icons:check` to verify that the generated assets and public copies match their sources without changing files.

Exporting requires Icon Composer 2 or newer on macOS. The script selects the newest compatible exporter from Xcode or a standalone Icon Composer installation and pins design generation 26. Set `ICON_COMPOSER_TOOL` to the full path of `Icon Composer.app/Contents/Executables/ictool` to override automatic discovery.

## Designs

Each channel has one Icon Composer project per keycap design. `app-icon.icon` is the bundled default (`solid`). `app-icon-outline.icon` and `app-icon-mac.icon` are runtime-only designs selected by the `appIcon` client setting. Their exports use the design in the file name, for example `prod/black-outline-macos-1024.png`. Do not edit `Assets/text.svg` by hand. It is written by `vp run icons:sources` from `packages/shared/src/appIconArtwork.ts`, whose lettering is DM Sans (SIL OFL 1.1) converted to paths by `node scripts/generate-app-icon-legends.ts`.

## macOS exports

`vp run icons:export` also writes the macOS PNGs (`*-macos-1024.png`). It derives them from the full-bleed Icon Composer render: a 1024×1024 canvas, an 824×824 opaque body inset 100px with the macOS squircle, and a soft shadow (`scripts/lib/macos-icon.ts`). No manual Icon Composer GUI export is needed.

Do not edit the generated PNG or ICO files directly.

## Android launcher and splash artwork

Android masks the central 72dp of a 108dp adaptive canvas, and the Android 12+ splash screen masks
the central two thirds of a 288dp canvas, so the Icon Composer exports cannot be used directly:
their rounded-square silhouette gets framed again and the wordmark is cropped. The Android artwork
is instead rendered from the same Icon Composer SVG sources by `vp run icons:export:android`:

- `apps/mobile/assets/android-icon-foreground.png`: the shared transparent wordmark, sized to stay
  inside the safe zone
- `apps/mobile/assets/android-icon-background-dev.png` and `-nightly.png`: full-bleed variant
  artwork (blueprint grid and annotations; night sky and clouds). Production uses a solid color.
- `apps/mobile/assets/android-splash-icon-*.png`: the two layers composed into one 288dp image, so
  the splash mask reproduces the launcher icon's framing.

Rerun the export after changing a layer SVG. `android-icon-mark.png` remains a flat silhouette for
Android's monochrome themed icon.
