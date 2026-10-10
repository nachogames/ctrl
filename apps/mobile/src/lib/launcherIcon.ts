import type { AppIcon } from "@t3tools/contracts";
import { requireOptionalNativeModule } from "expo";

interface CtrlAppIconModule {
  getAppIcon(): Promise<string>;
  setAppIcon(design: AppIcon): Promise<void>;
}

const native = requireOptionalNativeModule<CtrlAppIconModule>("CtrlAppIcon");

export type LauncherIconResult = "applied" | "unchanged" | "unavailable";

// Each switch reads then writes the native icon, so switches run one at a time.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Switches the home-screen icon. Calls run in order, so the last request wins.
 * Never calls the native setter for the active icon.
 */
export function applyLauncherIcon(design: AppIcon): Promise<LauncherIconResult> {
  const result = queue.then(async (): Promise<LauncherIconResult> => {
    if (!native) return "unavailable";
    if ((await native.getAppIcon()) === design) return "unchanged";
    await native.setAppIcon(design);
    return "applied";
  });
  queue = result.catch(() => undefined);
  return result;
}
