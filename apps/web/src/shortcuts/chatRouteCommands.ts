import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { AuthPreviewOperateScope, type EnvironmentId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { isPreviewAvailableFor } from "../browser/previewRuntime";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { useComposerDraftStore } from "../composerDraftStore";
import { dispatchPreviewAction, type PreviewAction } from "../components/preview/previewActionBus";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { resolveSidebarEnvironmentScope } from "../components/Sidebar.logic";
import { createNewThreadHandler, resolveDefaultProjectRef } from "../hooks/useHandleNewThread";
import { createScratchProjectActions } from "../hooks/useScratchProject";
import { getClientSettings } from "../hooks/useSettings";
import { startChatInGroup } from "../hooks/useThreadGroupActions";
import { orderSidebarProjects } from "../hooks/useSidebarProjectGroups";
import { scopeThreadActionContext, startNewThreadFromContext } from "../lib/chatThreadActions";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { readProjects, readThreadShell } from "../state/entities";
import { environmentPresentations, environmentSummaries } from "../state/presentation";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { readEnvironmentScope } from "../state/session";
import { readThreadGroup } from "../state/threadGroups";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { type CommandHandler, registerCommands } from "./dispatcher";

const CHAT_ROUTE_ID = "/_chat";

/**
 * New-thread and preview commands, live while a chat route is showing and no
 * modal page (Settings, Usage) covers it. Everything is read at event time, so
 * the scope is registered once instead of re-registering on every store change.
 */
export function installChatRouteCommands(router: AnyRouter): () => void {
  const handleNewThread = createNewThreadHandler(router);
  const scratch = createScratchProjectActions({
    environments: () =>
      [...appAtomRegistry.get(environmentPresentations.presentationsAtom)].map(
        ([environmentId, presentation]) => ({ ...presentation, environmentId }),
      ),
    primaryEnvironmentId: () => appAtomRegistry.get(primaryEnvironmentIdAtom),
    registry: appAtomRegistry,
    handleNewThread,
  });

  const readRouteTarget = () => resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const readRouteThreadRef = () => {
    const target = readRouteTarget();
    return target?.kind === "server" ? target.threadRef : null;
  };
  const readPreviewOpen = () => {
    const threadRef = readRouteThreadRef();
    // Store-only on purpose: the URL-aware arbitration lives in ChatView's
    // preview toggle, which the action bus reaches.
    return threadRef
      ? selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef) === "preview"
      : false;
  };
  // New-thread shortcuts follow the sidebar's machine filter, like its New thread button.
  const readEnvironmentScopeId = () =>
    resolveSidebarEnvironmentScope(
      appAtomRegistry.get(environmentSummaries.identitiesAtom),
      useUiStateStore.getState().sidebarEnvironmentScopeId,
    );
  const readScopedProjects = (environmentScopeId: EnvironmentId | null) =>
    environmentScopeId === null
      ? readProjects()
      : readProjects().filter((project) => project.environmentId === environmentScopeId);
  const readThreadContext = () => {
    const target = readRouteTarget();
    const drafts = useComposerDraftStore.getState();
    const activeThread = target?.kind === "server" ? readThreadShell(target.threadRef) : null;
    const activeDraftThread = target
      ? target.kind === "server"
        ? drafts.getDraftThread(target.threadRef)
        : drafts.getDraftSession(target.draftId)
      : null;
    const projectOrder = useUiStateStore.getState().projectOrder;
    const environmentScopeId = readEnvironmentScopeId();
    // Same manual order as the unfiltered default, so the shortcut and the
    // sidebar button pick the same project.
    const scopedProject =
      environmentScopeId === null
        ? undefined
        : orderSidebarProjects(readScopedProjects(environmentScopeId), projectOrder)[0];
    return scopeThreadActionContext(
      {
        activeDraftThread,
        activeThread: activeThread ?? undefined,
        defaultProjectRef: resolveDefaultProjectRef(readProjects(), projectOrder),
        handleNewThread,
      },
      environmentScopeId,
      scopedProject ? scopeProjectRef(scopedProject.environmentId, scopedProject.id) : null,
    );
  };
  const readProjectGroupCount = () =>
    buildSidebarProjectSnapshots({
      projects: readScopedProjects(readEnvironmentScopeId()),
      settings: selectProjectGroupingSettings(getClientSettings()),
      primaryEnvironmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
      resolveEnvironmentLabel: () => null,
    }).length;
  const canOperatePreview = (environmentId: EnvironmentId) =>
    readEnvironmentScope(environmentId, AuthPreviewOperateScope);

  const claim = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const startNewLocal: CommandHandler = (event) => {
    claim(event);
    void startNewThreadFromContext(readThreadContext());
  };

  const previewCommand =
    (action: PreviewAction): CommandHandler =>
    (event) => {
      claim(event);
      const threadRef = readRouteThreadRef();
      if (threadRef && canOperatePreview(threadRef.environmentId)) dispatchPreviewAction(action);
    };

  return registerCommands(
    {
      "chat.newLocal": startNewLocal,
      "chat.newWithoutProject": (event) => {
        const { activeThread, activeDraftThread } = readThreadContext();
        // A machine filter keeps the scratch thread on the filtered machine.
        const environmentScopeId = readEnvironmentScopeId();
        const environmentId =
          environmentScopeId === null
            ? scratch.scratchEnvironmentId(
                activeThread?.environmentId ?? activeDraftThread?.environmentId ?? null,
              )
            : scratch.scratchWorkspaceRootFor(environmentScopeId) !== null
              ? environmentScopeId
              : null;
        if (environmentId === null) return;
        claim(event);
        void scratch.startScratchThread(environmentId);
      },
      "chat.newInGroup": (event) => {
        claim(event);
        const threadRef = readRouteThreadRef();
        const activeThread = threadRef ? readThreadShell(threadRef) : null;
        const group =
          activeThread?.groupId != null
            ? readThreadGroup({
                environmentId: activeThread.environmentId,
                groupId: activeThread.groupId,
              })
            : null;
        // A hidden group (one live chat) is not a group the chat is shown in.
        if (group === null || !group.visible) {
          toastManager.add(
            stackedThreadToast({ type: "info", title: "This chat is not in a group" }),
          );
          return;
        }
        void startChatInGroup(group, handleNewThread);
      },
      "chat.new": (event) => {
        // The boring sidebar's folders already show the context, so it starts in
        // the current project like the legacy sidebar did.
        const { boringSidebarEnabled, legacySidebarEnabled } = getClientSettings();
        if (!boringSidebarEnabled && !legacySidebarEnabled && readProjectGroupCount() > 1) {
          claim(event);
          openCommandPalette({ open: "new-thread-in" });
          return;
        }
        startNewLocal(event);
      },
      "preview.toggle": (event) => {
        claim(event);
        const threadRef = readRouteThreadRef();
        if (!threadRef || (!canOperatePreview(threadRef.environmentId) && !readPreviewOpen())) {
          return;
        }
        if (!isPreviewAvailableFor(threadRef.environmentId)) {
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: "Preview is desktop-only",
              description: "Open T3 Code in the desktop app to use the in-app preview.",
            }),
          );
          return;
        }
        dispatchPreviewAction("toggle-panel");
      },
      "preview.refresh": previewCommand("refresh"),
      "preview.focusUrl": previewCommand("focus-url"),
      "preview.zoomIn": previewCommand("zoom-in"),
      "preview.zoomOut": previewCommand("zoom-out"),
      "preview.resetZoom": previewCommand("reset-zoom"),
    },
    {
      when: () =>
        router.state.matches.some((match) => match.routeId === CHAT_ROUTE_ID) &&
        !router.state.matches.some((match) => isAppModalPage(match.pathname)) &&
        !isCommandPaletteOpen(),
      context: () => {
        const threadRef = readRouteThreadRef();
        return {
          terminalOpen: threadRef
            ? selectThreadTerminalUiState(
                useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
                threadRef,
              ).terminalOpen
            : false,
          previewOpen: readPreviewOpen(),
        };
      },
      onKeyDown: (event) => {
        if (event.key !== "Escape") return false;
        const selection = useThreadSelectionStore.getState();
        if (selection.selectedThreadKeys.size === 0) return false;
        event.preventDefault();
        selection.clearSelection();
      },
    },
  );
}
