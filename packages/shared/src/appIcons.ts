import { buildAppIconArtwork } from "./appIconArtwork.ts";
import { APP_ICON_LEGENDS } from "./appIconLegends.generated.ts";

export * from "./appIconArtwork.ts";
export const APP_ICON_ARTWORK = buildAppIconArtwork(APP_ICON_LEGENDS);
