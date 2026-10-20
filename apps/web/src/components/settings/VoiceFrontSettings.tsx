import { RegistryContext } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_VOICE_FRONT_ENDPOINT,
  DEFAULT_VOICE_FRONT_MODEL,
  type EnvironmentId,
  type VoiceFrontStatus,
} from "@t3tools/contracts";
import { use, useEffect, useRef, useState } from "react";

import { formatBytes } from "~/lib/formatBytes";
import { cn } from "~/lib/utils";
import { speechEnvironment } from "~/state/speech";
import { Input } from "../ui/input";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/**
 * The front voice's switch, model, and endpoint, under Spoken replies. Its
 * status asks the environment whether LM Studio and the model are usable,
 * which never starts or loads anything.
 */
export function VoiceFrontSettings(props: {
  readonly environmentId: EnvironmentId | null;
  readonly locked: boolean;
}) {
  const settings = useScopedSettings((unified) => unified.voiceFront);
  const updateSettings = useUpdateScopedSettings();
  const modelEdited = useRef(false);
  const endpointEdited = useRef(false);
  return (
    <>
      <SettingsRow
        {...searchableSetting("voice-front")}
        serverScoped
        settingKeys={["voiceFront"]}
        description="In voice mode, a small local model in LM Studio answers each turn right away while the agent works on it. Ctrl only asks for the model below, refuses models over 6 GB, and LM Studio unloads it after 10 idle minutes."
        status={
          settings.enabled && props.environmentId !== null ? (
            <VoiceFrontStatusLine
              // Asked again whenever the model or endpoint changes.
              key={`${settings.model}|${settings.endpoint}`}
              environmentId={props.environmentId}
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["voiceFront"]}
            checked={settings.enabled}
            disabled={props.locked}
            aria-label="Fast front voice"
            onCheckedChange={(checked) => updateSettings({ voiceFront: { enabled: checked } })}
          />
        }
      />
      {settings.enabled ? (
        <>
          <SettingsRow
            {...searchableSetting("voice-front-model")}
            serverScoped
            settingKeys={["voiceFront"]}
            description="LM Studio's model key, as lms ls shows it. Download it with lms get."
            resetAction={
              settings.model !== DEFAULT_VOICE_FRONT_MODEL ? (
                <SettingResetButton
                  label="front model"
                  onClick={() =>
                    updateSettings({ voiceFront: { model: DEFAULT_VOICE_FRONT_MODEL } })
                  }
                />
              ) : null
            }
            control={
              <Input
                key={settings.model}
                aria-label="Front model"
                autoCapitalize="none"
                spellCheck={false}
                disabled={props.locked}
                defaultValue={settings.model}
                onChange={() => {
                  modelEdited.current = true;
                }}
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  if (modelEdited.current && value && value !== settings.model)
                    updateSettings({ voiceFront: { model: value } });
                  modelEdited.current = false;
                }}
              />
            }
          />
          <SettingsRow
            {...searchableSetting("voice-front-endpoint")}
            serverScoped
            settingKeys={["voiceFront"]}
            description="LM Studio's local server. Ctrl starts it with lms server start when it is not running."
            resetAction={
              settings.endpoint !== DEFAULT_VOICE_FRONT_ENDPOINT ? (
                <SettingResetButton
                  label="LM Studio endpoint"
                  onClick={() =>
                    updateSettings({ voiceFront: { endpoint: DEFAULT_VOICE_FRONT_ENDPOINT } })
                  }
                />
              ) : null
            }
            control={
              <Input
                key={settings.endpoint}
                aria-label="LM Studio endpoint"
                autoCapitalize="none"
                spellCheck={false}
                disabled={props.locked}
                defaultValue={settings.endpoint}
                onChange={() => {
                  endpointEdited.current = true;
                }}
                onBlur={(event) => {
                  const value = event.target.value.trim().replace(/\/+$/, "");
                  if (endpointEdited.current && value && value !== settings.endpoint)
                    updateSettings({ voiceFront: { endpoint: value } });
                  endpointEdited.current = false;
                }}
              />
            }
          />
        </>
      ) : null}
    </>
  );
}

function VoiceFrontStatusLine(props: { readonly environmentId: EnvironmentId }) {
  const registry = use(RegistryContext);
  const [status, setStatus] = useState<VoiceFrontStatus | "unavailable" | null>(null);
  const { environmentId } = props;
  useEffect(() => {
    let current = true;
    void runAtomCommand(
      registry,
      speechEnvironment.frontStatus,
      { environmentId, input: {} },
      { reportFailure: false },
    ).then((result) => {
      if (current) setStatus(result._tag === "Success" ? result.value : "unavailable");
    });
    return () => {
      current = false;
    };
  }, [registry, environmentId]);
  if (status === null) return null;
  const problem =
    status === "unavailable"
      ? "Update Ctrl on this machine to use the front voice."
      : status.problem;
  const label =
    problem ??
    (status !== "unavailable" && status.modelBytes !== null
      ? `Ready · ${formatBytes(status.modelBytes)}`
      : "LM Studio starts on the next voice turn");
  return (
    <span className={cn("text-xs", problem ? "text-destructive" : "text-muted-foreground")}>
      {label}
    </span>
  );
}
