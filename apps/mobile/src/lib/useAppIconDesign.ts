import { useAtomValue } from "@effect/atom-react";
import type { AppIcon } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom } from "../state/preferences";
import { resolveAppIconPreference } from "./appIconPreference";

export function useAppIconDesign(): AppIcon {
  const result = useAtomValue(mobilePreferencesAtom);
  return resolveAppIconPreference(AsyncResult.isSuccess(result) ? result.value.appIcon : undefined);
}
