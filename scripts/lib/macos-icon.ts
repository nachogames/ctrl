import sharp from "sharp";

export const MACOS_ICON_CANVAS = 1024;
export const MACOS_ICON_BODY = 824;
export const MACOS_ICON_INSET = 100;
const SQUIRCLE_EXPONENT = 4.3;
const SHADOW_OFFSET_Y = 10;
const SHADOW_OPACITY = 0.28;
const SHADOW_BLUR_SIGMA = 14;

function squirclePath(size: number, offset: number): string {
  const half = size / 2;
  const points: string[] = [];
  for (let step = 0; step < 720; step += 1) {
    const angle = (step / 720) * 2 * Math.PI;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = half + half * Math.sign(cos) * Math.abs(cos) ** (2 / SQUIRCLE_EXPONENT);
    const y = half + half * Math.sign(sin) * Math.abs(sin) ** (2 / SQUIRCLE_EXPONENT);
    points.push(`${(x + offset).toFixed(2)} ${(y + offset).toFixed(2)}`);
  }
  return `M${points.join("L")}Z`;
}

/**
 * macOS pre-Tahoe icon from the full-bleed Icon Composer iOS export: 1024 canvas, 824 opaque
 * body inset 100px, soft shadow. Replaces the manual GUI export in assets/README.md.
 */
export async function renderMacosIconPng(iosPng: Buffer): Promise<Buffer> {
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MACOS_ICON_BODY}" height="${MACOS_ICON_BODY}"><path d="${squirclePath(MACOS_ICON_BODY, 0)}" fill="#fff"/></svg>`,
  );
  const body = await sharp(iosPng)
    .resize(MACOS_ICON_BODY, MACOS_ICON_BODY)
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
  const shadow = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${MACOS_ICON_CANVAS}" height="${MACOS_ICON_CANVAS}"><path d="${squirclePath(MACOS_ICON_BODY, MACOS_ICON_INSET)}" transform="translate(0 ${SHADOW_OFFSET_Y})" fill="#000" fill-opacity="${SHADOW_OPACITY}"/></svg>`,
    ),
  )
    .blur(SHADOW_BLUR_SIGMA)
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: MACOS_ICON_CANVAS,
      height: MACOS_ICON_CANVAS,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: shadow, left: 0, top: 0 },
      { input: body, left: MACOS_ICON_INSET, top: MACOS_ICON_INSET },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}
