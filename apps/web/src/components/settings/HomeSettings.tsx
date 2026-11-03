import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { createModelSelection, modelSelectionCommandType } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useOpenInPreferredEditor } from "../../editorPreferences";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionForInstance,
} from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useThreadShell } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { homeEnvironment } from "../../state/home";
import { orchestrationEnvironment } from "../../state/orchestration";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { shiftEnvironmentIdAtom, useShiftEnvironmentChoice } from "../../state/shiftEnvironment";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const EMPTY_EDITORS: ReadonlyArray<never> = [];

const HOME_DESCRIPTION =
  "An agent that can act across all your projects and linked machines. It can answer questions and approve requests for you.";

/**
 * Settings page for Home. Each device picks the machine it uses Shift from:
 * this one, or another connected desktop app's server. The rest of the page
 * manages that machine's Shift.
 */
export function HomeSettings() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const shiftEnvironmentId = useAtomValue(shiftEnvironmentIdAtom);
  const [, setChoice] = useShiftEnvironmentChoice();
  // Only a desktop app's own server runs Shift; it reports its Shift folder.
  const machines = environments
    .filter((environment) => environment.serverConfig?.homeWorkspaceRoot)
    .toSorted(
      (left, right) =>
        Number(right.environmentId === primaryEnvironmentId) -
        Number(left.environmentId === primaryEnvironmentId),
    );
  const machine = machines.find((candidate) => candidate.environmentId === shiftEnvironmentId);
  const homeWorkspaceRoot = machine?.serverConfig?.homeWorkspaceRoot ?? null;
  const machineLabel = (environmentId: EnvironmentId, label: string) =>
    environmentId === primaryEnvironmentId ? `${label} (this machine)` : label;
  return (
    <SettingsPageContainer>
      <SettingsSection title="Shift">
        {machine === undefined || homeWorkspaceRoot === null ? (
          <SettingsRow
            {...searchableSetting("home")}
            description="Shift runs in the desktop app."
          />
        ) : (
          <>
            {machines.length > 1 ? (
              <SettingsRow
                title="Use Shift from"
                description="The machine whose Shift this device opens. It thinks and talks there."
                control={
                  <Select
                    value={machine.environmentId}
                    onValueChange={(value) => {
                      if (value === null) return;
                      setChoice(value === primaryEnvironmentId ? null : (value as EnvironmentId));
                    }}
                  >
                    <SelectTrigger aria-label="Use Shift from" className="min-w-48" size="xs">
                      <SelectValue>
                        {machineLabel(machine.environmentId, machine.label)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {machines.map((candidate) => (
                        <SelectItem key={candidate.environmentId} value={candidate.environmentId}>
                          {machineLabel(candidate.environmentId, candidate.label)}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                }
              />
            ) : null}
            <HomeRows
              key={machine.environmentId}
              environmentId={machine.environmentId}
              homeWorkspaceRoot={homeWorkspaceRoot}
            />
          </>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function reportHomeFailure(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "An error occurred.",
  });
}

function useNavigateToThread() {
  const navigate = useNavigate();
  return (environmentId: EnvironmentId, threadId: ThreadId) =>
    navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
}

/**
 * On or off, the model, a new chat and instructions. While Shift is on, its
 * model is its thread's model, and picking one switches that thread as the
 * composer's picker would; while it is off, the pick is the model it starts with.
 */
function HomeRows(props: { environmentId: EnvironmentId; homeWorkspaceRoot: string }) {
  const { environmentId, homeWorkspaceRoot } = props;
  const settings = useEnvironmentSettings(environmentId);
  const threadId = settings.home.threadId;
  const thread = useThreadShell(threadId === null ? null : scopeThreadRef(environmentId, threadId));
  const providers = useAtomValue(
    environmentPresentations.providersByEnvironmentAtom,
    (byEnvironment) => byEnvironment.get(environmentId) ?? EMPTY_PROVIDERS,
  );
  const availableEditors = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.availableEditors ?? EMPTY_EDITORS,
  );
  const enable = useAtomCommand(homeEnvironment.enable, { reportFailure: false });
  const disable = useAtomCommand(homeEnvironment.disable, { reportFailure: false });
  const startFresh = useAtomCommand(homeEnvironment.startFresh, { reportFailure: false });
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  const openInEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  const navigateToThread = useNavigateToThread();
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [pending, setPending] = useState(false);

  const entries = providerInstanceEntriesFor(providers, settings, null);
  const usable = (instanceId: string) =>
    entries.some((entry) => entry.instanceId === instanceId && entry.enabled && entry.isAvailable);
  // Off, start from the default model for new threads, else the first usable provider.
  const fallbackEntry = entries.find((entry) => entry.enabled && entry.isAvailable);
  const fallbackModel = fallbackEntry
    ? resolveAppModelSelectionForInstance(fallbackEntry.instanceId, settings, providers, null)
    : null;
  const selection =
    thread?.modelSelection ??
    picked ??
    (settings.defaultModelSelection && usable(settings.defaultModelSelection.instanceId)
      ? settings.defaultModelSelection
      : fallbackEntry && fallbackModel
        ? createModelSelection(fallbackEntry.instanceId, fallbackModel)
        : null);

  const run = async <A, E>(title: string, action: () => Promise<AtomCommandResult<A, E>>) => {
    setPending(true);
    const result = await action();
    setPending(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      reportHomeFailure(title, squashAtomCommandFailure(result));
    return result;
  };

  const turnOn = async () => {
    if (selection === null) return;
    const result = await run("Could not turn on Shift", () =>
      enable({ environmentId, input: { modelSelection: selection } }),
    );
    if (result._tag === "Success") await navigateToThread(environmentId, result.value.threadId);
  };

  const changeModel = (next: ModelSelection) => {
    if (thread === null || threadId === null) {
      setPicked(next);
      return;
    }
    void run("Could not change Shift's model", () =>
      dispatch({
        environmentId,
        input: {
          type: modelSelectionCommandType(thread.modelSelection.instanceId, next),
          commandId: CommandId.make(randomUUID()),
          threadId,
          modelSelection: next,
        },
      }),
    );
  };

  const newChat = async () => {
    const result = await run("Could not start a new Shift chat", () =>
      startFresh({ environmentId, input: {} }),
    );
    if (result._tag === "Success") await navigateToThread(environmentId, result.value.threadId);
  };

  const editInstructions = async () => {
    const separator =
      homeWorkspaceRoot.includes("\\") && !homeWorkspaceRoot.includes("/") ? "\\" : "/";
    const result = await openInEditor(
      `${homeWorkspaceRoot.replace(/[\\/]+$/, "")}${separator}AGENTS.md`,
    );
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportHomeFailure("Could not open instructions", squashAtomCommandFailure(result));
    }
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("home")}
        description={HOME_DESCRIPTION}
        control={
          <div className="flex items-center gap-2">
            {threadId === null ? null : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void navigateToThread(environmentId, threadId)}
              >
                Open Shift
              </Button>
            )}
            <Switch
              checked={threadId !== null}
              disabled={pending || (threadId === null && selection === null)}
              onCheckedChange={(checked) =>
                void (checked
                  ? turnOn()
                  : run("Could not turn off Shift", () => disable({ environmentId, input: {} })))
              }
              aria-label="Shift"
            />
          </div>
        }
      />
      <SettingsRow
        title="Model"
        description={
          threadId === null
            ? "The model Shift starts with."
            : "Changes Shift's model; its conversation carries over."
        }
        control={
          selection === null ? (
            <span className="text-sm text-muted-foreground">No providers available.</span>
          ) : (
            <ProviderModelPicker
              environmentId={environmentId}
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={getCustomModelOptionsByInstance(
                settings,
                providers,
                selection.instanceId,
                selection.model,
              )}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              onInstanceModelChange={(instanceId, model) =>
                changeModel(createModelSelection(instanceId, model))
              }
            />
          )
        }
      />
      {threadId === null ? null : (
        <>
          <SettingsRow
            title="New Shift chat"
            description="Shift starts a clean conversation. The current one stays as a normal thread."
            control={
              <Button size="sm" variant="outline" disabled={pending} onClick={() => void newChat()}>
                New chat
              </Button>
            }
          />
          <SettingsRow
            title="Instructions"
            description="AGENTS.md in the Shift folder."
            control={
              <Button size="sm" variant="outline" onClick={() => void editInstructions()}>
                Edit
              </Button>
            }
          />
        </>
      )}
    </>
  );
}
