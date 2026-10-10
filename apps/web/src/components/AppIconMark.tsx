import type { AppIcon } from "@t3tools/contracts";
import { APP_ICON_ARTWORK, APP_ICON_MARK_VIEWBOX } from "@t3tools/shared/appIcons";
import type { SVGProps } from "react";

import { selectAppIcon } from "../appIcon";
import { useClientSettings } from "../hooks/useSettings";

/** The Ctrl keycap. Follows the appIcon setting unless a design is passed. */
export function AppIconMark({
  design,
  tone = "mono",
  ...props
}: SVGProps<SVGSVGElement> & { readonly design?: AppIcon; readonly tone?: "mono" | "color" }) {
  const selected = useClientSettings(selectAppIcon);
  const shapes = APP_ICON_ARTWORK[design ?? selected][tone];
  return (
    <svg {...props} viewBox={APP_ICON_MARK_VIEWBOX} fill="none" xmlns="http://www.w3.org/2000/svg">
      {shapes.map((shape, index) => (
        <path
          // Shapes are static per design; index keys are stable.
          key={index}
          d={shape.d}
          fill={shape.fill ?? "none"}
          stroke={shape.stroke}
          strokeWidth={shape.strokeWidth}
          strokeLinecap={shape.strokeLinecap}
          strokeLinejoin={shape.strokeLinejoin}
          opacity={shape.opacity}
          fillRule={shape.fillRule}
        />
      ))}
    </svg>
  );
}
