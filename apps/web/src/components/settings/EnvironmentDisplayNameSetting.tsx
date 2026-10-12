import { useRef } from "react";
import { AuthSettingsWriteScope, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { Input } from "../ui/input";
import { SettingsRow, SettingResetButton } from "./settingsLayout";

/**
 * The name every device shows for this environment. Empty means each device
 * shows the label it saved for its connection.
 */
export function EnvironmentDisplayNameSetting({
  environmentId,
  serverConfig,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: ServerConfig | null;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const edited = useRef(false);
  // Older servers drop the key on write, so they cannot keep a name.
  if (serverConfig?.environment.capabilities.environmentLabel !== true) return null;
  const current = serverConfig.settings.environmentLabel;

  return (
    <SettingsRow
      title="Display name"
      description="What Ctrl calls this machine on every device. Leave empty to use the name each device saved for it."
      resetAction={
        current !== null ? (
          <SettingResetButton
            label="display name"
            onClick={() => updateSettings({ environmentLabel: null })}
          />
        ) : null
      }
      control={
        <Input
          key={current ?? ""}
          aria-label="Display name"
          maxLength={64}
          disabled={!canWrite}
          placeholder="Not set"
          defaultValue={current ?? ""}
          onChange={() => {
            edited.current = true;
          }}
          onBlur={(event) => {
            const value = event.target.value.trim();
            // A typed name is kept even when it matches the computer's name:
            // devices fall back to the label they saved, not to that name.
            const next = value === "" ? null : value;
            if (edited.current && next !== current) updateSettings({ environmentLabel: next });
            edited.current = false;
          }}
        />
      }
    />
  );
}
