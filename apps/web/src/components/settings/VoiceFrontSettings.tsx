import { RegistryContext } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_GEMINI_LIVE_MODEL,
  DEFAULT_VOICE_FRONT_ENDPOINT,
  DEFAULT_VOICE_FRONT_MODEL,
  DEFAULT_VOICE_FRONT_MONTHLY_CAP_USD,
  type EnvironmentId,
  GEMINI_LIVE_MODELS,
  MAX_VOICE_FRONT_MONTHLY_CAP_USD,
  type VoiceFrontEngine,
  type VoiceFrontStatus,
} from "@t3tools/contracts";
import { use, useEffect, useRef, useState } from "react";

import { formatBytes } from "~/lib/formatBytes";
import { cn } from "~/lib/utils";
import { speechEnvironment } from "~/state/speech";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const ENGINES: ReadonlyArray<{ readonly value: VoiceFrontEngine; readonly label: string }> = [
  { value: "local", label: "Local (LM Studio)" },
  { value: "gemini", label: "Gemini Live" },
];

const GEMINI_MODEL_LABELS: Record<(typeof GEMINI_LIVE_MODELS)[number], string> = {
  "gemini-3.1-flash-live-preview": "3.1 Flash Live",
  "gemini-3.8-live": "3.8 Live",
};
const GEMINI_MODELS = GEMINI_LIVE_MODELS.map((value) => ({
  value,
  label: GEMINI_MODEL_LABELS[value],
}));

const usd = (value: number) => `$${value.toFixed(2)}`;

/**
 * The front voice's switch, engine, and each engine's options, under Spoken
 * replies. Its status asks the environment whether LM Studio and the model
 * are usable, which never starts or loads anything, and for Gemini whether a
 * key is stored and what this month cost.
 */
