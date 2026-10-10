import type { AppIcon } from "@t3tools/contracts";
import { requireOptionalNativeModule } from "expo";

interface CtrlAppIconModule {
  getAppIcon(): Promise<string>;
  setAppIcon(design: AppIcon): Promise<void>;
}

const native = requireOptionalNativeModule<CtrlAppIconModule>("CtrlAppIcon");

export type LauncherIconResult = "applied" | "unchanged" | "unavailable";

/** Switches the home-screen icon. Never calls the native setter for the active icon. */
export async function applyLauncherIcon(design: AppIcon): Promise<LauncherIconResult> {
  if (!native) return "unavailable";
  if ((await native.getAppIcon()) === design) return "unchanged";
  await native.setAppIcon(design);
  return "applied";
}
