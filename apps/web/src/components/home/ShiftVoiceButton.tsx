import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { AudioLinesIcon, MicIcon, MicOffIcon, PhoneOffIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";
import { useOneClickVoice, type OneClickVoicePhase } from "../../voice/useOneClickVoice";
import { resolveThreadVoiceAvailability } from "../../voice/voiceAvailability";
import { voiceMode } from "../../voice/voiceMode";
import { LevelMeter, useVoiceMeters, voiceStripStatus } from "../chat/VoiceModeStrip";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const NO_PROVIDERS: never[] = [];

export interface ShiftVoice {
  /** False when Shift's provider has no voice; only Codex voice runs without a composer. */
  readonly offered: boolean;
  readonly phase: OneClickVoicePhase;
  readonly toggle: () => void;
}

/** Voice with Shift from its sidebar row, without opening the chat. */
export function useShiftVoice(threadRef: ScopedThreadRef): ShiftVoice {
  const thread = useThreadShell(threadRef);
  const providers = useAtomValue(
    environmentPresentations.providersByEnvironmentAtom,
    (byEnvironment) => byEnvironment.get(threadRef.environmentId) ?? NO_PROVIDERS,
  );
  const availability =
    thread === null
      ? ({ kind: "unsupported" } as const)
      : resolveThreadVoiceAvailability(thread, providers);
  const { phase, toggle } = useOneClickVoice(threadRef, availability);
  return { offered: availability.kind !== "unsupported" || phase !== "idle", phase, toggle };
}

/** Starts a conversation from the row; once one runs, the strip below holds its controls. */
export function ShiftVoiceButton(props: { readonly voice: ShiftVoice }) {
  const { voice } = props;
  if (!voice.offered || voice.phase !== "idle") return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Talk to Shift"
            // The row opens Shift on click and Enter; the button must not.
            onClick={(event) => {
              event.stopPropagation();
              voice.toggle();
            }}
            onKeyDown={(event) => event.stopPropagation()}
          />
        }
      >
        <AudioLinesIcon aria-hidden />
      </TooltipTrigger>
      <TooltipPopup>Talk to Shift</TooltipPopup>
    </Tooltip>
  );
}

/** The live conversation under Shift's row: what it is doing, mic and voice meters, mute, end. */
export function ShiftVoiceStrip(props: { readonly voice: ShiftVoice }) {
  const { voice } = props;
  const state = useSyncExternalStore(voiceMode.subscribe, voiceMode.getState, voiceMode.getState);
  const active = voice.phase === "active";
  const meters = useVoiceMeters(voiceMode, active, state.muted);
  if (voice.phase === "idle") return null;

  const status = voiceStripStatus({ active, speaking: meters.speaking, muted: state.muted });
  const muteLabel = state.muted ? "Unmute" : "Mute";
  return (
    <div
      role="group"
      aria-label="Voice conversation with Shift"
      data-testid="sidebar-shift-voice"
      className="mx-1 mt-0.5 mb-1 flex h-8 items-center gap-2 rounded-md border border-border/70 ps-2.5 pe-1 text-xs"
    >
      {active ? (
        <AudioLinesIcon aria-hidden className="size-3.5 shrink-0 text-info" />
      ) : (
        <Spinner aria-hidden className="size-3.5 shrink-0" />
      )}
      <span
        role="status"
        className={cn(
          "min-w-0 flex-1 truncate font-medium",
          meters.speaking ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {status}
      </span>
      {active ? (
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          <span className="flex items-center gap-0.5">
            {state.muted ? (
              <MicOffIcon aria-hidden className="size-3" />
            ) : (
              <MicIcon aria-hidden className="size-3" />
            )}
            <LevelMeter
              meterRef={meters.microphoneMeterRef}
              label="Microphone level"
              staticLevel={meters.staticMicrophoneLevel}
            />
          </span>
          <LevelMeter
            meterRef={meters.speakerMeterRef}
            label="Shift's voice level"
            staticLevel={meters.staticSpeakerLevel}
          />
        </span>
      ) : null}
      {active ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={muteLabel}
                aria-pressed={state.muted}
                onClick={() => voiceMode.toggleMuted()}
              />
            }
          >
            {state.muted ? <MicOffIcon aria-hidden /> : <MicIcon aria-hidden />}
          </TooltipTrigger>
          <TooltipPopup>{muteLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-destructive"
              aria-label={active ? "End voice" : "Cancel voice"}
              onClick={voice.toggle}
            />
          }
        >
          <PhoneOffIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup>{active ? "End voice" : "Cancel"}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
