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
  type ThreadId,
} from "@t3tools/contracts";
import { createModelSelection, modelSelectionCommandType } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useOpenInPreferredEditor } from "../../editorPreferences";
import { isElectron } from "../../env";
import { usePrimarySettings } from "../../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionForInstance,
} from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { homeEnvironment } from "../../state/home";
import { orchestrationEnvironment } from "../../state/orchestration";
import { primaryServerConfigAtom, primaryServerProvidersAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const HOME_DESCRIPTION =
  "An agent that can act across all your projects and linked machines. It can answer questions and approve requests for you.";

/** Settings page for Home. Only a desktop app's own server can run it. */
export function HomeSettings() {
  const environmentId = usePrimaryEnvironmentId();
  const homeWorkspaceRoot = useAtomValue(
    primaryServerConfigAtom,
    (config) => config?.homeWorkspaceRoot ?? null,
  );
  return (
    <SettingsPageContainer>
      <SettingsSection title="Shift">
        {!isElectron || environmentId === null || homeWorkspaceRoot === null ? (
          <SettingsRow
            {...searchableSetting("home")}
            description="Shift runs in the desktop app."
          />
        ) : (
          <HomeRows environmentId={environmentId} homeWorkspaceRoot={homeWorkspaceRoot} />
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
  const settings = usePrimarySettings();
  const threadId = settings.home.threadId;
  const thread = useThreadShell(threadId === null ? null : scopeThreadRef(environmentId, threadId));
  const providers = useAtomValue(primaryServerProvidersAtom);
  const availableEditors = useAtomValue(
    primaryServerConfigAtom,
    (config) => config?.availableEditors ?? [],
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
