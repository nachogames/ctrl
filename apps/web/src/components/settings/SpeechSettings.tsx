import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type DictationInstallState,
  type EnvironmentId,
  type SpeechState,
} from "@t3tools/contracts";
import { PlayIcon, SquareIcon } from "lucide-react";
import { use, useEffect, useState } from "react";

import { formatBytes } from "~/lib/formatBytes";
import { useVoicePreviewPlaying, voicePreview } from "~/speech/voicePreview";
import { cn } from "~/lib/utils";
import { speechEnvironment, useSpeechState } from "~/state/speech";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { VoiceFrontSettings } from "./VoiceFrontSettings";

/** Kokoro voices, listed before the server state arrives so the picker never jumps. */
const VOICES = [
  { value: "af_heart", label: "Heart" },
  { value: "af_bella", label: "Bella" },
  { value: "af_nicole", label: "Nicole" },
  { value: "am_michael", label: "Michael" },
  { value: "am_fenrir", label: "Fenrir" },
  { value: "am_puck", label: "Puck" },
] as const;

function percent(state: Extract<DictationInstallState, { _tag: "installing" }>): string {
  return state.totalBytes > 0
    ? `${Math.floor((state.receivedBytes / state.totalBytes) * 100)}%`
    : formatBytes(state.receivedBytes);
}

function voiceStatus(state: SpeechState): { readonly label: string; readonly failed: boolean } {
  const install = state.model.install;
  if (install._tag === "failed") return { label: `Failed: ${install.message}`, failed: true };
  if (state.runtime._tag === "failed")
    return { label: `Failed: ${state.runtime.message}`, failed: true };
  if (state.runtime._tag === "installing")
    return { label: `Downloading runtime ${percent(state.runtime)}`, failed: false };
  if (install._tag === "installing")
    return { label: `Downloading ${percent(install)}`, failed: false };
  if (install._tag === "not-installed")
    return {
      label: state.settings.enabled ? "Waiting to download" : "Downloads when turned on",
      failed: false,
    };
  if (state.loaded) return { label: "Loaded", failed: false };
  return { label: state.ready ? "Ready" : "Downloaded", failed: false };
}

/**
 * Spoken replies for the environments selected in the settings header.
 * Turning them on downloads the Kokoro voice model; Shift's thread then reads
 * the start of each reply aloud in voice mode. The model can be removed while
 * spoken replies are off.
 */
