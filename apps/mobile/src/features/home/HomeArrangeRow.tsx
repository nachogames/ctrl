import { useEffectEvent, useState, type ReactNode } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";

export interface ArrangeDragHandlers {
  readonly onStart: (itemKey: string) => void;
  readonly onMove: (translation: number) => void;
  readonly onEnd: (cancelled: boolean) => void;
  readonly onHeight: (itemKey: string, height: number) => void;
}

/**
 * A list row in Arrange mode: the row itself stops taking touches and a drag
 * handle on the right moves it among its siblings (a project's groups or
 * threads, a group's chats, or Pinned).
 */
export function HomeArrangeRow(props: {
  readonly itemKey: string;
  readonly label: string;
  readonly handlers: ArrangeDragHandlers;
  /** Set while this row is lifted: its offset from its current slot. */
  readonly liftOffset?: number;
  /** Keep the row tappable, as a group row must open to reach its chats. */
  readonly interactive?: boolean;
  readonly children: ReactNode;
}) {
  const lifted = props.liftOffset !== undefined;
  // Gesture callbacks fire outside render, so effect events give them the
  // latest props while the gesture object itself stays stable.
  const onStart = useEffectEvent(() => props.handlers.onStart(props.itemKey));
  const onMove = useEffectEvent((translation: number) => props.handlers.onMove(translation));
  const onEnd = useEffectEvent((cancelled: boolean) => props.handlers.onEnd(cancelled));
  const [gesture] = useState(() =>
    Gesture.Pan()
      .minDistance(0)
      .shouldCancelWhenOutside(false)
      .runOnJS(true)
      .onStart(() => onStart())
      .onUpdate((event) => onMove(event.translationY))
      .onFinalize((_event, success) => onEnd(!success)),
  );
  return (
    <View
      onLayout={(event) => props.handlers.onHeight(props.itemKey, event.nativeEvent.layout.height)}
      className={cn("flex-row items-center", lifted && "rounded-xl border border-border bg-subtle")}
      style={
        lifted ? { zIndex: 10, transform: [{ translateY: props.liftOffset ?? 0 }] } : undefined
      }
    >
      <View className="min-w-0 flex-1" pointerEvents={props.interactive ? "auto" : "none"}>
        {props.children}
      </View>
      <GestureDetector gesture={gesture}>
        <View
          collapsable={false}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={`Reorder ${props.label}`}
          style={{
            width: 48,
            alignSelf: "stretch",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <SymbolView
            name="line.3.horizontal"
            size={20}
            tintColorClassName="accent-foreground-muted"
          />
        </View>
      </GestureDetector>
    </View>
  );
}
