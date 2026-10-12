import type { HostBattery } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { themeColorWithAlpha, type MobileThemeVariables } from "../../lib/mobileTheme";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

function batteryFillColor(percent: number, theme: MobileThemeVariables, dark: boolean): string {
  if (percent <= 20) return theme["--color-danger-foreground"];
  if (percent <= 50) return theme["--color-warning-foreground"];
  // Same green as the connected status dot.
  return dark ? "#34d399" : "#059669";
}

/** The symbol and tint for a battery in a menu row, colored by level. */
export function batteryMenuIcon(
  battery: HostBattery,
  theme: MobileThemeVariables,
  dark: boolean,
): { readonly image: string; readonly imageColor: string } {
  const image = battery.pluggedIn
    ? "battery.100percent.bolt"
    : battery.percent <= 25
      ? "battery.25percent"
      : battery.percent <= 50
        ? "battery.50percent"
        : battery.percent <= 80
          ? "battery.75percent"
          : "battery.100percent";
  return { image, imageColor: batteryFillColor(battery.percent, theme, dark) };
}

/**
 * A machine's battery drawn as a battery: the fill shows the level, colored
 * green, yellow, or red, with a bolt over it while on power. Phones have no
 * hover, so a tap reveals the exact percent.
 */
export function EnvironmentBattery(props: {
  readonly battery: HostBattery;
  /** Always show the percent, as a plain view. Use inside a row that is itself pressable. */
  readonly percentShown?: boolean;
  /** What it is drawn on, so the bolt's outline matches. Defaults to a grouped card row. */
  readonly surface?: "card" | "header";
}) {
  const { battery } = props;
  const [tappedPercent, setShowPercent] = useState(false);
  const showPercent = props.percentShown === true || tappedPercent;
  const { themeAppearance, themeVariables } = useAppearancePreferences();
  const outline = themeColorWithAlpha(themeVariables["--color-icon-muted"], 0.7);
  const label = `${battery.percent}%, ${battery.pluggedIn ? "plugged in" : "on battery"}`;
  return (
    <Pressable
      className="flex-row items-center gap-1"
      hitSlop={8}
      disabled={props.percentShown === true}
      accessible={props.percentShown !== true}
      accessibilityRole="button"
      accessibilityLabel={`Battery ${label}`}
      onPress={() => setShowPercent((shown) => !shown)}
    >
      <View className="flex-row items-center" style={{ position: "relative" }}>
        <View
          style={{
            width: 20,
            height: 10,
            borderRadius: 3,
            borderWidth: 1,
            borderColor: outline,
            padding: 1,
          }}
        >
          <View
            style={{
              // At least a sliver, so an almost-empty battery still reads as red.
              width: `${Math.max(battery.percent, 8)}%`,
              height: "100%",
              borderRadius: 1.5,
              backgroundColor: batteryFillColor(
                battery.percent,
                themeVariables,
                themeAppearance === "dark",
              ),
            }}
          />
        </View>
        <View
          style={{
            width: 2,
            height: 4,
            borderTopRightRadius: 1,
            borderBottomRightRadius: 1,
            backgroundColor: outline,
          }}
        />
        {battery.pluggedIn ? (
          <Svg
            width={12}
            height={12}
            viewBox="0 0 24 24"
            style={{ position: "absolute", left: 4, top: -1 }}
          >
            {/* Outline in the surface color first, so the bolt reads over any fill. */}
            <Path
              d="M13 2 4 14h7l-1 8 9-12h-7z"
              fill="none"
              stroke={
                themeVariables[
                  props.surface === "header" ? "--color-header" : "--color-grouped-card"
                ]
              }
              strokeWidth={3}
              strokeLinejoin="round"
            />
            <Path d="M13 2 4 14h7l-1 8 9-12h-7z" fill={themeVariables["--color-foreground"]} />
          </Svg>
        ) : null}
      </View>
      {showPercent ? (
        <Text className="text-xs tabular-nums text-foreground-muted">{battery.percent}%</Text>
      ) : null}
    </Pressable>
  );
}
