import { Button, HStack, Image, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  activityBackgroundTint,
  buttonStyle,
  controlSize,
  font,
  foregroundStyle,
  frame,
  labelStyle,
  lineLimit,
  monospacedDigit,
  padding,
  resizable,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import {
  createLiveActivity,
  type LiveActivityComponent,
  type LiveActivityLayout,
} from "expo-widgets";

type LiveActivityEnvironment = Parameters<LiveActivityComponent<VoiceCallActivityProps>>[1];

export interface VoiceCallActivityProps {
  /** Who the call is with, such as "Shift" or the thread's title. */
  readonly caller: string;
  readonly status: string;
  readonly muted: boolean;
  /** When the call started, in epoch milliseconds, for the call timer. */
  readonly startedAt: number;
}

/** The button the app receives through `addUserInteractionListener`; literals in the widget, which drops module constants. */
export type VoiceCallActivityTarget = "end" | "mute";

// Widget serialization excludes module helpers; use only imported view/modifier factories.
function VoiceCallActivity(
  props: VoiceCallActivityProps,
  environment: LiveActivityEnvironment,
): LiveActivityLayout {
  "widget";

  const primaryForeground = { type: "hierarchical", style: "primary" } as const;
  const secondaryForeground = { type: "hierarchical", style: "secondary" } as const;
  const callTint = environment.isLuminanceReduced ? secondaryForeground : "#34c759";
  const started = new Date(props.startedAt);

  const renderWaveform = (size: number) => (
    <HStack modifiers={[frame({ width: size, height: size }), foregroundStyle(callTint)]}>
      <Image systemName="waveform" modifiers={[resizable()]} />
    </HStack>
  );

  const renderTimer = (size: number) => (
    <Text
      date={started}
      dateStyle="timer"
      modifiers={[
        font({ weight: "semibold", size }),
        monospacedDigit(),
        foregroundStyle(callTint),
        lineLimit(1),
        frame({ width: size * 3.4, alignment: "trailing" }),
      ]}
    />
  );

  const renderButtons = () => (
    <HStack spacing={10}>
      <Button
        target="mute"
        label={props.muted ? "Unmute" : "Mute"}
        systemImage={props.muted ? "mic.fill" : "mic.slash.fill"}
        modifiers={[buttonStyle("bordered"), controlSize("large"), labelStyle("iconOnly")]}
      />
      <Button
        target="end"
        label="End"
        systemImage="phone.down.fill"
        modifiers={[
          buttonStyle("borderedProminent"),
          controlSize("large"),
          tint("#ff3b30"),
          labelStyle("iconOnly"),
        ]}
      />
    </HStack>
  );

  const renderHeading = () => (
    <VStack alignment="leading" spacing={2}>
      <Text
        modifiers={[
          font({ weight: "semibold", size: 15 }),
          foregroundStyle(primaryForeground),
          lineLimit(1),
        ]}
      >
        {props.caller}
      </Text>
      <Text modifiers={[font({ size: 13 }), foregroundStyle(secondaryForeground), lineLimit(1)]}>
        {props.status}
      </Text>
    </VStack>
  );

  return {
    banner: (
      <HStack
        spacing={12}
        alignment="center"
        modifiers={[
          padding({ all: 14 }),
          // A clear tint reveals iOS 26's glass material; older hosts keep the standard surface.
          activityBackgroundTint(environment.isLiquidGlassAvailable ? "clear" : null),
        ]}
      >
        {renderWaveform(22)}
        {renderHeading()}
        <Spacer minLength={8} />
        {renderTimer(15)}
        {renderButtons()}
      </HStack>
    ),
    compactLeading: renderWaveform(14),
    compactTrailing: renderTimer(12),
    minimal: renderWaveform(13),
    expandedLeading: (
      <HStack spacing={8} alignment="center" modifiers={[padding({ leading: 4, vertical: 4 })]}>
        {renderWaveform(18)}
        {renderHeading()}
      </HStack>
    ),
    expandedTrailing: (
      <HStack modifiers={[padding({ trailing: 4, vertical: 4 })]}>{renderTimer(15)}</HStack>
    ),
    expandedBottom: (
      <HStack modifiers={[padding({ horizontal: 8, vertical: 4 })]}>
        <Spacer minLength={0} />
        {renderButtons()}
      </HStack>
    ),
  };
}

export default createLiveActivity<VoiceCallActivityProps>("VoiceCallActivity", VoiceCallActivity);
