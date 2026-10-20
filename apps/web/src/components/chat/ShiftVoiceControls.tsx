import { AudioLinesIcon, SquareIcon } from "lucide-react";
import type { PointerEvent } from "react";

import { shiftSpeaker } from "~/speech/shiftSpeaker";
import { useShiftSpeaking } from "~/speech/voiceMode";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const keepComposerFocus = (event: PointerEvent) => event.preventDefault();

/**
 * Voice mode for Shift's composer: a toggle that makes dictation send right
 * away and has Shift's replies read aloud, plus a stop button while it talks.
 */
export function ShiftVoiceControls(props: {
  readonly voiceMode: boolean;
  readonly onVoiceModeChange: (voiceMode: boolean) => void;
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
    </>
  );
}