export function SpeechSettingsSection() {
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  const environmentId =
    environment?.connection.phase === "connected" && environment.serverConfig !== null
      ? environment.environmentId
      : null;
  const { state, error } = useSpeechState(environmentId);
  const registry = use(RegistryContext);
  // A server from before spoken replies has no speech methods, so its subscription fails outright.
  const outdated = environmentId !== null && state === null && error !== null;
  const settings = useScopedSettings((unified) => unified.speech);
  const updateSettings = useUpdateScopedSettings();
  const canConfigure = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const unsupported = state?.supported === false || outdated;
  const locked = !canConfigure || projectScope || environmentId === null || unsupported;
  const downloadBytes = state?.model.downloadBytes;
  // Leaving settings silences a preview.
  useEffect(() => () => voicePreview.stop(), []);

  return (
    <SettingsSection id="spoken-replies" title="Spoken replies">
      <SettingsRow
        {...searchableSetting("speech-replies")}
        serverScoped
        settingKeys={["speech"]}
        description={
          outdated
            ? "Update T3 Code on this machine to use spoken replies."
            : unsupported
              ? "This environment's platform has no supported voice model."
              : `Read the start of Shift's replies aloud in voice mode with a local Kokoro voice${
                  downloadBytes ? ` (${formatBytes(downloadBytes)} download)` : ""
                }. Text is not sent to any other service.`
        }
        status={connectedEnvironments.map((target) => (
          <SpeechModelStatus
            key={target.environmentId}
            environmentId={target.environmentId}
            label={connectedEnvironments.length > 1 ? target.label : null}
          />
        ))}
        control={
          <ScopedSwitch
            settingKeys={["speech"]}
            checked={settings.enabled}
            disabled={locked}
            aria-label="Spoken replies"
            onCheckedChange={(checked) => updateSettings({ speech: { enabled: checked } })}
          />
        }
      />
      {unsupported ? null : (
        <>
          <SettingsRow
            {...searchableSetting("speech-voice")}
            serverScoped
            settingKeys={["speech"]}
            control={
              <span className="flex items-center gap-1">
                <VoicePreviewButton
                  environmentId={environmentId}
                  voice={settings.voice}
                  label={VOICES.find((voice) => voice.value === settings.voice)?.label ?? "voice"}
                  ready={state?.ready === true}
                />
                <Select
                  items={VOICES}
                  value={settings.voice}
                  disabled={locked}
                  onValueChange={(voice) => {
                    if (voice === null) return;
                    updateSettings({ speech: { voice } });
                    // Picking a voice plays its sample, so choosing is listening.
                    if (state?.ready === true && environmentId !== null) {
                      void voicePreview.play({ registry, environmentId, voice });
                    }
                  }}
                >
                  <SelectTrigger size="xs" className="w-40" aria-label="Reply voice">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {VOICES.map((voice) => (
                      <SelectItem key={voice.value} value={voice.value}>
                        {voice.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </span>
            }
          />
          <VoiceFrontSettings environmentId={environmentId} locked={locked} />
          {connectedEnvironments.map((target) => (
            <RemovableVoice
              key={target.environmentId}
              environmentId={target.environmentId}
              label={connectedEnvironments.length > 1 ? target.label : null}
            />
          ))}
        </>
      )}
    </SettingsSection>
  );
}

/**
 * Play/stop for the chosen voice's sample, next to the voice picker. Disabled until the
 * environment can synthesize, since that is when the voices are downloaded.
 */
function VoicePreviewButton(props: {
  readonly environmentId: EnvironmentId | null;
  readonly voice: (typeof VOICES)[number]["value"];
  readonly label: string;
  readonly ready: boolean;
}) {
  const registry = use(RegistryContext);
  const playing = useVoicePreviewPlaying();
  const active = playing === `${props.environmentId}:${props.voice}`;
  const environmentId = props.environmentId;
  if (!props.ready || environmentId === null) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button size="icon-xs" variant="ghost" disabled aria-label={`Preview ${props.label}`}>
            <PlayIcon />
          </Button>
        </TooltipTrigger>
        <TooltipPopup>Turn on Spoken replies to download the voices</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={active ? `Stop ${props.label}` : `Preview ${props.label}`}
      onClick={() => {
        if (active) {
          voicePreview.stop();
          return;
        }
        void voicePreview.play({ registry, environmentId, voice: props.voice }).then((played) => {
          if (!played)
            toastManager.add({ type: "error", title: `Could not preview ${props.label}` });
        });
      }}
    >
      {active ? <SquareIcon /> : <PlayIcon />}
    </Button>
  );
}

/** The voice model's status on one environment, with Retry after a failed download. */
function SpeechModelStatus(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const { state } = useSpeechState(props.environmentId);
  const canRetry = useAtomValue(speechEnvironment.install.permissionAtom(props.environmentId));
  const install = useAtomCommand(speechEnvironment.install, { reportFailure: false });
  if (!state?.supported) return null;
  const status = voiceStatus(state);
  return (
    <span className="flex items-center gap-2 text-xs">
      <span
        className={cn("tabular-nums", status.failed ? "text-destructive" : "text-muted-foreground")}
      >
        {props.label ? `${props.label}: ${status.label}` : status.label}
      </span>
      {status.failed ? (
        <Button
          size="xs"
          variant="outline"
          disabled={!canRetry}
          onClick={() =>
            void install({ environmentId: props.environmentId, input: {} }).then((result) => {
              if (result._tag === "Failure") {
                toastManager.add({ type: "error", title: "Could not retry the download" });
              }
            })
          }
        >
          Retry
        </Button>
      ) : null}
    </span>
  );
}

/** A downloaded voice on an environment where spoken replies are off, which can be removed. */
function RemovableVoice(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const { state } = useSpeechState(props.environmentId);
  const canRemove = useAtomValue(speechEnvironment.remove.permissionAtom(props.environmentId));
  const remove = useAtomCommand(speechEnvironment.remove, { reportFailure: false });
  const [removing, setRemoving] = useState(false);
  if (!state?.supported || state.settings.enabled || state.model.install._tag !== "installed")
    return null;
  const sizeBytes = state.model.install.sizeBytes;

  return (
    <SettingsRow
      title={props.label ? `Downloaded voice on ${props.label}` : "Downloaded voice"}
      description={`${state.model.label} · ${formatBytes(sizeBytes)}`}
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={!canRemove || removing}
          onClick={() => {
            setRemoving(true);
            void remove({ environmentId: props.environmentId, input: {} }).then((result) => {
              setRemoving(false);
              if (result._tag === "Failure") {
                toastManager.add({ type: "error", title: "Could not remove the voice" });
              }
            });
          }}
        >
          Remove
        </Button>
      }
    />
  );
}
