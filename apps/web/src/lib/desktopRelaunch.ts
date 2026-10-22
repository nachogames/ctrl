import type { EnvironmentId } from "@t3tools/contracts";

import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useEnvironment } from "../state/environments";

/** Relaunching the desktop app only restarts servers it bundles, not remote ones. */
export function useCanRelaunchDesktopEnvironment(environmentId: EnvironmentId | null): boolean {
  const environment = useEnvironment(environmentId);
  return (
    typeof window !== "undefined" &&
    window.desktopBridge?.relaunchApp !== undefined &&
    environment !== null &&
    isDesktopLocalConnectionTarget(environment.entry.target)
  );
}

export async function relaunchDesktopApp(): Promise<void> {
  await window.desktopBridge?.relaunchApp?.();
}
