import type { AppIcon } from "@t3tools/contracts";
import { APP_ICON_ARTWORK, APP_ICON_MARK_VIEWBOX } from "@t3tools/shared/appIcons";
import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

import { useAppIconDesign } from "../lib/useAppIconDesign";

const ThemedPath = withUniwind(Path);

export function AppIconMark(props: {
  readonly size: number;
  readonly design?: AppIcon;
  readonly tone?: "mono" | "color";
  readonly color?: ColorValue;
  readonly colorClassName?: string;
  readonly accessibilityLabel?: string;
}) {
  const selected = useAppIconDesign();
  const shapes = APP_ICON_ARTWORK[props.design ?? selected][props.tone ?? "mono"];
  return (
    <Svg
      accessibilityLabel={props.accessibilityLabel}
      height={props.size}
      width={props.size}
      viewBox={APP_ICON_MARK_VIEWBOX}
    >
      {shapes.map((shape, index) => (
        <ThemedPath
          key={index}
          d={shape.d}
          fill={shape.fill ?? "none"}
          stroke={shape.stroke}
          strokeWidth={shape.strokeWidth}
          strokeLinecap={shape.strokeLinecap}
          strokeLinejoin={shape.strokeLinejoin}
          opacity={shape.opacity}
          fillRule={shape.fillRule}
          color={props.color}
          colorClassName={props.colorClassName}
        />
      ))}
    </Svg>
  );
}
