import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
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
 * A list row Edit mode can arrange. With `handlers` set, the row itself stops
 * taking touches and a drag handle on the right moves it among its siblings
 * (a project's groups or threads, a group's chats, or Pinned). The wrapper
 * renders in both modes so Edit adds a handle instead of remounting the row.
 */
export function HomeArrangeRow(props: {
  readonly itemKey: string;
  readonly label: string;
  /** Present in Edit mode. */
  readonly handlers?: ArrangeDragHandlers;
  /** Set while this row is lifted: its offset from its current slot. */
  readonly liftOffset?: number;
  /** Keep the row tappable, as a group row must open to reach its chats. */
  readonly interactive?: boolean;
  readonly children: ReactNode;
}) {
  const arranging = props.handlers !== undefined;
  const lifted = props.liftOffset !== undefined;
  // Gesture callbacks fire outside render, so effect events give them the
  // latest props while the gesture object itself stays stable.
  const onStart = useEffectEvent(() => props.handlers?.onStart(props.itemKey));
  const onMove = useEffectEvent((translation: number) => props.handlers?.onMove(translation));
  const onEnd = useEffectEvent((cancelled: boolean) => props.handlers?.onEnd(cancelled));
  const [gesture] = useState(() =>
    Gesture.Pan()
      .minDistance(0)
      .shouldCancelWhenOutside(false)
      .runOnJS(true)
      .onStart(() => onStart())
      .onUpdate((event) => onMove(event.translationY))
      .onFinalize((_event, success) => onEnd(!success)),
  );
  // onLayout fires only on a size change, so a recycled cell, or one entering
  // Edit mode, reports the height it already has.
  const height = useRef<number | null>(null);
  const reportHeight = useEffectEvent((itemKey: string) => {
    if (height.current !== null) props.handlers?.onHeight(itemKey, height.current);
  });
  const { itemKey } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a recycled cell gets a new row, and Edit mode starts, without a native layout event
  useEffect(() => {
    if (arranging) reportHeight(itemKey);
  }, [arranging, itemKey]);
  return (
    <View
      onLayout={(event) => {
        height.current = event.nativeEvent.layout.height;
        props.handlers?.onHeight(props.itemKey, height.current);
      }}
      className={cn("flex-row items-center", lifted && "rounded-xl border border-border bg-subtle")}
      style={
        lifted ? { zIndex: 10, transform: [{ translateY: props.liftOffset ?? 0 }] } : undefined
      }
    >
      <View
        className="min-w-0 flex-1"
        pointerEvents={arranging && !props.interactive ? "none" : "auto"}
      >
        {props.children}
      </View>
      {arranging ? (
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
      ) : null}
    </View>
  );
}
