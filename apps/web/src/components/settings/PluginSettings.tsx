import { AuthSettingsWriteScope, type EnvironmentId, type PluginSummary } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";

import { useEnvironmentScope } from "~/state/session";
import { pluginEnvironment } from "~/state/plugins";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const STATE_LABELS: Record<PluginSummary["state"], string> = {
  ready: "Loaded",
  starting: "Starting",
  running: "Running",
  restarting: "Restarting after a crash",
  error: "Failed to load",
  disabled: "Off",
};

/**
 * The selected environment's local plugins. Plugins are folders an agent or
 * a person writes; this lists them, shows why one failed, and turns them on
 * or off. Turning one on runs its code on that machine.
 */
export function PluginSettings() {
  const { environment: selected } = useSettingsScope();
  const connected = selected?.connection.phase === "connected" && selected.serverConfig !== null;
  const environmentId = connected ? selected.environmentId : null;
  return <PluginSettingsSection environmentId={environmentId} />;
}

function PluginSettingsSection(props: { readonly environmentId: EnvironmentId | null }) {
  const { environmentId } = props;
  const snapshot = useEnvironmentQuery(
    environmentId === null ? null : pluginEnvironment.snapshot({ environmentId, input: {} }),
  ).data;
  const canManage = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const setEnabled = useAtomCommand(pluginEnvironment.setEnabled, "Change plugin");
  const reload = useAtomCommand(pluginEnvironment.reload, "Reload plugins");

  return (
    <SettingsSection
      id="plugins"
      title="Plugins"
      headerAction={
        environmentId === null ? null : (
          <Button
            size="xs"
            variant="ghost"
            disabled={!canManage}
            onClick={() => void reload({ environmentId, input: {} })}
          >
            <RefreshCwIcon />
            Reload
          </Button>
        )
      }
    >
      <SettingsRow
        title="Plugins folder"
        description={
          snapshot
            ? `Plugins add views, thread statuses, toasts, composer bands and / commands. Each one is a folder here with a t3-plugin.json; ask an agent to write one. ${snapshot.pluginsDir}`
            : "Connect to an environment to see its plugins."
        }
      />
      {(snapshot?.plugins ?? []).map((plugin) => (
        <SettingsRow
          key={plugin.id}
          title={plugin.version ? `${plugin.name} ${plugin.version}` : plugin.name}
          description={
            plugin.error
              ? `${STATE_LABELS[plugin.state]}: ${plugin.error}`
              : [STATE_LABELS[plugin.state], plugin.description].filter(Boolean).join(" · ")
          }
          control={
            environmentId === null ? null : (
              <Switch
                aria-label={`Turn ${plugin.name} ${plugin.enabled ? "off" : "on"}`}
                checked={plugin.enabled}
                disabled={!canManage}
                onCheckedChange={(enabled) =>
                  void setEnabled({ environmentId, input: { pluginId: plugin.id, enabled } })
                }
              />
            )
          }
        />
      ))}
    </SettingsSection>
  );
}
