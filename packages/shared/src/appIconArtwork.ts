import type { AppIcon } from "@t3tools/contracts";

export interface AppIconShape {
  readonly d: string;
  readonly fill?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
  readonly strokeLinecap?: "round";
  readonly strokeLinejoin?: "round";
  readonly opacity?: number;
  readonly fillRule?: "evenodd";
}

export interface AppIconArtwork {
  readonly label: string;
  readonly description: string;
  /** Full-color keycap drawn for the black app-icon background. */
  readonly color: ReadonlyArray<AppIconShape>;
  /** Single-color silhouette painted with currentColor, for inline marks. */
  readonly mono: ReadonlyArray<AppIconShape>;
}

export interface AppIconLegends {
  readonly outlineCtrl: string;
  readonly solidCtrl: string;
  readonly macControl: string;
}

/** Icon Composer layer coordinate space (assets/<channel>/app-icon*.icon/Assets/*.svg). */
export const APP_ICON_CANVAS = 128;
/** Tight box around every keycap (16..112 plus stroke), for inline marks. */
export const APP_ICON_MARK_VIEWBOX = "14 14 100 100";

export function roundedRectPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): string {
  const right = x + width;
  const bottom = y + height;
  return (
    `M${x + radius} ${y}H${right - radius}A${radius} ${radius} 0 0 1 ${right} ${y + radius}` +
    `V${bottom - radius}A${radius} ${radius} 0 0 1 ${right - radius} ${bottom}` +
    `H${x + radius}A${radius} ${radius} 0 0 1 ${x} ${bottom - radius}` +
    `V${y + radius}A${radius} ${radius} 0 0 1 ${x + radius} ${y}Z`
  );
}

