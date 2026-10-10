import sharp from "sharp";
import { describe, expect, it } from "vite-plus/test";

import { MACOS_ICON_INSET, renderMacosIconPng } from "./macos-icon.ts";

const alphaAt = (data: Buffer, x: number, y: number) => data[(y * 1024 + x) * 4 + 3]!;

describe("renderMacosIconPng", () => {
  it("keeps an opaque 824px body inset 100px with a soft shadow below", async () => {
    const ios = await sharp({
      create: { width: 1024, height: 1024, channels: 4, background: "#000000" },
    })
      .png()
      .toBuffer();
    const output = await renderMacosIconPng(ios);
    const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height, info.channels]).toEqual([1024, 1024, 4]);
    expect(alphaAt(data, 512, MACOS_ICON_INSET + 1)).toBe(255);
    expect(alphaAt(data, MACOS_ICON_INSET + 1, 512)).toBe(255);
    expect(alphaAt(data, 922, 512)).toBe(255);
    expect(alphaAt(data, 512, 922)).toBe(255);
    expect(alphaAt(data, 512, 60)).toBe(0);
    expect(alphaAt(data, 0, 0)).toBe(0);
    expect(alphaAt(data, 120, 120)).toBeLessThan(255); // rounded corner
    expect(alphaAt(data, 512, 930)).toBeGreaterThan(0); // shadow below the body
    expect(alphaAt(data, 512, 930)).toBeLessThan(128);
  });

  it("is deterministic for icons:check", async () => {
    const ios = await sharp({
      create: { width: 1024, height: 1024, channels: 4, background: "#347FF8" },
    })
      .png()
      .toBuffer();
    expect((await renderMacosIconPng(ios)).equals(await renderMacosIconPng(ios))).toBe(true);
  });
});
