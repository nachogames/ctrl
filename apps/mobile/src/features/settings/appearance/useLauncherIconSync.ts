import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import { resolveAppIconPreference } from "../../../lib/appIconPreference";
import { applyLauncherIcon } from "../../../lib/launcherIcon";
import { mobilePreferencesAtom } from "../../../state/preferences";

/** Keeps the launcher icon on the saved design, at startup and after every change. */
export function useLauncherIconSync(): void {
  const result = useAtomValue(mobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(result) && !result.waiting;
  const design = AsyncResult.isSuccess(result)
    ? resolveAppIconPreference(result.value.appIcon)
    : null;
  useEffect(() => {
    if (!ready || design === null) return;
    applyLauncherIcon(design).catch((error: unknown) => {
      console.warn("Could not switch the app icon.", error);
    });
  }, [ready, design]);
}
