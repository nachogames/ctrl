import { APP_ICONS, DEFAULT_APP_ICON, type AppIcon } from "@t3tools/contracts";

/** Device-local, like other mobile appearance preferences (mobile does not sync ClientSettings). */
export function isAppIcon(value: unknown): value is AppIcon {
  return typeof value === "string" && (APP_ICONS as ReadonlyArray<string>).includes(value);
}

export function resolveAppIconPreference(value: unknown): AppIcon {
  return isAppIcon(value) ? value : DEFAULT_APP_ICON;
}
