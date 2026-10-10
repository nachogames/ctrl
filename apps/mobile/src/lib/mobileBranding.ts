export type MobileStageLabel = "Alpha" | "Dev" | "Nightly";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Nightly";
  return "Alpha";
}

export const MOBILE_APP_BASE_NAME = "Ctrl";

export type BrandMarkVariant = "development" | "preview" | "production";

export function resolveBrandMarkVariant(appVariant: unknown): BrandMarkVariant {
  if (appVariant === "development") return "development";
  if (appVariant === "preview") return "preview";
  return "production";
}