export function VoiceFrontSettings(props: {
  readonly environmentId: EnvironmentId | null;
  readonly locked: boolean;
}) {
  const settings = useScopedSettings((unified) => unified.voiceFront);
  const updateSettings = useUpdateScopedSettings();
  const modelEdited = useRef(false);
  const endpointEdited = useRef(false);
  const capEdited = useRef(false);
  /** Bumped after the key changes, so the status is asked again. */
  const [statusVersion, setStatusVersion] = useState(0);
  const status = useVoiceFrontStatus(
    settings.enabled ? props.environmentId : null,
    `${settings.engine}|${settings.model}|${settings.endpoint}|${settings.monthlyCapUsd}|${statusVersion}`,
  );
  const gemini = settings.engine === "gemini";
  return (
    <>
      <SettingsRow
        {...searchableSetting("voice-front")}
        serverScoped
        settingKeys={["voiceFront"]}
        description="In voice mode, a fast front voice answers each turn right away while the agent works on it: a small local model in LM Studio, or Gemini Live. Ctrl only asks LM Studio for the model below, refuses models over 6 GB, and LM Studio unloads it after 10 idle minutes."
        status={settings.enabled && !gemini ? <LocalStatusLine status={status} /> : null}
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
            {...searchableSetting("voice-front-engine")}
            serverScoped
            settingKeys={["voiceFront"]}
            description="Gemini Live hears you as you talk and answers in its own voice, through Google. The local model stays the fallback: it answers whenever Gemini cannot, such as past the monthly limit."
            control={
              <Select
                items={ENGINES}
                value={settings.engine}
                disabled={props.locked}
                onValueChange={(value) => {
                  if (value) updateSettings({ voiceFront: { engine: value } });
                }}
              >
                <SelectTrigger size="xs" className="w-40" aria-label="Front voice engine">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {ENGINES.map((engine) => (
                    <SelectItem key={engine.value} value={engine.value}>
                      {engine.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          {gemini ? (
            <>
              <SettingsRow
                {...searchableSetting("voice-front-gemini-key")}
                serverScoped
                settingKeys={["voiceFront"]}
                description="From Google AI Studio. It is stored on this machine and never sent back to any client. A free-tier key works, but Google may use free-tier audio to improve its products; a paid key keeps it out."
                status={<GeminiStatusLine status={status} />}
                control={
                  <GeminiKeyControl
                    environmentId={props.environmentId}
                    disabled={props.locked}
                    keySet={status !== "unavailable" && status?.gemini?.keySet === true}
                    onChanged={() => setStatusVersion((version) => version + 1)}
                  />
                }
              />
              <SettingsRow
                {...searchableSetting("voice-front-gemini-model")}
                serverScoped
                settingKeys={["voiceFront"]}
                description="3.1 Flash Live is the default. 3.8 Live costs the same and can keep talking while it hands work to the agent."
                resetAction={
                  settings.geminiModel !== DEFAULT_GEMINI_LIVE_MODEL ? (
                    <SettingResetButton
                      label="Gemini model"
                      onClick={() =>
                        updateSettings({ voiceFront: { geminiModel: DEFAULT_GEMINI_LIVE_MODEL } })
                      }
                    />
                  ) : null
                }
                control={
                  <Select
                    items={GEMINI_MODELS}
                    value={settings.geminiModel}
                    disabled={props.locked}
                    onValueChange={(value) => {
                      if (value) updateSettings({ voiceFront: { geminiModel: value } });
                    }}
                  >
                    <SelectTrigger size="xs" className="w-40" aria-label="Gemini model">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {GEMINI_MODELS.map((model) => (
                        <SelectItem key={model.value} value={model.value}>
                          {model.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                }
              />
              <SettingsRow
                {...searchableSetting("voice-front-gemini-cap")}
                serverScoped
                settingKeys={["voiceFront"]}
                description="Gemini stops for the rest of the month once its metered cost reaches this, in US dollars, and the local voice answers instead. Ctrl sends only your speech, so a typical month costs a few dollars."
                resetAction={
                  settings.monthlyCapUsd !== DEFAULT_VOICE_FRONT_MONTHLY_CAP_USD ? (
                    <SettingResetButton
                      label="Gemini monthly limit"
                      onClick={() =>
                        updateSettings({
                          voiceFront: { monthlyCapUsd: DEFAULT_VOICE_FRONT_MONTHLY_CAP_USD },
                        })
                      }
                    />
                  ) : null
                }
                control={
                  <Input
                    key={settings.monthlyCapUsd}
                    aria-label="Gemini monthly limit in US dollars"
                    className="w-24"
                    inputMode="decimal"
                    disabled={props.locked}
                    defaultValue={String(settings.monthlyCapUsd)}
                    onChange={() => {
                      capEdited.current = true;
                    }}
                    onBlur={(event) => {
                      const value = Number(event.target.value.trim().replace(/^\$/, ""));
                      if (
                        capEdited.current &&
                        Number.isFinite(value) &&
                        value >= 0 &&
                        value <= MAX_VOICE_FRONT_MONTHLY_CAP_USD &&
                        value !== settings.monthlyCapUsd
                      )
                        updateSettings({ voiceFront: { monthlyCapUsd: value } });
                      capEdited.current = false;
                    }}
                  />
                }
              />
            </>
          ) : null}
          <SettingsRow
            {...searchableSetting("voice-front-model")}
            serverScoped
            settingKeys={["voiceFront"]}
            description="LM Studio's model key, as lms ls shows it. Download it with lms get."
            status={gemini ? <LocalStatusLine status={status} /> : null}
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

type StatusResult = VoiceFrontStatus | "unavailable" | null;

/** The environment's front voice status, asked again whenever `key` changes. */
function useVoiceFrontStatus(environmentId: EnvironmentId | null, key: string): StatusResult {
  const registry = use(RegistryContext);
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly status: StatusResult }>({
    key: "",
    status: null,
  });
  useEffect(() => {
    if (environmentId === null) return;
    let current = true;
    void runAtomCommand(
      registry,
      speechEnvironment.frontStatus,
      { environmentId, input: {} },
      { reportFailure: false },
    ).then((result) => {
      if (current)
        setLoaded({ key, status: result._tag === "Success" ? result.value : "unavailable" });
    });
    return () => {
      current = false;
    };
  }, [registry, environmentId, key]);
  // A status asked for other settings is stale.
  return environmentId === null || loaded.key !== key ? null : loaded.status;
}

function LocalStatusLine(props: { readonly status: StatusResult }) {
  const { status } = props;
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

function GeminiStatusLine(props: { readonly status: StatusResult }) {
  const { status } = props;
  if (status === null) return null;
  const gemini = status === "unavailable" ? undefined : status.gemini;
  if (!gemini)
    return (
      <span className="text-xs text-destructive">Update Ctrl on this machine to use Gemini.</span>
    );
  const spend = `${usd(gemini.monthSpendUsd)} of ${usd(gemini.monthlyCapUsd)} this month`;
  const label = !gemini.keySet
    ? "No key set"
    : gemini.capped
      ? `Limit reached · ${spend}`
      : gemini.problem
        ? `${gemini.problem} · ${spend}`
        : `Key set · ${spend}`;
  const failed = !gemini.keySet || gemini.capped || gemini.problem !== null;
  return (
    <span className={cn("text-xs", failed ? "text-destructive" : "text-muted-foreground")}>
      {label}
    </span>
  );
}

/** Saves or removes the key. The field never shows a stored key, only whether one is set. */
function GeminiKeyControl(props: {
  readonly environmentId: EnvironmentId | null;
  readonly disabled: boolean;
  readonly keySet: boolean;
  readonly onChanged: () => void;
}) {
  const registry = use(RegistryContext);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const { environmentId } = props;
  const save = (key: string | null) => {
    if (environmentId === null) return;
    setSaving(true);
    void runAtomCommand(
      registry,
      speechEnvironment.setGeminiKey,
      { environmentId, input: { key } },
      { reportFailure: false },
    ).then((result) => {
      setSaving(false);
      if (result._tag === "Failure") {
        toastManager.add({ type: "error", title: "Could not save the Gemini key." });
        return;
      }
      setDraft("");
      props.onChanged();
    });
  };
  const disabled = props.disabled || environmentId === null || saving;
  return (
    <span className="flex items-center gap-1">
      <Input
        type="password"
        aria-label="Gemini API key"
        autoComplete="off"
        spellCheck={false}
        className="w-40"
        placeholder={props.keySet ? "Key set" : "Paste key"}
        disabled={disabled}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && draft.trim()) save(draft.trim());
        }}
      />
      {draft.trim() ? (
        <Button size="xs" variant="outline" disabled={disabled} onClick={() => save(draft.trim())}>
          Save
        </Button>
      ) : props.keySet ? (
        <Button size="xs" variant="ghost" disabled={disabled} onClick={() => save(null)}>
          Remove
        </Button>
      ) : null}
    </span>
  );
}
