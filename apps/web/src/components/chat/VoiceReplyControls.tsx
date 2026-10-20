import { SquareIcon, Volume2Icon, VolumeOffIcon } from "lucide-react";
import type { PointerEvent } from "react";

import { replySpeaker } from "~/speech/replySpeaker";
import { useReplySpeaking } from "~/speech/voiceMode";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const keepComposerFocus = (event: PointerEvent) => event.preventDefault();

/**
 * What voice mode needs that is missing, as a hint naming where to turn it on;
 * null when dictation and spoken replies are both ready.
 */
export function voiceUnavailableReason(input: {
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
 * Voice controls for a thread's composer: a switch for reading replies
 * aloud, plus a stop button while it talks. While it is on, the mic and the
 * hold shortcut send what you say. Disabled, with a hint, while either half cannot work.
 */
export function VoiceReplyControls(props: {
  readonly voiceMode: boolean;
  readonly onVoiceModeChange: (voiceMode: boolean) => void;
  readonly unavailableReason: string | null;
}) {
  const speaking = useReplySpeaking();
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
                onClick={() => replySpeaker.stop()}
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
            <Toggle
              variant="ghost"
              size="sm"
              pressed={false}
              disabled
              aria-label="Read replies aloud"
            >
              <VolumeOffIcon />
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
                  if (pressed) replySpeaker.prime();
                  props.onVoiceModeChange(pressed);
                }}
                aria-label="Read replies aloud"
              />
            }
          >
            {props.voiceMode ? <Volume2Icon /> : <VolumeOffIcon />}
          </TooltipTrigger>
          <TooltipPopup>
            {props.voiceMode
              ? "Reading replies aloud, and the mic sends what you say. Click to turn off."
              : "Read replies aloud, and send what you say into the mic."}
          </TooltipPopup>
        </Tooltip>
      )}
    </>
  );
}
