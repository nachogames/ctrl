import type { AppIcon, ClientSettings } from "@t3tools/contracts";
import { useEffect } from "react";

import { useClientSettings } from "./hooks/useSettings";

export const selectAppIcon = (settings: ClientSettings): AppIcon => settings.appIcon;

export function resolveAppIconWebAssets(design: AppIcon) {
  const base = `/app-icons/${design}`;
  return {
    favicon16: `${base}/favicon-16x16.png`,
    favicon32: `${base}/favicon-32x32.png`,
    appleTouch: `${base}/apple-touch-icon.png`,
  };
}

/** Points the tab icon, touch icon and boot splash at the chosen design. */
export function applyAppIconToDocument(doc: Document, design: AppIcon): void {
  const assets = resolveAppIconWebAssets(design);
  for (const link of doc.querySelectorAll('link[rel="icon"]')) link.remove();
  for (const [sizes, href] of [
    ["32x32", assets.favicon32],
    ["16x16", assets.favicon16],
  ] as const) {
    const link = doc.createElement("link");
    link.rel = "icon";
    link.type = "image/png";
    link.setAttribute("sizes", sizes);
    link.setAttribute("href", href);
    doc.head.append(link);
  }
  doc.querySelector('link[rel="apple-touch-icon"]')?.setAttribute("href", assets.appleTouch);
  doc.getElementById("boot-shell-logo")?.setAttribute("src", assets.appleTouch);
}

export function useAppIconDocumentSync(): void {
  const appIcon = useClientSettings(selectAppIcon);
  useEffect(() => {
    applyAppIconToDocument(document, appIcon);
  }, [appIcon]);
}
