import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Platform, View } from "react-native";

import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { useEnvironmentServerConfig, useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { ComposerVoiceModeButton, ComposerVoiceStrip } from "../voice-mode/ComposerVoiceMode";
import { useOneClickVoice } from "../voice-mode/useOneClickVoice";
import { voiceModeSupported } from "../voice-mode/voiceMode";

interface ShiftMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/**
 * Shift pinned above the thread list: a row for each connected machine that
 * has Shift on. Shift's chat is an ordinary thread on that machine, so the row
 * opens it, and its waveform talks to Shift without opening it.
 */
export function ShiftRows(props: {
  readonly machines: ReadonlyArray<ShiftMachine>;
  readonly onOpen: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}) {
  if (props.machines.length === 0) return null;
  // Name the machine only when there is more than one to tell apart.
  const named = props.machines.length > 1;
  return (
    <View className={Platform.OS === "android" ? "px-3" : undefined}>
      {props.machines.map((machine) => (
        <ShiftRow
          key={machine.environmentId}
          machine={machine}
          named={named}
          onOpen={props.onOpen}
        />
      ))}
    </View>
  );
}

function ShiftRow(props: {
  readonly machine: ShiftMachine;
  readonly named: boolean;
  readonly onOpen: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}) {
  const threadId = useAtomValue(
    serverEnvironment.settingsValueAtom(props.machine.environmentId),
    (settings) => settings?.home.threadId ?? null,
  );
  if (threadId === null) return null;
  return (
    <ShiftThreadRow
      environmentId={props.machine.environmentId}
      threadId={threadId}
      description={props.named ? props.machine.label : undefined}
      onOpen={props.onOpen}
    />
  );
}

/**
 * Shift's row, with a waveform that talks to Shift without opening the chat.
 * While a conversation runs, the strip under the row shows what it is doing
 * and holds mute and end. Voice is hidden when Shift's provider has none.
 */
function ShiftThreadRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly description: string | undefined;
  readonly onOpen: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}) {
  const { environmentId, threadId } = props;
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const supportsVoice =
    useEnvironmentServerConfig(environmentId)?.providers.find(
      (provider) => provider.instanceId === thread?.providerInstanceId,
    )?.supportsVoice === true;
  const voice = useOneClickVoice({ environmentId, threadId });
  const offersVoice = voiceModeSupported && (supportsVoice || voice.phase !== "idle");
  return (
    <View className="gap-2 pb-3">
      <ListSection>
        <ListRow
          icon="shift"
          label="Shift"
          description={props.description}
          onPress={() => props.onOpen(environmentId, threadId)}
          trailing={
            offersVoice ? (
              <View className="-my-2">
                <ComposerVoiceModeButton
                  phase={voice.phase}
                  disabled={false}
                  onPress={voice.toggle}
                />
              </View>
            ) : undefined
          }
        />
      </ListSection>
      {voice.phase === "idle" ? null : <ComposerVoiceStrip onEnd={voice.toggle} />}
    </View>
  );
}
