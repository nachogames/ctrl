// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vite-plus/test";

import { applyAppIconToDocument, resolveAppIconWebAssets } from "./appIcon";

beforeEach(() => {
  document.head.innerHTML =
    '<link rel="icon" href="/favicon.ico" sizes="48x48" /><link rel="apple-touch-icon" href="/apple-touch-icon.png" /><link rel="manifest" href="/manifest.webmanifest" />';
  document.body.innerHTML = '<img id="boot-shell-logo" src="/apple-touch-icon.png" />';
});

const iconLinks = () =>
  [...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')].map((link) => [
    link.getAttribute("sizes"),
    link.getAttribute("href"),
  ]);

describe("app icon document sync", () => {
  it("resolves per-design public URLs", () => {
    expect(resolveAppIconWebAssets("outline")).toEqual({
      favicon16: "/app-icons/outline/favicon-16x16.png",
      favicon32: "/app-icons/outline/favicon-32x32.png",
      appleTouch: "/app-icons/outline/apple-touch-icon.png",
    });
  });

  it("swaps favicon links, the touch icon and the splash logo", () => {
    applyAppIconToDocument(document, "mac");
    expect(iconLinks()).toEqual([
      ["32x32", "/app-icons/mac/favicon-32x32.png"],
      ["16x16", "/app-icons/mac/favicon-16x16.png"],
    ]);
    expect(document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href")).toBe(
      "/app-icons/mac/apple-touch-icon.png",
    );
    expect(document.getElementById("boot-shell-logo")?.getAttribute("src")).toBe(
      "/app-icons/mac/apple-touch-icon.png",
    );
    expect(document.querySelector('link[rel="manifest"]')).not.toBeNull();
  });

  it("stays idempotent across repeated switches", () => {
    applyAppIconToDocument(document, "outline");
    applyAppIconToDocument(document, "solid");
    expect(iconLinks()).toEqual([
      ["32x32", "/app-icons/solid/favicon-32x32.png"],
      ["16x16", "/app-icons/solid/favicon-16x16.png"],
    ]);
  });
});
