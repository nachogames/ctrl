import { Pressable } from "react-native";
import { Chip } from "../../components/ui/Chip";
import { Menu } from "../../components/ui/Menu";
import type { MenuProps } from "../../components/ui/Menu.types";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/** A visible filter with a native menu containing only that filter's choices. */
export function ListFilterMenu(props: {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly active?: boolean;
  readonly icon?: boolean;
  readonly actions: MenuProps["actions"];
  readonly onSelect: (id: string) => void;
}) {
  const { themeAppearance } = useAppearancePreferences();
  return (
    <Menu
      title={props.accessibilityLabel}
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        accessibilityState={{ selected: Boolean(props.active) }}
        hitSlop={6}
      >
        <Chip
          label={props.label}
          selected={props.active}
          icon={props.icon ? "line.3.horizontal.decrease" : undefined}
          trailingIcon={props.icon ? undefined : "chevron.down"}
          glass
          colorScheme={themeAppearance}
        />
      </Pressable>
    </Menu>
  );
}

/** A one-tap filter choice styled like the menu pills, with an optional status dot. */
export function ListFilterChip(props: {
  readonly label: string;
  readonly active: boolean;
  readonly indicator?: "attention" | "working" | null;
  readonly accessibilityLabel?: string;
  readonly onPress: () => void;
}) {
  const { themeAppearance } = useAppearancePreferences();
  return (
    <Chip
      label={props.label}
      selected={props.active}
      indicator={props.indicator ?? null}
      glass
      colorScheme={themeAppearance}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      onPress={props.onPress}
    />
  );
}
