import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Platform, View } from "react-native";

import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { serverEnvironment } from "../../state/server";

interface ShiftMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/**
 * Shift pinned above the thread list: a row for each connected machine that
 * has Shift on. Shift's chat is an ordinary thread on that machine, so the row
 * just opens it.
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
    <View className="pb-3">
      <ListSection>
        <ListRow
          icon="shift"
          label="Shift"
          description={props.named ? props.machine.label : undefined}
          onPress={() => props.onOpen(props.machine.environmentId, threadId)}
        />
      </ListSection>
    </View>
  );
}