/** The Mac control key's "⌃", drawn as a chevron because DM Sans has no U+2303 glyph. */
const CONTROL_CARET = "M86.5 39.5L92 33.5L97.5 39.5";
const CARET_STROKE = { strokeWidth: 3.2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function buildAppIconArtwork(legends: AppIconLegends): Record<AppIcon, AppIconArtwork> {
  const outlineOuter = roundedRectPath(18, 22, 92, 88, 16);
  const outlineInner = roundedRectPath(28, 28, 72, 66, 10);
  const solidShadow = roundedRectPath(16, 20, 96, 92, 18);
  const solidBody = roundedRectPath(16, 16, 96, 86, 18);
  const solidFace = roundedRectPath(24, 22, 80, 70, 12);
  return {
    outline: {
      label: "Outline",
      description: "Line-drawn key with an inset top face and a lower-left legend.",
      color: [
        { d: outlineOuter, stroke: "#FFFFFF", strokeWidth: 5 },
        { d: outlineInner, stroke: "#FFFFFF", strokeWidth: 3, opacity: 0.55 },
        { d: legends.outlineCtrl, fill: "#FFFFFF" },
      ],
      mono: [
        { d: outlineOuter, stroke: "currentColor", strokeWidth: 5 },
        { d: outlineInner, stroke: "currentColor", strokeWidth: 3, opacity: 0.55 },
        { d: legends.outlineCtrl, fill: "currentColor" },
      ],
    },
    solid: {
      label: "Solid",
      description: "A bright physical key seen slightly from above. The default.",
      color: [
        { d: solidShadow, fill: "#8A8A8A" },
        { d: solidBody, fill: "#FFFFFF" },
        { d: solidFace, fill: "#ECECEC" },
        { d: legends.solidCtrl, fill: "#111111" },
      ],
      mono: [
        // Shadow minus body: only the lip below the key shows.
        { d: solidShadow + solidBody, fill: "currentColor", opacity: 0.45, fillRule: "evenodd" },
        // Body with the legend knocked out.
        { d: solidBody + legends.solidCtrl, fill: "currentColor", fillRule: "evenodd" },
      ],
    },
    mac: {
      label: "Mac",
      description: "Apple keyboard control key, with ⌃ and “control”.",
      color: [
        {
          d: roundedRectPath(18, 20, 92, 90, 16),
          fill: "#1C1C1E",
          stroke: "#3A3A3C",
          strokeWidth: 2,
        },
        { d: roundedRectPath(18, 18, 92, 84, 16), fill: "#2C2C2E" },
        { d: CONTROL_CARET, stroke: "#FFFFFF", ...CARET_STROKE },
        { d: legends.macControl, fill: "#FFFFFF" },
      ],
      mono: [
        { d: roundedRectPath(18, 18, 92, 92, 16), stroke: "currentColor", strokeWidth: 4 },
        { d: CONTROL_CARET, stroke: "currentColor", ...CARET_STROKE },
        { d: legends.macControl, fill: "currentColor" },
      ],
    },
  };
}

function paint(value: string | undefined, currentColor: string | undefined): string | undefined {
  return value === "currentColor" && currentColor !== undefined ? currentColor : value;
}

/** The `<path/>` markup for the shapes, one element per line, with no `<svg>` wrapper. */
export function renderAppIconPaths(
  shapes: ReadonlyArray<AppIconShape>,
  options: { readonly currentColor?: string } = {},
): string {
  return shapes
    .map((shape) => {
      const attributes = [
        `d="${shape.d}"`,
        `fill="${paint(shape.fill, options.currentColor) ?? "none"}"`,
        shape.stroke ? `stroke="${paint(shape.stroke, options.currentColor)}"` : "",
        shape.strokeWidth !== undefined ? `stroke-width="${shape.strokeWidth}"` : "",
        shape.strokeLinecap ? `stroke-linecap="${shape.strokeLinecap}"` : "",
        shape.strokeLinejoin ? `stroke-linejoin="${shape.strokeLinejoin}"` : "",
        shape.opacity !== undefined ? `opacity="${shape.opacity}"` : "",
        shape.fillRule ? `fill-rule="${shape.fillRule}"` : "",
      ].filter(Boolean);
      return `  <path ${attributes.join(" ")}/>`;
    })
    .join("\n");
}

export function renderAppIconSvg(
  shapes: ReadonlyArray<AppIconShape>,
  options: {
    readonly viewBox?: string;
    readonly width?: number;
    readonly height?: number;
    readonly currentColor?: string;
  } = {},
): string {
  const viewBox = options.viewBox ?? `0 0 ${APP_ICON_CANVAS} ${APP_ICON_CANVAS}`;
  const width = options.width ?? APP_ICON_CANVAS;
  const height = options.height ?? APP_ICON_CANVAS;
  const body = renderAppIconPaths(shapes, options);
  return `<svg width="${width}" height="${height}" viewBox="${viewBox}" fill="none" xmlns="http://www.w3.org/2000/svg">\n${body}\n</svg>\n`;
}

/** Android VectorDrawable of the inline mark box (APP_ICON_MARK_VIEWBOX). */
export function renderVectorDrawable(
  shapes: ReadonlyArray<AppIconShape>,
  options: { readonly color: string; readonly sizeDp: number },
): string {
  const paths = shapes
    .map((shape) => {
      const attributes = [
        `android:pathData="${shape.d}"`,
        shape.fill ? `android:fillColor="${options.color}"` : "",
        shape.stroke ? `android:strokeColor="${options.color}"` : "",
        shape.strokeWidth !== undefined ? `android:strokeWidth="${shape.strokeWidth}"` : "",
        shape.strokeLinecap ? `android:strokeLineCap="round"` : "",
        shape.strokeLinejoin ? `android:strokeLineJoin="round"` : "",
        shape.opacity !== undefined && shape.fill ? `android:fillAlpha="${shape.opacity}"` : "",
        shape.opacity !== undefined && shape.stroke ? `android:strokeAlpha="${shape.opacity}"` : "",
        shape.fillRule === "evenodd" ? `android:fillType="evenOdd"` : "",
      ].filter(Boolean);
      return `        <path ${attributes.join("\n            ")}/>`;
    })
    .join("\n");
  return [
    "<!-- Generated by scripts/sync-app-icon-sources.ts from packages/shared/src/appIconArtwork.ts. -->",
    '<vector xmlns:android="http://schemas.android.com/apk/res/android"',
    `    android:width="${options.sizeDp}dp" android:height="${options.sizeDp}dp"`,
    '    android:viewportWidth="100" android:viewportHeight="100">',
    '    <group android:translateX="-14" android:translateY="-14">',
    paths,
    "    </group>",
    "</vector>",
    "",
  ].join("\n");
}
