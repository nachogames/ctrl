import type { ReactNode } from "react";
import { Platform } from "react-native";

import { useResolveClassNames } from "uniwind";
import { SymbolView } from "./AppSymbol";
import { ListRowLayout, type ListRowContentProps } from "./ListRowLayout";
import { RowPressable } from "./RowPressable";

export function ListRow(
  props: ListRowContentProps & {
    readonly onPress: () => void;
    /** A control before the chevron, such as a button with its own action. */
    readonly trailing?: ReactNode;
  },
) {
  const rippleStyle = useResolveClassNames("bg-subtle-strong");
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={[props.label, props.description, props.detail].filter(Boolean).join(", ")}
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
      android_ripple={{ color: rippleStyle.backgroundColor }}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      className="bg-grouped-card"
    >
      <ListRowLayout
        {...props}
        accessory={
          <>
            {props.trailing}
            <SymbolView
              name="chevron.right"
              size={16}
              tintColorClassName="accent-chevron"
              type="monochrome"
              weight="semibold"
            />
          </>
        }
      />
    </RowPressable>
  );
}
