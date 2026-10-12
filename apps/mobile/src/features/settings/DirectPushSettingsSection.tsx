import {
  DEFAULT_DIRECT_PUSH_ALERT_KINDS,
  type DirectPushAlertKind,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { settleAsyncResult } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { Alert, Linking } from "react-native";

import { supportsAgentAwarenessPush } from "../agent-awareness/capabilities";
import {
  type DirectPushEnvironmentStatus,
  getDirectPushStatuses,
  requestDirectPushRegistration,
  resetDirectPushRelay,
  subscribeDirectPushStatuses,
} from "../agent-awareness/directPushRegistration";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import { runtime } from "../../lib/runtime";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const STATUS_TEXT: Record<DirectPushEnvironmentStatus, string> = {
  registered: "Ready",
  "no-credentials": "Not ready: update this server or add push keys",
  unavailable: "Not available from this server",
};

const ALERT_KIND_ROWS: ReadonlyArray<{
  readonly kind: DirectPushAlertKind;
  readonly label: string;
  readonly subtitle: string;
}> = [
  { kind: "input", label: "Questions", subtitle: "An agent asks you something" },
  { kind: "approval", label: "Approvals", subtitle: "An agent needs permission to continue" },
  { kind: "completed", label: "Finished", subtitle: "An agent finishes its work" },
  { kind: "failed", label: "Failed", subtitle: "An agent run fails" },
];

/** Alerts pushed by the connected servers themselves, with no T3 Connect account. */
export function DirectPushSettingsSection() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  const { savedConnectionsById } = useSavedRemoteConnections();
  const statuses = useSyncExternalStore(
    subscribeDirectPushStatuses,
    getDirectPushStatuses,
    getDirectPushStatuses,
  );
  const enabled =
    AsyncResult.isSuccess(preferencesResult) && preferencesResult.value.directPushEnabled === true;
  const alertOn =
    (AsyncResult.isSuccess(preferencesResult)
      ? preferencesResult.value.directPushAlertOn
      : undefined) ?? DEFAULT_DIRECT_PUSH_ALERT_KINDS;
  const setAlertKind = useCallback(
    async (kind: DirectPushAlertKind, on: boolean) => {
      const next = ALERT_KIND_ROWS.map((row) => row.kind).filter((candidate) =>
        candidate === kind ? on : alertOn.includes(candidate),
      );
      await savePreferences({ directPushAlertOn: next });
      requestDirectPushRegistration();
    },
    [alertOn, savePreferences],
  );
  const connections = useMemo(() => Object.values(savedConnectionsById), [savedConnectionsById]);

  const setEnabled = useCallback(
    async (next: boolean) => {
      if (next) {
        const permission = await settleAsyncResult(() =>
          runtime.runPromiseExit(requestAgentNotificationPermission),
        );
        if (permission._tag === "Failure" || permission.value.type !== "granted") {
          Alert.alert(
            "Notifications disabled",
            "Allow notifications for this app in Settings to receive agent alerts.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Open Settings", onPress: () => void Linking.openSettings() },
            ],
          );
          return;
        }
      }
      // Registration reads the stored preference, so wait for the write.
      await savePreferences({ directPushEnabled: next });
      requestDirectPushRegistration();
    },
    [savePreferences],
  );

  return (
    <SettingsSection title="From your servers">
      <SettingsSwitchRow
        icon="bell.badge"
        label="Server Notifications"
        subtitle="Your servers send alerts straight to this device. No T3 Connect account needed."
        disabled={!supportsAgentAwarenessPush() || !AsyncResult.isSuccess(preferencesResult)}
        value={enabled}
        onValueChange={(next) => void setEnabled(next)}
      />
      {enabled
        ? ALERT_KIND_ROWS.map((row) => (
            <SettingsSwitchRow
              key={row.kind}
              icon="bell.badge"
              label={row.label}
              subtitle={row.subtitle}
              value={alertOn.includes(row.kind)}
              onValueChange={(on) => void setAlertKind(row.kind, on)}
            />
          ))
        : null}
      {enabled
        ? connections.map((connection) => {
            const status = statuses.get(connection.environmentId as EnvironmentId);
            return (
              <SettingsRow
                key={connection.environmentId}
                icon="server.rack"
                label={connection.environmentLabel}
                value={status ? STATUS_TEXT[status] : "Waiting for connection"}
                valuePosition="below"
              />
            );
          })
        : null}
      {enabled ? (
        <SettingsRow
          icon="arrow.clockwise"
          label="Reset alerts"
          value="Get a new alert address. Computers you are not connected to right now stop reaching this phone."
          valuePosition="below"
          onPress={() =>
            Alert.alert(
              "Reset alerts?",
              "Connected computers update automatically. Others stop alerting this phone until you connect them again.",
              [
                { text: "Cancel", style: "cancel" },
                { text: "Reset", style: "destructive", onPress: resetDirectPushRelay },
              ],
            )
          }
        />
      ) : null}
    </SettingsSection>
  );
}
