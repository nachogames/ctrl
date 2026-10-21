import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { memo } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { RowPressable } from "../../components/RowPressable";
import { cn } from "../../lib/cn";

/**
 * One row for a chat group's chats in a project section. Tapping expands the
 * chats in place below it; two faint edges under a collapsed row show it holds
 * more than one chat.
 */
export const HomeGroupRow = memo(function HomeGroupRow(props: {
  readonly groupKey: string;
  readonly title: string;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly workingCount: number;
  readonly expanded: boolean;
  readonly showTrailingDivider: boolean;
  readonly pane?: "screen" | "sidebar";
  readonly onToggle: (groupKey: string) => void;
  /** Long-press menu: Arrange puts the list in Arrange mode. */
  readonly onArrange: () => void;
}) {
  const sidebarPane = props.pane === "sidebar";
  const latest = props.threads[0]?.title;
  const count = props.threads.length;
  const actions = [{ id: "arrange", title: "Arrange", image: "line.3.horizontal" }];
  return (
    <ControlPillMenu
      actions={actions}
      shouldOpenOnLongPress
      onPressAction={() => props.onArrange()}
    >
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={`${props.title}, ${count} chats${props.workingCount > 0 ? `, ${props.workingCount} working` : ""}`}
        accessibilityHint={props.expanded ? "Hides the group's chats" : "Shows the group's chats"}
        accessibilityState={{ expanded: props.expanded }}
        className={sidebarPane ? "rounded-xl bg-drawer" : "bg-screen"}
        interactionClassName={sidebarPane ? "bg-thread-hover" : "bg-row-hover"}
        onPress={() => props.onToggle(props.groupKey)}
      >
        <View className={sidebarPane ? "px-3 py-2.5" : "px-5 py-2.5"}>
          <View className="flex-row items-center gap-1.5">
            <SymbolView
              name="square.3.layers.3d"
              size={11}
              tintColorClassName="accent-foreground-tertiary"
              type="monochrome"
            />
            <Text className="text-xs text-foreground-tertiary">{`${count} chats`}</Text>
            {props.workingCount > 0 ? (
              <Text className="text-xs text-adaptive-sky-600-400">
                {`· ${props.workingCount} working`}
              </Text>
            ) : null}
            <View className="flex-1" />
            <SymbolView
              name="chevron.down"
              size={10}
              tintColorClassName="accent-foreground-muted"
              type="monochrome"
              style={{ transform: [{ rotate: props.expanded ? "180deg" : "0deg" }] }}
            />
          </View>
          <Text
            className={cn(
              "mt-1 text-base font-t3-medium text-foreground",
              sidebarPane && "text-drawer-foreground",
            )}
            numberOfLines={1}
          >
            {props.title}
          </Text>
          {latest !== undefined && latest !== props.title ? (
            <Text className="mt-0.5 text-sm text-foreground-muted" numberOfLines={1}>
              {latest}
            </Text>
          ) : null}
        </View>
        {props.expanded ? null : (
          <View pointerEvents="none" className={sidebarPane ? "mx-4" : "mx-7"}>
            <View className="h-1 rounded-b-md border border-t-0 border-border" />
            <View className="mx-3 h-1 rounded-b-md border border-t-0 border-border-subtle" />
          </View>
        )}
        {!sidebarPane && props.showTrailingDivider ? (
          <View className="ml-5 mt-1 h-px bg-border-subtle" />
        ) : null}
      </RowPressable>
    </ControlPillMenu>
  );
});
