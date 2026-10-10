import type { AppIcon } from "@t3tools/contracts";

import type { BrandMarkVariant } from "../lib/mobileBranding";

const BRAND_MARK_SOURCES: Record<BrandMarkVariant, Record<AppIcon, number>> = {
  development: {
    outline: require("../../../../assets/dev/blueprint-outline-ios-1024.png"),
    solid: require("../../../../assets/dev/blueprint-ios-1024.png"),
    mac: require("../../../../assets/dev/blueprint-mac-ios-1024.png"),
  },
  preview: {
    outline: require("../../../../assets/nightly/nightly-outline-ios-1024.png"),
    solid: require("../../../../assets/nightly/nightly-ios-1024.png"),
    mac: require("../../../../assets/nightly/nightly-mac-ios-1024.png"),
  },
  production: {
    outline: require("../../../../assets/prod/black-outline-ios-1024.png"),
    solid: require("../../../../assets/prod/black-ios-1024.png"),
    mac: require("../../../../assets/prod/black-mac-ios-1024.png"),
  },
};

export function resolveBrandMarkSource(variant: BrandMarkVariant, design: AppIcon): number {
  return BRAND_MARK_SOURCES[variant][design];
}
