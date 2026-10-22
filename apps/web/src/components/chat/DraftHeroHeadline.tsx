import type { DraftId } from "~/composerDraftStore";
import { composerDraftHasUserContent, useComposerDraftStore } from "~/composerDraftStore";
import { resolveEnvironmentMachineKind, type ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentThreadGroup } from "@t3tools/client-runtime/state/models";
import { ChevronDownIcon, FolderPlusIcon, LayersIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useClientSettings } from "~/hooks/useSettings";
import { hasExplicitComposerModelSelection } from "~/lib/chatThreadActions";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
  projectGroupsSpanEnvironments,
} from "~/sidebarProjectGrouping";
import { useProjects, useThreadShells } from "~/state/entities";
import { useThreadGroups } from "~/state/threadGroups";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { InlineButton } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { DraftProjectName } from "./DraftProjectName";
import { DraftHeroProjectHeading } from "./DraftHeroProjectHeading";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

const ADD_PROJECT_VALUE = "add-project";

interface PickerItem {
  readonly value: string;
  readonly label: string;
}

interface DraftHeroHeadlineProps {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
  /** The group a "+ New chat in group" draft joins on its first send. */
  readonly group?: EnvironmentThreadGroup | null;
}

export function DraftHeroHeadline({
  draftId,
  activeProjectRef,
  activeProjectTitle,
  group = null,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const applyStickyState = useComposerDraftStore((store) => store.applyStickyState);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const setModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const openAddProject = () => openCommandPalette({ open: "add-project" });
  const {
    scratchEnvironmentId,
    scratchWorkspaceRootFor,
    scratchUnavailableReasonFor,
    openScratchProject,
  } = useScratchProject();
  const openProjectDraft = useNewThreadHandler();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const pickerFilter = useComboboxFilter();
  const threadGroups = useThreadGroups();

  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const projectGroups = sortLogicalProjectsForSidebar(
    buildSidebarProjectSnapshots({
      projects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
    }),
    threads,
    projectSortOrder,
  );
  const showProjectEnvironments = projectGroupsSpanEnvironments(projectGroups);
  const environmentMachineById = new Map(
    environments.map(
      (environment) =>
        [
          environment.environmentId,
          resolveEnvironmentMachineKind(environment.serverConfig),
        ] as const,
    ),
  );
  const projectPickerEntries = buildSidebarProjectPickerEntries({
    groups: projectGroups,
    preferredProjectRef: activeProjectRef,
  });
  const projectEntryByKey = new Map(
    projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const),
  );
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activeProjectKey = activeProjectGroup?.projectKey ?? "";
  const activeProjectDisplayName = activeProjectGroup?.displayName ?? activeProjectTitle;
  const hasResolvedProject = activeProjectTitle !== null;
  const canChooseProject = projectPickerEntries.length > 0;
  const shouldShowProjectMenu = canChooseProject;
  const menuEntries = projectPickerEntries.filter(
    ({ targetProject }) =>
      !isScratchProject(targetProject, scratchWorkspaceRootFor(targetProject.environmentId)),
  );
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  const scratchTargetEnvironmentId = scratchEnvironmentId(
    activeProjectRef?.environmentId ?? primaryEnvironmentId,
  );
  const scratchWorkspaceRoot = scratchWorkspaceRootFor(scratchTargetEnvironmentId);
  // Said in place of the way into "No project" when this machine cannot offer it.
  const scratchUnavailable =
    scratchWorkspaceRoot === null
      ? scratchUnavailableReasonFor(activeProjectRef?.environmentId ?? primaryEnvironmentId)
      : null;
  const isScratchDraft =
    activeProject !== null && isScratchProject(activeProject, scratchWorkspaceRoot);

  const pickerItems: readonly PickerItem[] = [
    ...menuEntries.map(({ group }) => ({ value: group.projectKey, label: group.displayName })),
    { value: ADD_PROJECT_VALUE, label: "Add project" },
  ];
  const pickerSearch = pickerQuery.trim();
  const filteredPickerItems =
    pickerSearch.length === 0
      ? pickerItems
      : pickerItems.filter(
          (item) =>
            item.value !== ADD_PROJECT_VALUE &&
            pickerFilter.contains(item, pickerSearch, (candidate) => candidate.label),
        );
  const selectedPickerItem = pickerItems.find((item) => item.value === activeProjectKey) ?? null;

  // The picker can change the draft's target while the no-project home is
  // still being opened; a stale continuation must not retarget it again.
  const latestTargetRef = useRef({ draftId, activeProjectKey, scratchTargetEnvironmentId });
  useEffect(() => {
    latestTargetRef.current = { draftId, activeProjectKey, scratchTargetEnvironmentId };
  }, [activeProjectKey, scratchTargetEnvironmentId, draftId]);
  // An empty draft instead opens the chosen project's own draft, like starting a new thread there:
  // moving it would replace that draft and strand whatever it holds, such as the browser tabs of
  // the no-project draft.
  const selectProject = (project: (typeof projects)[number], logicalProjectKey: string) => {
    if (!draftId) {
      return;
    }
    latestTargetRef.current = {
      draftId,
      activeProjectKey: logicalProjectKey,
      scratchTargetEnvironmentId: project.environmentId,
    };
    const currentDraft = getComposerDraft(draftId);
    if (!composerDraftHasUserContent(currentDraft)) {
      void openProjectDraft(scopeProjectRef(project.environmentId, project.id));
      return;
    }
    setLogicalProjectDraftThreadId(
      logicalProjectKey,
      scopeProjectRef(project.environmentId, project.id),
      draftId,
    );
    if (!hasExplicitComposerModelSelection(currentDraft)) {
      applyStickyState(draftId);
      const environmentSettings = environments.find(
        (environment) => environment.environmentId === project.environmentId,
      )?.serverConfig?.settings;
      const defaultModelSelection = environmentSettings
        ? resolveProjectSettings(environmentSettings, project.id, project).settings
            .defaultModelSelection
        : project.defaultModelSelection;
      if (defaultModelSelection) {
        setModelSelection(draftId, defaultModelSelection, {
          replaceOptions: true,
        });
      }
    }
  };
  const startScratch = async (): Promise<boolean> => {
    if (scratchTargetEnvironmentId === null || isScratchDraft) {
      return false;
    }
    const requested = { draftId, activeProjectKey, scratchTargetEnvironmentId };
    const project = await openScratchProject(scratchTargetEnvironmentId);
    const latest = latestTargetRef.current;
    if (
      !project ||
      latest.draftId !== requested.draftId ||
      latest.activeProjectKey !== requested.activeProjectKey ||
      latest.scratchTargetEnvironmentId !== requested.scratchTargetEnvironmentId
    ) {
      return false;
    }
    selectProject(project, deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings));
    return true;
  };

  const projectSelector = shouldShowProjectMenu ? (
    <Combobox
      items={pickerItems}
      filteredItems={filteredPickerItems}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      open={pickerOpen}
      onOpenChange={(open) => {
        setPickerOpen(open);
        setPickerQuery("");
      }}
      value={selectedPickerItem}
      onValueChange={(item) => {
        if (!item) return;
        setPickerOpen(false);
        if (item.value === ADD_PROJECT_VALUE) {
          openAddProject();
          return;
        }
        const entry = projectEntryByKey.get(item.value);
        if (!entry || item.value === activeProjectKey) {
          return;
        }
        selectProject(entry.targetProject, entry.group.projectKey);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComboboxTrigger
              render={<InlineButton tone="picker" />}
              data-draft-project-trigger=""
              className="pointer-events-auto min-w-0 max-w-full align-baseline"
            />
          }
        >
          <DraftProjectName
            value={isScratchDraft ? "No project" : (activeProjectDisplayName ?? "Choose a project")}
            singleLine
          />
        </TooltipTrigger>
        {activeProjectDisplayName && !isScratchDraft ? (
          <TooltipPopup side="top">{activeProjectDisplayName}</TooltipPopup>
        ) : null}
      </Tooltip>
      <ComboboxPopup align="center" className="w-72 overflow-hidden">
        <ComboboxSearchInput
          aria-label="Search projects"
          placeholder="Search projects..."
          value={pickerQuery}
          onChange={(event) => setPickerQuery(event.target.value)}
        />
        <ComboboxEmpty>No matching projects.</ComboboxEmpty>
        <ComboboxList>
          {(item: PickerItem) => {
            const entry = projectEntryByKey.get(item.value);
            return (
              <ComboboxItem key={item.value} hideIndicator value={item}>
                {item.value === ADD_PROJECT_VALUE ? (
                  <FolderPlusIcon className="size-4 shrink-0" />
                ) : entry ? (
                  <ProjectFavicon project={entry.group} className="size-4 shrink-0" />
                ) : null}
                <Tooltip>
                  <TooltipTrigger render={<span className="min-w-0 flex-1 text-sm" />}>
                    <DraftProjectName value={item.label} />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{item.label}</TooltipPopup>
                </Tooltip>
                {entry && showProjectEnvironments ? (
                  <ProjectEnvironmentBadge
                    group={entry.group}
                    primaryEnvironmentId={primaryEnvironmentId}
                    machineByEnvironmentId={environmentMachineById}
                  />
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  ) : (
    <button
      type="button"
      onClick={openAddProject}
      className="pointer-events-auto inline min-w-0 max-w-full cursor-pointer border-muted-foreground/35 border-b border-dotted text-muted-foreground/60 transition-colors hover:border-muted-foreground/60 hover:text-muted-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <DraftProjectName value={activeProjectTitle ?? "Add a project"} singleLine />
    </button>
  );

  const noProjectShortcut = shortcutLabelForCommand(keybindings, "chat.newWithoutProject");
  const orStartWithoutProject =
    scratchWorkspaceRoot !== null && !isScratchDraft && (hasResolvedProject || canChooseProject) ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              tone="muted"
              className="pointer-events-auto"
              onClick={() =>
                void startScratch().then((started) => {
                  if (started) {
                    document.querySelector<HTMLElement>("[data-draft-project-trigger]")?.focus();
                  }
                })
              }
            />
          }
        >
          or start without a project
        </TooltipTrigger>
        {noProjectShortcut ? <TooltipPopup side="bottom">{noProjectShortcut}</TooltipPopup> : null}
      </Tooltip>
    ) : null;

  // The project's open groups, newest first, single chats included since the
  // sidebar shows them as groups too: a new chat starts its own group unless
  // it joins one of these.
  const joinableGroups =
    activeProjectRef === null || isScratchDraft
      ? []
      : threadGroups
          .filter(
            (candidate) =>
              candidate.environmentId === activeProjectRef.environmentId &&
              candidate.projectId === activeProjectRef.projectId &&
              candidate.threadIds.length > 0 &&
              candidate.settledAt === null,
          )
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const groupPicker =
    draftId !== null && hasResolvedProject && !isScratchDraft ? (
      <Menu>
        <MenuTrigger
          render={<InlineButton tone="muted" className="pointer-events-auto" />}
          aria-label="Choose a group for this chat"
        >
          <LayersIcon aria-hidden className="size-3.5" />
          New group
          <ChevronDownIcon aria-hidden className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="center" className="max-w-80">
          {joinableGroups.length === 0 ? (
            <MenuItem disabled>No groups in this project yet</MenuItem>
          ) : null}
          {joinableGroups.map((candidate) => (
            <MenuItem
              key={candidate.id}
              onClick={() =>
                // Same workspace as "+ New chat in group"; "start outside the
                // group" takes it back out.
                setDraftThreadContext(draftId, {
                  groupId: candidate.id,
                  branch: candidate.branch,
                  worktreePath: candidate.worktreePath,
                  envMode: candidate.worktreePath ? "worktree" : "local",
                  startFromOrigin: false,
                })
              }
            >
              <LayersIcon aria-hidden />
              <span className="min-w-0 truncate">{candidate.title}</span>
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    ) : null;

  if (group !== null) {
    // A new chat in a group names the group first, so it can't read as a
    // fresh thread of the project.
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
        <h1 className="flex w-full items-center justify-center gap-2.5 text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
          <LayersIcon aria-hidden className="size-6 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">New chat in {group.title}</span>
        </h1>
        <p className="mt-2 flex h-6 items-center gap-1.5 text-muted-foreground text-sm">
          <span className="min-w-0 truncate">
            {activeProjectDisplayName ?? "Project"}
            {group.branch !== null ? ` · ${group.branch}` : ""}
          </span>
          {draftId ? (
            <>
              <span aria-hidden>·</span>
              <InlineButton
                tone="muted"
                className="pointer-events-auto"
                onClick={() => setDraftThreadContext(draftId, { groupId: null })}
              >
                start outside the group
              </InlineButton>
            </>
          ) : null}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      {hasResolvedProject && !isScratchDraft ? (
        <DraftHeroProjectHeading projectName={activeProjectDisplayName ?? "Choose a project"}>
          {projectSelector}
        </DraftHeroProjectHeading>
      ) : (
        <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
          {isScratchDraft ? (
            <>What should we work on?</>
          ) : canChooseProject ? (
            <>{projectSelector} to start</>
          ) : (
            <>Add a project to start</>
          )}
        </h1>
      )}
      {/* Reserved whenever threads can skip a project, so the heading does not
          move. Without a project, the picker moves here to choose one. */}
      {groupPicker === null &&
      scratchWorkspaceRoot === null &&
      scratchUnavailable === null ? null : (
        <p className="mt-2 flex h-6 w-full items-center justify-center gap-1.5 text-sm">
          {isScratchDraft && scratchWorkspaceRoot !== null ? (
            projectSelector
          ) : (
            <>
              {groupPicker}
              {groupPicker !== null &&
              (orStartWithoutProject !== null || scratchUnavailable !== null) ? (
                <span aria-hidden className="text-muted-foreground">
                  ·
                </span>
              ) : null}
              {scratchWorkspaceRoot === null && scratchUnavailable !== null ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="pointer-events-auto cursor-default text-muted-foreground" />
                    }
                  >
                    No project isn't available on this machine
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">{scratchUnavailable}</TooltipPopup>
                </Tooltip>
              ) : (
                orStartWithoutProject
              )}
            </>
          )}
        </p>
      )}
    </div>
  );
}
