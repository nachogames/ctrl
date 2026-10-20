import { AudioLinesIcon, MicIcon } from "lucide-react";
import type { PointerEvent } from "react";

import type { ComposerDictation } from "~/dictation/useComposerDictation";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerDictationActivity } from "./ComposerDictationActivity";

const keepComposerFocus = (event: PointerEvent) => event.preventDefault();

/**
 * Dictation in the composer footer. Idle it is a mic button that starts
 * dictation, or opens Dictation settings when no environment can transcribe.
 * Starting grows the same control in place: the button stays put and becomes
 * stop, while cancel, the waveform, and the timer unfold to its left inside a
 * pill. Ending folds them back. The unfold is a one-shot grid transition; the
 * only per-frame work is the waveform while the microphone is live.
 */
export function ComposerDictationControl(props: {
  readonly dictation: ComposerDictation;
  readonly disabled: boolean;
  readonly shortcutLabel: string | null;
  /** Replaces the idle button's start and label, as voice mode does to start a conversation. */
  readonly talk?: { readonly label: string; readonly start: () => void };
  /**
   * A hands-free conversation is running. Cancel and the idle button end it;
   * stop sends what was said and ends it too.
   */
  readonly conversation?: {
    /** Waiting for a reply; the microphone is closed. */
    readonly waiting: boolean;
    readonly end: () => void;
    readonly finish: () => void;
  } | null;
}) {
  const { dictation, conversation } = props;
  const phase = dictation.state.phase;
  const active = phase === "preparing" || phase === "recording" || phase === "transcribing";
  const label =
    dictation.environmentId === null ? "Set up dictation" : (props.talk?.label ?? "Dictate");

  return (
    <div
      role="group"
      aria-label="Dictation"
      data-active={active ? "" : undefined}
      className="group flex h-8 items-center rounded-full border border-transparent transition-[border-color] duration-200 ease-out data-active:border-border motion-reduce:transition-none"
    >
      <div
        className="grid grid-cols-[0fr] transition-[grid-template-columns] duration-200 ease-out group-data-active:grid-cols-[1fr] motion-reduce:transition-none"
        inert={!active}
      >
        <div className="min-w-0 overflow-hidden">
          <ComposerDictationActivity
            phase={phase}
            level={dictation.level}
            onCancel={conversation?.end ?? dictation.cancel}
          />
        </div>
      </div>
      {active ? (
        <button
          type="button"
          disabled={phase !== "recording"}
          onPointerDown={keepComposerFocus}
          onClick={conversation?.finish ?? dictation.stop}
          aria-label={
            phase !== "recording"
              ? "Transcribing"
              : conversation
                ? "Send and end the conversation"
                : "Stop and insert dictation"
          }
          className="mr-0.5 grid size-7 place-items-center rounded-full bg-primary text-primary-foreground transition-[opacity,scale] duration-200 ease-out starting:scale-50 starting:opacity-0 disabled:opacity-45 motion-reduce:transition-none"
        >
          <span className="size-2.5 rounded-xs bg-current" />
        </button>
      ) : conversation?.waiting ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="secondary"
                size="icon-sm"
                onPointerDown={keepComposerFocus}
                onClick={conversation.end}
                aria-label="End the conversation"
              />
            }
          >
            <AudioLinesIcon />
          </TooltipTrigger>
          <TooltipPopup>
            Listening again once the reply is read. Click to end the conversation.
          </TooltipPopup>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={props.disabled}
                onPointerDown={keepComposerFocus}
                onClick={props.talk?.start ?? dictation.start}
                aria-label={label}
              />
            }
          >
            <MicIcon />
          </TooltipTrigger>
          <TooltipPopup>
            {props.shortcutLabel && dictation.environmentId !== null
              ? `${label} (hold ${props.shortcutLabel})`
              : label}
          </TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}
