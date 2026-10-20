import { AudioLinesIcon, SquareIcon } from "lucide-react";
import type { PointerEvent } from "react";

import { shiftSpeaker } from "~/speech/shiftSpeaker";
import { useShiftSpeaking } from "~/speech/voiceMode";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const keepComposerFocus = (event: PointerEvent) => event.preventDefault();

/**
 * What voice mode needs that is missing, as a hint naming where to turn it on;
 * null when dictation and spoken replies are both ready.
 */
export function shiftVoiceUnavailableReason(input: {
  readonly dictationReady: boolean;
  readonly spokenRepliesReady: boolean;
}): string | null {
  if (!input.dictationReady && !input.spokenRepliesReady)
    return "Turn on Dictation and Spoken replies in Settings → Integrations";
  if (!input.dictationReady) return "Turn on Dictation in Settings → Integrations";
  if (!input.spokenRepliesReady) return "Turn on Spoken replies in Settings → Integrations";
  return null;
}

/**
 * Voice mode for Shift's composer: a toggle that makes dictation send right
 * away and has Shift's replies read aloud, plus a stop button while it talks.
 * The toggle is disabled, with a hint, while either half cannot work.
 */
export function ShiftVoiceControls(props: {
  readonly voiceMode: boolean;
  readonly onVoiceModeChange: (voiceMode: boolean) => void;
  readonly unavailableReason: string | null;
}) {
  const speaking = useShiftSpeaking();
  return (
    <>
      {speaking ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onPointerDown={keepComposerFocus}
                onClick={() => shiftSpeaker.stop()}
                aria-label="Stop speaking"
              />
            }
          >
            <SquareIcon />
          </TooltipTrigger>
          <TooltipPopup>Stop speaking</TooltipPopup>
        </Tooltip>
      ) : null}
      {props.unavailableReason ? (
        <Tooltip>
          {/* A disabled button gets no pointer events, so a wrapper carries the hint. */}
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Toggle variant="ghost" size="sm" pressed={false} disabled aria-label="Voice mode">
              <AudioLinesIcon />
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup>{props.unavailableReason}</TooltipPopup>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                variant="ghost"
                size="sm"
                pressed={props.voiceMode}
                onPointerDown={keepComposerFocus}
                onPressedChange={(pressed) => {
                  // The click is the gesture that lets audio start later.
                  if (pressed) shiftSpeaker.prime();
                  props.onVoiceModeChange(pressed);
                }}
                aria-label="Voice mode"
              />
            }
          >
            <AudioLinesIcon />
          </TooltipTrigger>
          <TooltipPopup>
            {props.voiceMode
              ? "Voice mode on: dictation sends, replies are read aloud"
              : "Voice mode: send dictation right away and hear replies"}
          </TooltipPopup>
        </Tooltip>
      )}
    </>
  );
}
