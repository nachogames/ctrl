import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { Pressable, View, type ViewInstance } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { cn } from "../../lib/cn";

export interface ProjectDragHandlers {
  /** `top` is the header's top edge in the window when the drag began. */
  readonly onStart: (projectKey: string, top: number) => void;
  /** Reports where the lifted header landed once every project folded. */
  readonly onLifted: (top: number) => void;
  readonly onMove: (translation: number) => void;
  readonly onEnd: (cancelled: boolean) => void;
}

/**
 * A project's section heading: its icon and name over a rule. Tapping folds
 * the section to this line. In Edit mode a handle drags it among the projects;
 * every project folds while one is dragged.
 */
export const HomeProjectHeader = memo(function HomeProjectHeader(props: {
  readonly projectKey: string;
  readonly label: string;
  readonly project: EnvironmentProject | null;
  readonly collapsed: boolean;
  readonly count: number;
  readonly pane?: "screen" | "sidebar";
  readonly onToggle: (projectKey: string) => void;
  /** Present in Edit mode when there is more than one project. */
  readonly drag?: ProjectDragHandlers;
  /** Set while this header is the lifted one: its offset from its slot. */
  readonly liftOffset?: number;
  readonly onHeight?: (height: number) => void;
}) {
  const sidebarPane = props.pane === "sidebar";
  const view = useRef<ViewInstance>(null);
  const latest = useRef(props);
  latest.current = props;
  const lifted = props.liftOffset !== undefined;

  // After the drag folds the list, tell the parent where this header moved to
  // so it can keep it under the finger.
  const wasLifted = useRef(false);
  useLayoutEffect(() => {
    if (lifted && !wasLifted.current) {
      view.current?.measureInWindow((_x, y) => latest.current.drag?.onLifted(y));
    }
    wasLifted.current = lifted;
  }, [lifted]);

  const handleGesture = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .shouldCancelWhenOutside(false)
        .runOnJS(true)
        .onStart(() =>
          view.current?.measureInWindow((_x, y) =>
            latest.current.drag?.onStart(latest.current.projectKey, y),
          ),
        )
        .onUpdate((event) => latest.current.drag?.onMove(event.translationY))
        .onFinalize((_event, success) => latest.current.drag?.onEnd(!success)),
    [],
  );

  return (
    <View
      ref={view}
      collapsable={false}
      onLayout={(event) => props.onHeight?.(event.nativeEvent.layout.height)}
      className={cn("flex-row items-center", lifted && "rounded-xl border border-border bg-subtle")}
      style={
        lifted ? { zIndex: 10, transform: [{ translateY: props.liftOffset ?? 0 }] } : undefined
      }
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}, ${props.count} ${props.count === 1 ? "thread" : "threads"}`}
        accessibilityState={{ expanded: !props.collapsed }}
        accessibilityHint={`${props.collapsed ? "Shows" : "Hides"} this project's threads.`}
        onPress={() => props.onToggle(props.projectKey)}
        className={cn(
          "min-w-0 flex-1 flex-row items-center gap-2 py-2.5",
          sidebarPane ? "pl-3" : "pl-5",
          props.drag ? "pr-1" : sidebarPane ? "pr-3" : "pr-5",
        )}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        {props.project ? (
          <ProjectFavicon
            environmentId={props.project.environmentId}
            faviconPath={props.project.faviconPath}
            projectIcon={props.project.projectIcon}
            size={16}
            projectTitle={props.project.title}
            workspaceRoot={props.project.workspaceRoot}
          />
        ) : null}
        <Text
          numberOfLines={1}
          className={cn(
            "shrink text-sm font-t3-medium",
            sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-secondary",
          )}
        >
          {props.label}
        </Text>
        {props.collapsed ? (
          <Text className="text-xs text-foreground-tertiary">{props.count}</Text>
        ) : null}
        <View className={cn("h-px flex-1", sidebarPane ? "bg-drawer-border" : "bg-border")} />
        {props.drag ? null : (
          <SymbolView
            name={props.collapsed ? "chevron.right" : "chevron.down"}
            size={10}
            tintColorClassName="accent-foreground-muted"
            type="monochrome"
          />
        )}
      </Pressable>
      {props.drag ? (
        <GestureDetector gesture={handleGesture}>
          <View
            collapsable={false}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel={`Reorder ${props.label}`}
            style={{ width: 48, height: 40, alignItems: "center", justifyContent: "center" }}
          >
            <SymbolView
              name="line.3.horizontal"
              size={20}
              tintColorClassName="accent-foreground-muted"
            />
          </View>
        </GestureDetector>
      ) : null}
    </View>
  );
});
