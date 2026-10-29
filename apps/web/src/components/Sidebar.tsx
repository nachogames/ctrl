import { ENVIRONMENT_PICKER_JUMP_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import { EnvironmentBatteryIndicator } from "./EnvironmentBatteryIndicator";
import { attachSidebarTree, SIDEBAR_TREE_PROPS } from "../lib/sidebarTree";
import { type EnvironmentId, type ScopedProjectRef } from "@t3tools/contracts";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { ThreadContextDragGhost } from "./chat/ThreadContextDragGhost";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag as moveThreadContextDragGhost,
} from "./chat/threadContextDrag";
import { discardComposerDraft } from "../lib/discardComposerDraft";
import { requestCustomSnooze } from "./CustomSnoozeDialog";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import {
  DndContext,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  canSnooze,
  effectiveSnoozed,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  createInboxReturnTracker,
  isThreadWorking,
} from "@t3tools/client-runtime/state/thread-inbox";
import { sortSettledThreads } from "@t3tools/client-runtime/state/thread-sort";
import {
  nextShownOrder,
  threadSearchMatchKey,
  threadSearchSubject,
  type ShownOrder,
} from "@t3tools/client-runtime/state/thread-search";
import { foldSearchQuery, rankMessageMatches } from "@t3tools/shared/paletteSearch";
import { findForMessageMatch, openThreadFindOnQuery } from "./chat/threadFindStore";
import {
  threadRuntimeCanArchive,
  type EnvironmentThreadGroup,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  ProjectId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";

import {
  CheckIcon,
  ChevronDownIcon,
  FolderIcon,
  LayersIcon,
  ListFilterIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { type AnyRouter, useRouter } from "@tanstack/react-router";

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { isElectron } from "../env";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { useShortcutModifierState } from "../shortcutModifierState";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isMacPlatform } from "~/lib/utils";
import { readLocalApi } from "../localApi";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import {
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  buildSidebarProjectSnapshots,
  projectGroupsSpanEnvironments,
  resolveSidebarProjectScopeKeys,
  getSidebarProjectSettingsKey,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { resolveGroupExpanded, resolveProjectExpanded, useUiStateStore } from "../uiStateStore";
import {
  getThreadKeysToDeselectAfterDelete,
  useThreadSelectionStore,
} from "../threadSelectionStore";
import {
  canTurnThreadIntoProject,
  useAcknowledgeThreadWoke,
  useThreadActions,
} from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { orderSidebarProjects } from "../hooks/useSidebarProjectGroups";
import { useTerminalFocus } from "../hooks/useTerminalFocus";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { registerSettleAndAdvance } from "../settleAndAdvance";
import { scopeThreadActionContext, startNewThreadFromContext } from "../lib/chatThreadActions";
import { useBoringSidebarEnabled, useClientSettings } from "../hooks/useSettings";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useNowMinute } from "../hooks/useNowMinute";
import {
  useEnvironmentIdentities,
  useConnectedEnvironmentIds,
  useEnvironmentMachines,
  usePrimaryEnvironmentId,
} from "../state/environments";
import {
  readThreadShell,
  readThreadShells,
  useAllEnvironmentProjectSnapshotsReady,
  useDelegatedUnderParent,
  useProjects,
  useServerConfigs,
  useQuietThreadShells,
} from "../state/entities";
import { environmentPresentations } from "../state/presentation";
import { primaryServerKeybindingsAtom } from "../state/server";
import { environmentProjects } from "../state/projects";
import { threadEnvironment } from "../state/threads";
import { useOlderSettledShelf, useOlderSettledShelfGrowth } from "../state/olderSettledShelf";
import { useThreadSearch } from "../state/queries";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { canShareWithGuestAtom } from "./chat/guestShareAvailability";
import { openGuestShareDialog } from "./chat/guestShareDialogState";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import type { SidebarThreadSummary } from "../types";
import { threadGroupKey } from "@t3tools/client-runtime/state/entities";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { cn } from "~/lib/utils";
import { ProjectEnvironmentBadge } from "./ProjectEnvironmentBadge";
import {
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
} from "./threadActionMenu.logic";
import { parseMoveToGroupTarget } from "./moveToGroupMenu.logic";
import {
  buildThreadGroupMenuItems,
  isThreadGroupSnoozed,
  type ThreadGroupMenuId,
} from "./threadGroupMenu.logic";
import { SidebarGroupDraftRow, SidebarGroupRow } from "./sidebar/SidebarGroupRow";
import { SidebarProjectHeading } from "./sidebar/SidebarProjectHeading";
import { indexThreadGroups, readThreadGroups, useThreadGroups } from "../state/threadGroups";
import { readMoveToGroupState, useThreadGroupActions } from "../hooks/useThreadGroupActions";
import { resolveGroupThreadsTarget } from "./moveToGroupMenu.logic";
import {
  applySidebarThreadDrop,
  buildSidebarActiveTree,
  filterSidebarV2VisibleThreads,
  partitionThreadsByGroup,
  resolveForcedOpenGroupKey,
  resolveSidebarEnvironmentScope,
  resolveSidebarGroupExpanded,
  groupSettleStampMs,
  resolveSidebarGroupSection,
  sidebarActivityMs,
  type SidebarGroupSection,
  type SidebarTreeEntry,
  groupSidebarThreadsByProject,
  sidebarFolderExpansionKeys,
  buildBulkTitleRegenerationContextMenuItem,
  buildBulkUnpinContextMenuItem,
  deleteSelectedThreadEntries,
  filterSidebarProjectScopeItems,
  firstValidTimestampMs,
  isSidebarNestedLinkClick,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  planSidebarThreadDrop,
  reduceSidebarProjectScopeMenuState,
  resolveAdjacentThreadId,
  resolveSidebarSweepKeys,
  resolveSidebarDropTarget,
  mergeSidebarOrder,
  pruneSidebarUnitOrder,
  resolveSidebarArrangement,
  type SidebarArrangement,
  planGroupMemberReorder,
  resolveSidebarDropVerb,
  resolveSidebarThreadSection,
  searchSidebarThreads,
  shouldCreateNewThreadInCurrentProject,
  shouldNavigateAfterThreadPark,
  sidebarListItemId,
  sidebarThreadKeyAtY,
  sortInboxThreadsByReturn,
  sortPinnedThreadsForSidebar,
  sortThreadsForSidebar,
  sortWorkingThreadsBySend,
  useSnoozeWakeClock,
  useThreadJumpHintsVisible,
  type SidebarListItem,
  type SidebarSection,
  resolveSidebarRowThreadId,
} from "./Sidebar.logic";
import {
  createSidebarCollisionDetection,
  createSidebarSortingStrategy,
  restrictBelowSidebarLabel,
} from "./Sidebar.drag";
import { SidebarPointerSensor } from "./Sidebar.pointer";
import { createSidebarListMotion } from "./Sidebar.motion";
import {
  pickSnoozePreset,
  resolveSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
} from "./Sidebar.snooze";
import { ProjectFavicon } from "./ProjectFavicon";
import { deriveProviderEntriesByEnvironment } from "../providerInstances";
import { useStableCallback } from "../hooks/useStableCallback";
import {
  resolveSidebarRouteReveal,
  type SidebarRouteReveal,
  useActiveRowReveal,
} from "./sidebar/routeReveal";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { copyThreadReference } from "../lib/copyThreadReference";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
  useComboboxFilter,
} from "./ui/combobox";
import { SidebarContent, SidebarGroup, useSidebar } from "./ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { SidebarHeaderIconButton, SidebarThreadHeader } from "./sidebar/SidebarThreadHeader";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuShortcut,
  MenuTrigger,
} from "./ui/menu";
import { TooltipProvider } from "./ui/tooltip";
import { composerDraftHasUserContent, DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import {
  SidebarSearchResultRow,
  SortableThreadRow,
  type SidebarProviderEntry,
  type SidebarSweepAction,
} from "./sidebar/SidebarThreadRow";
import { SidebarDraftBlock } from "./sidebar/SidebarDraftBlock";
import {
  SidebarProjectFolderHeader,
  sidebarFolderRowId,
} from "./sidebar/SidebarProjectFolderHeader";
import {
  SidebarDragBoundary,
  SidebarSectionHeader,
  SidebarSectionPlaceholder,
} from "./sidebar/SidebarListMarkers";

function sameSidebarProviderEntries(
  left: ReadonlyMap<string, SidebarProviderEntry>,
  right: ReadonlyMap<string, SidebarProviderEntry>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [instanceId, entry] of right) {
    const other = left.get(instanceId);
    if (
      other === undefined ||
      other.driverKind !== entry.driverKind ||
      other.enabled !== entry.enabled ||
      other.displayName !== entry.displayName ||
      other.accentColor !== entry.accentColor ||
      other.acpRegistryAgentId !== entry.acpRegistryAgentId ||
      other.acpRegistryIconUrl !== entry.acpRegistryIconUrl ||
      other.models !== entry.models
    ) {
      return false;
    }
  }
  return true;
}

// Resolve providers per environment because default instance ids collide across environments.
const sidebarProviderEntriesAtom = Atom.make((get) => {
  const providersByEnvironment = get(environmentPresentations.providersByEnvironmentAtom);
  const derived = deriveProviderEntriesByEnvironment(
    [...get(environmentPresentations.serverConfigsAtom)].map(
      ([environmentId, config]) =>
        [environmentId, providersByEnvironment.get(environmentId) ?? [], config.settings] as const,
    ),
  );
  const previous = Option.getOrNull(
    get.self<ReadonlyMap<string, ReadonlyMap<string, SidebarProviderEntry>>>(),
  );
  const next = new Map<string, ReadonlyMap<string, SidebarProviderEntry>>();
  let changed = previous === null || previous.size !== derived.size;
  for (const [environmentId, entries] of derived) {
    const prior = previous?.get(environmentId);
    if (prior !== undefined && sameSidebarProviderEntries(prior, entries)) {
      next.set(environmentId, prior);
    } else {
      next.set(environmentId, entries);
      changed = true;
    }
  }
  return !changed && previous !== null ? previous : next;
}).pipe(Atom.withLabel("sidebar-provider-entries"));

const EMPTY_PROVIDER_ENTRIES: ReadonlyMap<string, SidebarProviderEntry> = new Map();
const EMPTY_THREADS: readonly EnvironmentThreadShell[] = [];

const SETTLED_TAIL_INITIAL_COUNT = 10;
const SETTLED_TAIL_PAGE_COUNT = 25;
const SETTLED_SHELF_EXPANDED_KEY = "t3code:sidebar:settled-expanded";
const SNOOZED_SHELF_EXPANDED_KEY = "t3code:sidebar:snoozed-expanded";
const WORKING_SHELF_EXPANDED_KEY = "t3code:sidebar:working-expanded";

const inboxReturns = createInboxReturnTracker();

type SidebarOptimisticDrop = {
  readonly key: string;
  readonly sourceSection: SidebarSection;
  readonly section: "pinned" | "active" | "settled";
  readonly occurredAt: string;
  readonly clearsSnooze: boolean;
  readonly order: readonly string[] | null;
  readonly keysAtDrop: ReadonlyMap<string, string | null>;
  readonly assignedKeys: ReadonlyMap<string, string>;
};

/** Keeps a group's chats in their dropped order while the order-key writes land. */
type SidebarOptimisticGroupOrder = {
  readonly groupKey: string;
  /** Member thread keys in the dropped order. */
  readonly order: readonly string[];
  readonly assignedKeys: ReadonlyMap<string, string>;
};

/** A group placed in a sidebar section, with its visible members in group order. */
interface SidebarGroupEntry {
  readonly key: string;
  readonly group: EnvironmentThreadGroup;
  readonly members: ReadonlyArray<EnvironmentThreadShell>;
  readonly section: SidebarGroupSection;
}

interface SidebarThreadPartitionInput {
  readonly threads: readonly EnvironmentThreadShell[];
  // Returns are tracked across every machine so a machine filter flip does
  // not read hidden threads as gone.
  readonly allThreads: readonly EnvironmentThreadShell[];
  readonly threadGroupByKey: ReadonlyMap<string, EnvironmentThreadGroup>;
  readonly soloGroupsEnabled: boolean;
  readonly optimisticGroupOrder: SidebarOptimisticGroupOrder | null;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  /** Tasks linked environments run for a listed thread; they show under it. */
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  readonly optimisticDrop: SidebarOptimisticDrop | null;
  readonly workingShelfEnabled: boolean;
  /** Boring mode: folders list active threads by the user's latest message. */
  readonly sortActiveBySend: boolean;
  // Snooze wakes, the queued-turn grace and the Working shelf's exit grace depend
  // on the clock, so the minute tick, the precise snooze-wake tick and the inbox
  // tracker's expiry version are inputs: a new key repartitions.
  readonly clockKey: string;
}

function threadShellKey(thread: Pick<SidebarThreadSummary, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

const NO_DRAGGED_ORDER: readonly string[] = [];
const NO_DRAGGED_ORDERS: {
  readonly settledOrder: readonly string[];
  readonly activeOrder: readonly string[] | undefined;
} = { settledOrder: NO_DRAGGED_ORDER, activeOrder: undefined };

// Where the dragged row would sort if dropped on the settled shelf or into the
// Active tree; the strategy previews those slots. Chats use activity order, so
// the Active preview is the tree rebuilt with the lifted row, not the slot under
// the pointer. Ids may include a project heading the drop would create.
function resolveDraggedOrders(input: {
  readonly drag: { readonly activeKey: string; readonly occurredAt: string };
  readonly threadByKey: ReadonlyMap<string, EnvironmentThreadShell>;
  readonly settledThreads: readonly EnvironmentThreadShell[];
  readonly activeThreads: readonly EnvironmentThreadShell[];
  readonly buildActiveTree: (
    ungrouped: readonly EnvironmentThreadShell[],
  ) => ReadonlyArray<SidebarTreeEntry<EnvironmentThreadShell>>;
}): typeof NO_DRAGGED_ORDERS {
  const { drag, threadByKey, settledThreads, activeThreads, buildActiveTree } = input;
  const thread = threadByKey.get(drag.activeKey);
  if (thread === undefined) return NO_DRAGGED_ORDERS;
  const others = (list: readonly EnvironmentThreadShell[]) =>
    list.filter((candidate) => threadShellKey(candidate) !== drag.activeKey);
  return {
    settledOrder: sortSettledThreads([
      ...others(settledThreads),
      applySidebarThreadDrop(thread, "settled", drag.occurredAt),
    ]).map(threadShellKey),
    activeOrder: buildActiveTree([
      ...others(activeThreads),
      applySidebarThreadDrop(thread, "active", drag.occurredAt),
    ]).map((entry) => sidebarListItemId(sidebarTreeEntryItem(entry))),
  };
}

function sidebarTreeEntryItem(entry: SidebarTreeEntry<EnvironmentThreadShell>): SidebarListItem {
  switch (entry.kind) {
    case "project-heading":
      return { kind: "project-heading", key: entry.projectKey };
    case "group":
      return { kind: "group", key: entry.groupKey, section: "active" };
    case "thread":
      return {
        kind: "thread",
        key: threadShellKey(entry.thread),
        section: "active",
        groupKey: entry.groupKey,
        soloGroupKey: entry.soloGroupKey ?? null,
      };
  }
}

const sidebarThreadGroupKeyOf = (thread: EnvironmentThreadShell) =>
  thread.groupId === null
    ? null
    : threadGroupKey({ environmentId: thread.environmentId, groupId: thread.groupId });
/**
 * The drop line's spot in the list, from the rows at rest (they hold still
 * during an in-place rearrange). It starts where the target row's content does.
 */
function measureArrangeLine(
  list: HTMLElement | null,
  line: NonNullable<SidebarArrangement["line"]>,
): { readonly top: number; readonly left: number } | null {
  const id = "beforeId" in line ? line.beforeId : line.afterId;
  const row = list?.querySelector<HTMLElement>(
    `[data-sidebar-item="${globalThis.CSS.escape(id)}"]`,
  );
  if (!list || !row) return null;
  const listRect = list.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const scale = list.offsetWidth > 0 ? listRect.width / list.offsetWidth : 1;
  const edge = "beforeId" in line ? rowRect.top : rowRect.bottom;
  const inset = Number(row.dataset.sidebarItemInset ?? 0);
  return { top: (edge - listRect.top) / scale, left: inset };
}

// Its own namespace in projectExpandedById, apart from the legacy sidebar's keys.
const activeTreeProjectExpansionKey = (projectKey: string) => `active-tree:${projectKey}`;

function routeThreadOnly(
  threads: readonly EnvironmentThreadShell[],
  routeThreadKey: string | null,
): readonly EnvironmentThreadShell[] {
  if (routeThreadKey === null) return EMPTY_THREADS;
  const routeThread = threads.find((thread) => threadShellKey(thread) === routeThreadKey);
  return routeThread === undefined ? EMPTY_THREADS : [routeThread];
}

// Separate hooks cache maps independently of later Sidebar hooks and preserve dnd-kit inputs.
function useSidebarThreads(input: {
  readonly projectScopeKey: string | null;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  readonly optimisticDrop: SidebarOptimisticDrop | null;
  readonly optimisticGroupOrder: SidebarOptimisticGroupOrder | null;
  /** The open draft's project, so a collapsed project opens for it too. */
  readonly routeDraftProject: { readonly environmentId: string; readonly projectId: string } | null;
  readonly environmentScopeId: EnvironmentId | null;
  readonly projectGroups: readonly SidebarProjectSnapshot[];
  /** Threads on the filtered machine; `allThreads` ignores the machine filter. */
  readonly threads: readonly EnvironmentThreadShell[];
  readonly allThreads: readonly EnvironmentThreadShell[];
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly routeRowThreadKey: string | null;
  // Set in boring mode: the project groups to fold active threads into, in order.
  readonly folderGroups: readonly SidebarProjectSnapshot[] | null;
  // Keeps folders with no active threads, so a project the user filtered to can start one.
  readonly keepEmptyFolders: boolean;
}) {
  const {
    projectScopeKey,
    scopedProjectKeys,
    serverConfigs,
    optimisticDrop,
    optimisticGroupOrder,
    routeDraftProject,
    environmentScopeId,
    projectGroups,
    threads,
    allThreads,
    delegatedUnderParent,
    routeRowThreadKey,
    folderGroups,
    keepEmptyFolders: keepEmpty,
  } = input;
  const allThreadGroups = useThreadGroups();
  // The machine filter hides other machines' groups as well as their threads.
  const threadGroupByKey = indexThreadGroups(
    environmentScopeId === null
      ? allThreadGroups
      : allThreadGroups.filter((group) => group.environmentId === environmentScopeId),
  );
  // Folders already separate the work, so boring mode has no Working shelf.
  const workingShelfEnabled =
    useClientSettings((s) => s.sidebarWorkingShelfEnabled) && folderGroups === null;
  const soloGroupsEnabled = useClientSettings((s) => s.sidebarSoloGroupsEnabled);
  const groupOrder = useUiStateStore((store) => store.groupOrder);
  const inboxReturnsVersion = useSyncExternalStore(
    inboxReturns.subscribe,
    inboxReturns.getSnapshot,
  );
  const nowMinute = useNowMinute();
  // Minute-quantized clocks would delay second-precise snooze wakes by up to a minute.
  // Snoozed groups wake on the same tick as snoozed chats.
  const snoozeWakeClock = useSnoozeWakeClock([...threads, ...threadGroupByKey.values()]);
  const [settledShelfExpanded, setSettledShelfExpanded] = useLocalStorage(
    SETTLED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useLocalStorage(
    SNOOZED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const [workingShelfExpanded, setWorkingShelfExpanded] = useLocalStorage(
    WORKING_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  // The settled tail restarts whenever the machine or project scope changes.
  const settledScopeKey = `${environmentScopeId ?? "all"}|${projectScopeKey ?? "all"}`;
  // Shared with the old per-project sidebar, so folders keep their open state.
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const [settledTail, setSettledTail] = useState({
    scopeKey: settledScopeKey,
    count: SETTLED_TAIL_INITIAL_COUNT,
  });
  if (settledTail.scopeKey !== settledScopeKey) {
    setSettledTail({ scopeKey: settledScopeKey, count: SETTLED_TAIL_INITIAL_COUNT });
  }
  const settledVisibleCount =
    settledTail.scopeKey === settledScopeKey ? settledTail.count : SETTLED_TAIL_INITIAL_COUNT;

  const partition = partitionSidebarThreads({
    threads,
    allThreads,
    threadGroupByKey,
    soloGroupsEnabled,
    optimisticGroupOrder,
    scopedProjectKeys,
    delegatedUnderParent,
    serverConfigs,
    optimisticDrop,
    workingShelfEnabled,
    sortActiveBySend: folderGroups !== null,
    clockKey: `${nowMinute}:${snoozeWakeClock}:${inboxReturnsVersion}`,
  });

  const {
    pinnedThreads,
    activeThreads,
    workingThreads,
    snoozedThreads,
    settledThreads,
    pinnedGroups,
    activeGroups,
    snoozedGroups,
    settledGroups,
    groupedThreads,
    groupKeyByThreadKey,
  } = partition;
  // Older settled threads load in pages; the shelf lists them only as far as they are loaded.
  const olderSettledShelf = useOlderSettledShelf({
    scopes: olderSettledScopes([...serverConfigs.keys()], scopedProjectKeys),
    expanded: settledShelfExpanded,
    visibleCount: settledVisibleCount,
  });
  const listedSettledThreads = settledThreads.filter(olderSettledShelf.isListed);
  useOlderSettledShelfGrowth(olderSettledShelf, listedSettledThreads);
  const settledCount =
    settledThreads.length + olderSettledShelf.unloadedCount(partition.visibleThreads);
  const visibleSettledThreads = (() => {
    const visible = listedSettledThreads.slice(0, settledVisibleCount);
    if (
      routeRowThreadKey !== null &&
      !visible.some((thread) => threadShellKey(thread) === routeRowThreadKey)
    ) {
      const routeThread = settledThreads.find(
        (thread) => threadShellKey(thread) === routeRowThreadKey,
      );
      if (routeThread !== undefined) visible.push(routeThread);
    }
    return visible.length === settledThreads.length ? settledThreads : visible;
  })();
  const renderedSettledThreads = settledShelfExpanded
    ? visibleSettledThreads
    : routeThreadOnly(visibleSettledThreads, routeRowThreadKey);
  const visibleSnoozedThreads = snoozedShelfExpanded
    ? snoozedThreads
    : routeThreadOnly(snoozedThreads, routeRowThreadKey);
  const visibleWorkingThreads = workingShelfExpanded
    ? workingThreads
    : routeThreadOnly(workingThreads, routeRowThreadKey);

  // Groups: expansion persists per group. Navigating into a group's chat
  // opens the group once (written to the preference), so the user can still
  // collapse it afterwards.
  const groupExpandedById = useUiStateStore((store) => store.groupExpandedById);
  const setGroupExpanded = useUiStateStore((store) => store.setGroupExpanded);
  const routeGroupKey = resolveForcedOpenGroupKey({
    routeThreadKey: routeRowThreadKey,
    groupKeyByThreadKey,
  });
  const lastRouteGroupKeyRef = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the router: entering a group's chat persists that group open once, and the user can still collapse it
  useLayoutEffect(() => {
    if (routeGroupKey !== null && routeGroupKey !== lastRouteGroupKeyRef.current) {
      setGroupExpanded(routeGroupKey, true);
    }
    lastRouteGroupKeyRef.current = routeGroupKey;
  }, [lastRouteGroupKeyRef, routeGroupKey, setGroupExpanded]);
  // Snoozed and Settled groups start collapsed; toggles there are
  // session-only so the persisted Active choice is never overwritten.
  const parkedGroupKeys = new Set([...snoozedGroups, ...settledGroups].map((entry) => entry.key));
  const [parkedGroupExpanded, setParkedGroupExpanded] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const isGroupExpanded = (groupKey: string) =>
    resolveSidebarGroupExpanded({
      groupKey,
      parked: parkedGroupKeys.has(groupKey),
      persisted: resolveGroupExpanded(groupExpandedById, groupKey, { forced: false }),
      parkedOverride: parkedGroupExpanded.get(groupKey),
      routeGroupKey,
    });
  const toggleGroupExpanded = (groupKey: string, expanded: boolean) => {
    if (parkedGroupKeys.has(groupKey)) {
      setParkedGroupExpanded((current) => new Map(current).set(groupKey, expanded));
    } else {
      setGroupExpanded(groupKey, expanded);
    }
  };
  // Tree headings name logical projects, the same keys the project scope uses.
  const logicalProjectKeyByPhysicalKey = new Map<string, string>(
    projectGroups.flatMap((group) =>
      group.memberProjects.map(
        (project) => [`${project.environmentId}:${project.id}`, group.projectKey] as const,
      ),
    ),
  );
  const treeProjectKeyOf = (item: {
    readonly environmentId: string;
    readonly projectId: string;
  }) => {
    const physicalKey = `${item.environmentId}:${item.projectId}`;
    return logicalProjectKeyByPhysicalKey.get(physicalKey) ?? physicalKey;
  };
  const isProjectCollapsed = (projectKey: string) =>
    projectExpandedById[activeTreeProjectExpansionKey(projectKey)] === false;
  const toggleProjectCollapsed = (projectKey: string, collapsed: boolean) =>
    setProjectExpanded(activeTreeProjectExpansionKey(projectKey), !collapsed);
  // Opening a chat or draft in a collapsed project opens the project once.
  const routeThread =
    routeRowThreadKey === null
      ? undefined
      : threads.find((thread) => threadShellKey(thread) === routeRowThreadKey);
  const routeProjectKey =
    routeThread !== undefined
      ? treeProjectKeyOf(routeThread)
      : routeDraftProject === null
        ? null
        : treeProjectKeyOf(routeDraftProject);
  const lastRouteProjectKeyRef = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the router: opening a chat in a collapsed project persists the project open once
  useLayoutEffect(() => {
    if (routeProjectKey !== null && routeProjectKey !== lastRouteProjectKeyRef.current) {
      setProjectExpanded(activeTreeProjectExpansionKey(routeProjectKey), true);
    }
    lastRouteProjectKeyRef.current = routeProjectKey;
  }, [lastRouteProjectKeyRef, routeProjectKey, setProjectExpanded]);
  const projectOrder = projectGroups.map((project) => project.projectKey);
  const buildActiveTree = (ungrouped: readonly EnvironmentThreadShell[]) =>
    buildSidebarActiveTree({
      ungrouped,
      groups: activeGroups,
      projectOrder,
      unitOrder: groupOrder,
      projectKeyOf: treeProjectKeyOf,
      threadKeyOf: threadShellKey,
      groupKeyOf: sidebarThreadGroupKeyOf,
      isExpanded: isGroupExpanded,
      isProjectCollapsed,
    });
  const activeTree = buildActiveTree(activeThreads);
  // Rendered thread rows of the Active tree, in tree order.
  const activeTreeThreads = activeTree.flatMap((entry) =>
    entry.kind === "thread" ? [entry.thread] : [],
  );
  // Group rows of the parked sections. A collapsed shelf hides its groups,
  // except the one holding the open chat, like its thread rows.
  const shownGroups = (entries: readonly SidebarGroupEntry[], shelfExpanded: boolean) =>
    entries
      .filter((entry) => shelfExpanded || entry.key === routeGroupKey)
      .map((entry) => ({
        entry,
        renderedMembers: isGroupExpanded(entry.key) ? entry.members : EMPTY_THREADS,
      }));
  const shownGroupsBySection = {
    pinned: shownGroups(pinnedGroups, true),
    snoozed: shownGroups(snoozedGroups, snoozedShelfExpanded),
    settled: shownGroups(settledGroups, settledShelfExpanded),
  };
  // Only rendered thread rows, in render order: jump hints, traversal and
  // shift-select all walk this list.
  const projectFolders =
    folderGroups === null
      ? null
      : groupSidebarThreadsByProject(
          folderGroups,
          // Folders have no group rows, so active groups' chats sit in their folders as threads.
          sortWorkingThreadsBySend([
            ...activeThreads,
            ...activeGroups.flatMap((entry) => entry.members),
          ]),
          keepEmpty,
        ).map((folder) => {
          const collapsed = !resolveProjectExpanded(
            projectExpandedById,
            sidebarFolderExpansionKeys(folder.group),
          );
          return {
            group: folder.group,
            collapsed,
            // A closed folder still shows the open thread, and hints at the rest.
            threads: collapsed
              ? routeThreadOnly(folder.threads, routeRowThreadKey)
              : folder.threads,
            hiddenThreads: collapsed
              ? folder.threads.filter((thread) => threadShellKey(thread) !== routeRowThreadKey)
              : EMPTY_THREADS,
          };
        });
  const orderedThreads = [
    ...shownGroupsBySection.pinned.flatMap((shown) => shown.renderedMembers),
    ...pinnedThreads,
    ...(projectFolders === null
      ? activeTreeThreads
      : projectFolders.flatMap((folder) => folder.threads)),
    ...visibleWorkingThreads,
    ...shownGroupsBySection.snoozed.flatMap((shown) => shown.renderedMembers),
    ...visibleSnoozedThreads,
    ...shownGroupsBySection.settled.flatMap((shown) => shown.renderedMembers),
    ...renderedSettledThreads,
  ];
  const sectionByThreadKey = new Map<string, SidebarSection>();
  for (const [list, section] of [
    [pinnedThreads, "pinned"],
    [activeThreads, "active"],
    [workingThreads, "working"],
    [snoozedThreads, "snoozed"],
    [settledThreads, "settled"],
  ] as const) {
    for (const thread of list) sectionByThreadKey.set(threadShellKey(thread), section);
  }
  return {
    ...partition,
    threads,
    threadGroupByKey,
    soloGroupsEnabled,
    groupExpandedById,
    setGroupExpanded,
    workingShelfEnabled,
    searchableThreads: [
      ...pinnedThreads,
      ...activeThreads,
      ...workingThreads,
      ...snoozedThreads,
      ...settledThreads,
      ...groupedThreads,
    ],
    sidebarThreadCount:
      pinnedThreads.length +
      activeThreads.length +
      workingThreads.length +
      snoozedThreads.length +
      settledCount +
      groupedThreads.length,
    settledVisibleCount,
    settledCount,
    olderSettledShelf,
    hiddenSettledCount: Math.max(0, settledCount - visibleSettledThreads.length),
    showMoreSettled: () =>
      setSettledTail((current) => ({
        scopeKey: current.scopeKey,
        count: current.count + SETTLED_TAIL_PAGE_COUNT,
      })),
    settledShelfExpanded,
    toggleSettledShelf: () => setSettledShelfExpanded((value) => !value),
    snoozedShelfExpanded,
    toggleSnoozedShelf: () => setSnoozedShelfExpanded((value) => !value),
    workingShelfExpanded,
    toggleWorkingShelf: () => setWorkingShelfExpanded((value) => !value),
    projectFolders,
    toggleProjectFolder: (group: SidebarProjectSnapshot) => {
      const keys = sidebarFolderExpansionKeys(group);
      setProjectExpanded(keys, !resolveProjectExpanded(projectExpandedById, keys));
    },
    renderedSettledThreads,
    visibleSnoozedThreads,
    visibleWorkingThreads,
    isGroupExpanded,
    toggleGroupExpanded,
    isProjectCollapsed,
    toggleProjectCollapsed,
    treeProjectKeyOf,
    buildActiveTree,
    activeTree,
    shownGroupsBySection,
    groupEntryByKey: new Map(
      [...pinnedGroups, ...activeGroups, ...snoozedGroups, ...settledGroups].map(
        (entry) => [entry.key, entry] as const,
      ),
    ),
    orderedThreadKeys: orderedThreads.map(threadShellKey),
    threadByKey: new Map(orderedThreads.map((thread) => [threadShellKey(thread), thread] as const)),
    settledThreadKeys: new Set(settledThreads.map(threadShellKey)),
    snoozedThreadKeys: new Set(snoozedThreads.map(threadShellKey)),
    sectionByThreadKey,
    pinnedKeys: pinnedThreads.map(threadShellKey),
    activeKeys: activeThreads.map(threadShellKey),
    // Hidden and filtered threads keep their keys. Reserve those slots without
    // including the rows in the visible drop order or writing to them.
    pinnedKeysById: new Map(
      threads.map((thread) => [threadShellKey(thread), thread.pinOrderKey ?? null] as const),
    ),
    activeKeysById: new Map(
      threads.map((thread) => [threadShellKey(thread), thread.activeOrderKey ?? null] as const),
    ),
  };
}

function partitionSidebarThreads(input: SidebarThreadPartitionInput) {
  const {
    threads,
    allThreads,
    threadGroupByKey,
    soloGroupsEnabled,
    optimisticGroupOrder,
    scopedProjectKeys,
    delegatedUnderParent,
    serverConfigs,
    optimisticDrop,
    workingShelfEnabled,
    sortActiveBySend,
  } = input;
  const preciseNow = new Date().toISOString();
  const visible = filterSidebarV2VisibleThreads(threads, scopedProjectKeys, delegatedUnderParent);
  // Membership wins: a chat in a known group renders under its group, and
  // only the group's own pin/snooze/settle place it.
  const { ungrouped, byGroup } = partitionThreadsByGroup({
    threads: visible,
    groups: threadGroupByKey,
    showSingleThreadGroups: soloGroupsEnabled,
  });
  const inboxObservation = inboxReturns.observe(workingShelfEnabled ? allThreads : null);
  const pinned: EnvironmentThreadShell[] = [];
  const active: EnvironmentThreadShell[] = [];
  const working: EnvironmentThreadShell[] = [];
  const inbox = (thread: EnvironmentThreadShell, manuallyMoved = false) =>
    workingShelfEnabled &&
    (manuallyMoved ? isThreadWorking(thread) : inboxObservation.isWorking(thread))
      ? working
      : active;
  const snoozed: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  const draggable = new Set<string>();
  // Chats use activity order inside their project or group, so they have no manual slot.
  const activeReorderable = new Set<string>();
  for (const thread of ungrouped) {
    const configLoaded = serverConfigs.has(thread.environmentId);
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (configLoaded) {
      activeReorderable.add(threadKey);
      draggable.add(threadKey);
    }
    if (optimisticDrop?.key === threadKey) {
      const projected = applySidebarThreadDrop(
        thread,
        optimisticDrop.section,
        optimisticDrop.occurredAt,
        optimisticDrop.assignedKeys.get(threadKey),
      );
      (optimisticDrop.section === "pinned"
        ? pinned
        : optimisticDrop.section === "settled"
          ? settled
          : inbox(projected, true)
      ).push(
        optimisticDrop.clearsSnooze
          ? projected
          : { ...projected, snoozedAt: thread.snoozedAt, snoozedUntil: thread.snoozedUntil },
      );
    } else {
      const section = resolveSidebarThreadSection({
        snoozed: configLoaded && effectiveSnoozed(thread, { now: preciseNow }),
        settled: configLoaded && thread.settledOverride === "settled",
        pinned: thread.pinnedAt != null,
      });
      (section === "snoozed"
        ? snoozed
        : section === "settled"
          ? settled
          : section === "pinned"
            ? pinned
            : inbox(thread)
      ).push(thread);
    }
  }
  const sectionGroups: Record<SidebarGroupSection, SidebarGroupEntry[]> = {
    pinned: [],
    active: [],
    snoozed: [],
    settled: [],
  };
  const groupedThreads: EnvironmentThreadShell[] = [];
  const groupKeyByThreadKey = new Map<string, string>();
  for (const [key, canonicalMembers] of byGroup) {
    const group = threadGroupByKey.get(key)!;
    const members =
      optimisticGroupOrder?.groupKey === key
        ? orderItemsByPreferredIds({
            items: canonicalMembers,
            preferredIds: optimisticGroupOrder.order,
            getId: threadShellKey,
          })
        : canonicalMembers;
    const section = resolveSidebarGroupSection({ group, members, now: preciseNow });
    sectionGroups[section].push({ key, group, members, section });
    for (const member of members) {
      groupedThreads.push(member);
      groupKeyByThreadKey.set(threadShellKey(member), key);
    }
  }
  const newestMemberMs = (entry: SidebarGroupEntry) =>
    Math.max(...entry.members.map(sidebarActivityMs));
  // A loaded config gates dragging only; the sort must not depend on it, so web and mobile agree.
  const sortedPinned = sortPinnedThreadsForSidebar(pinned);
  const sortedActive = sortActiveBySend
    ? sortWorkingThreadsBySend(active)
    : workingShelfEnabled
      ? sortInboxThreadsByReturn(active, inboxObservation.returnedAt)
      : sortThreadsForSidebar(active);
  return {
    pinnedThreads:
      optimisticDrop?.section !== "pinned" || optimisticDrop.order === null
        ? sortedPinned
        : orderItemsByPreferredIds({
            items: sortedPinned,
            preferredIds: optimisticDrop.order,
            getId: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          }),
    draggableThreadKeys: draggable,
    activeReorderableThreadKeys: activeReorderable,
    activeThreads:
      optimisticDrop?.section !== "active" || optimisticDrop.order === null
        ? sortedActive
        : orderItemsByPreferredIds({
            items: sortedActive,
            preferredIds: optimisticDrop.order,
            getId: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          }),
    workingThreads: sortWorkingThreadsBySend(working),
    snoozedThreads: snoozed.toSorted(
      (left, right) =>
        firstValidTimestampMs(left.snoozedUntil ?? null) -
        firstValidTimestampMs(right.snoozedUntil ?? null),
    ),
    settledThreads: sortSettledThreads(settled),
    visibleThreads: visible,
    snoozeNow: preciseNow,
    // Groups have no pin order key: newest pin first, above keyed chats.
    pinnedGroups: sectionGroups.pinned.toSorted(
      (left, right) =>
        firstValidTimestampMs(right.group.pinnedAt) - firstValidTimestampMs(left.group.pinnedAt),
    ),
    activeGroups: sectionGroups.active,
    snoozedGroups: sectionGroups.snoozed.toSorted(
      (left, right) =>
        firstValidTimestampMs(left.group.snoozedUntil) -
        firstValidTimestampMs(right.group.snoozedUntil),
    ),
    settledGroups: sectionGroups.settled
      .map((entry) => ({
        entry,
        at: groupSettleStampMs(entry.group, entry.members) ?? newestMemberMs(entry),
      }))
      .toSorted((left, right) => right.at - left.at)
      .map(({ entry }) => entry),
    groupedThreads,
    groupKeyByThreadKey,
  };
}

/** The sidebar's scope per environment: the scoped projects there, or every project. */
function olderSettledScopes(
  environmentIds: ReadonlyArray<EnvironmentId>,
  scopedProjectKeys: ReadonlySet<string> | null,
): ReadonlyArray<OlderSettledScope> {
  if (scopedProjectKeys === null) {
    return environmentIds.map((environmentId) => ({ environmentId, projectIds: null }));
  }
  return environmentIds.flatMap((environmentId) => {
    const prefix = `${environmentId}:`;
    const projectIds = [...scopedProjectKeys].flatMap((key) =>
      key.startsWith(prefix) ? [ProjectId.make(key.slice(prefix.length))] : [],
    );
    return projectIds.length === 0 ? [] : [{ environmentId, projectIds }];
  });
}

function isOptimisticDropReleased(input: {
  readonly optimisticDrop: SidebarOptimisticDrop;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly pinnedKeys: readonly string[];
  readonly activeKeys: readonly string[];
  readonly now: string;
}): boolean {
  const { optimisticDrop, threads, pinnedKeys, activeKeys, now } = input;
  const canonicalByKey = new Map(
    threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
    ]),
  );
  const thread = canonicalByKey.get(optimisticDrop.key);
  if (thread === undefined || thread.archivedAt !== null) {
    return true;
  }
  const canonicalSection = effectiveSnoozed(thread, { now })
    ? "snoozed"
    : thread.settledOverride === "settled"
      ? "settled"
      : thread.pinnedAt != null
        ? "pinned"
        : "active";
  if (
    canonicalSection !== optimisticDrop.sourceSection &&
    canonicalSection !== optimisticDrop.section
  ) {
    return true;
  }
  if (optimisticDrop.order === null) {
    // Settle emits unpin/unsnooze too; hold projected fields and sort times until the whole move completes.
    if (
      canonicalSection === optimisticDrop.section &&
      thread.pinnedAt == null &&
      (!optimisticDrop.clearsSnooze || thread.snoozedUntil == null)
    ) {
      return true;
    }
    return false;
  }
  if (canonicalSection !== optimisticDrop.section) return false;
  if (optimisticDrop.clearsSnooze && thread.snoozedUntil != null) return false;
  const destinationKeys = optimisticDrop.section === "pinned" ? pinnedKeys : activeKeys;
  const canonicalDestination = destinationKeys.flatMap((key) => {
    const canonical = canonicalByKey.get(key);
    return canonical === undefined ? [] : [canonical];
  });
  const keyByThread = new Map(
    canonicalDestination.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      (optimisticDrop.section === "pinned" ? thread.pinOrderKey : thread.activeOrderKey) ?? null,
    ]),
  );
  const heldOrder = optimisticDrop.order;
  const heldKeys = new Set(heldOrder);
  const membershipChanged =
    destinationKeys.length !== heldOrder.length ||
    destinationKeys.some((key) => !heldKeys.has(key));
  const foreignKeyLanded = destinationKeys.some((threadKey) => {
    const currentKey = keyByThread.get(threadKey) ?? null;
    if (currentKey === (optimisticDrop.keysAtDrop.get(threadKey) ?? null)) return false;
    return currentKey !== optimisticDrop.assignedKeys.get(threadKey);
  });
  const allAssignmentsLanded = [...optimisticDrop.assignedKeys].every(
    ([threadKey, orderKey]) => keyByThread.get(threadKey) === orderKey,
  );
  return membershipChanged || foreignKeyLanded || allAssignmentsLanded;
}

// The group order hold ends once its members change or every key write lands.
function isOptimisticGroupOrderReleased(input: {
  readonly optimisticGroupOrder: SidebarOptimisticGroupOrder;
  readonly groupEntryByKey: ReadonlyMap<string, SidebarGroupEntry>;
  readonly threads: readonly EnvironmentThreadShell[];
}): boolean {
  const { optimisticGroupOrder, groupEntryByKey, threads } = input;
  const members = groupEntryByKey.get(optimisticGroupOrder.groupKey)?.members;
  const memberKeys = new Set((members ?? []).map(threadShellKey));
  const membershipChanged =
    memberKeys.size !== optimisticGroupOrder.order.length ||
    optimisticGroupOrder.order.some((key) => !memberKeys.has(key));
  const groupOrderKeyByThread = new Map(
    threads.map((thread) => [threadShellKey(thread), thread.groupOrderKey ?? null]),
  );
  const allAssignmentsLanded = [...optimisticGroupOrder.assignedKeys].every(
    ([threadKey, orderKey]) => groupOrderKeyByThread.get(threadKey) === orderKey,
  );
  return membershipChanged || allAssignmentsLanded;
}

// Sidebar() is large enough that the compiler cannot prove its local maps stay
// unmutated; built inside a hook they reach it frozen and cached.
function useSidebarLookups(environmentScopeId: EnvironmentId | null) {
  const allProjects = useProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environments = useEnvironmentIdentities();
  const serverConfigs = useServerConfigs();
  const providerEntriesByEnvironment = useAtomValue(sidebarProviderEntriesAtom);
  const projects =
    environmentScopeId === null
      ? allProjects
      : allProjects.filter((project) => project.environmentId === environmentScopeId);
  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  // Ctrl's sidebar always follows the manual project order, scoped to the
  // filtered machine; New thread defaults to its top project.
  const orderedProjects = orderSidebarProjects(projects, projectOrder);
  const projectGroups = buildSidebarProjectSnapshots({
    projects: orderedProjects,
    groupScratchProjects: true,
    settings: projectGroupingSettings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
  });
  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
  );
  const projectDisplayNameByKey = new Map(
    projectGroups.flatMap((group) =>
      group.memberProjects.map(
        (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
      ),
    ),
  );
  const projectGroupByScopeKey = new Map(
    projectGroups.map((project) => [project.projectKey, project] as const),
  );
  const projectScopeItems = [
    { value: "all", label: "All projects" },
    ...projectGroups.map((project) => ({ value: project.projectKey, label: project.displayName })),
  ];
  return {
    projects,
    orderedProjects,
    serverConfigs,
    projectGroups,
    environmentLabelById,
    providerEntriesByEnvironment,
    projectByKey,
    projectDisplayNameByKey,
    projectGroupByScopeKey,
    projectScopeItems,
  };
}

function ProjectScopeRowIcon(props: { isSelected: boolean; children: ReactNode }) {
  return (
    <span className="relative flex shrink-0">
      {props.children}
      {props.isSelected ? (
        <span className="pointer-events-none absolute -right-1 -bottom-1 grid size-3 place-items-center rounded-full bg-primary ring-2 ring-popover">
          <CheckIcon className="size-2 text-primary-foreground" strokeWidth={4} aria-hidden />
        </span>
      ) : null}
    </span>
  );
}

function canOperateThreads(
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>,
): boolean {
  return threads.every((thread) =>
    readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
  );
}

function checkThreadOperations(
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>,
): boolean {
  if (canOperateThreads(threads)) return true;
  toastManager.add({
    type: "error",
    title: "Thread action unavailable",
    description: "This connection cannot change one or more selected threads.",
  });
  return false;
}

const SIDEBAR_DRAG_DISTANCE = 6;

const SIDEBAR_DRAG_LABEL_HEIGHT = 24;

const threadSearchResultId = (index: number) => `sidebar-thread-search-result-${index}`;

// Continuations that outlive a render read the open thread from the router.
function readRouteThreadKey(router: AnyRouter): string | null {
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const draft =
    target?.kind === "draft"
      ? useComposerDraftStore.getState().getDraftSession(target.draftId)
      : null;
  const ref = resolveActiveThreadRouteRef(target, draft);
  return ref === null ? null : scopedThreadKey(ref);
}

export default function Sidebar({ routeReveal }: { routeReveal: SidebarRouteReveal }) {
  const environments = useEnvironmentIdentities();
  const storedEnvironmentScopeId = useUiStateStore((store) => store.sidebarEnvironmentScopeId);
  const setStoredEnvironmentScopeId = useUiStateStore(
    (store) => store.setSidebarEnvironmentScopeId,
  );
  const environmentScopeId = resolveSidebarEnvironmentScope(environments, storedEnvironmentScopeId);
  const {
    projects,
    orderedProjects,
    serverConfigs,
    projectGroups,
    environmentLabelById,
    providerEntriesByEnvironment,
    projectByKey,
    projectDisplayNameByKey,
    projectGroupByScopeKey,
    projectScopeItems,
  } = useSidebarLookups(environmentScopeId);
  const delegatedUnderParent = useDelegatedUnderParent();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    confirmAndUnpinThread,
    setThreadAutoSettle,
    turnThreadIntoProject,
    reorderPinnedThread,
    reorderActiveThread,
    markThreadUnread,
    archiveThread,
    deleteThread,
  } = useThreadActions();
  const groupActions = useThreadGroupActions();
  const reorderGroupThread = useOrchestrationCommand(threadEnvironment.reorderGroup, {
    reportFailure: false,
  });
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      toastManager.add({
        type: "success",
        title: "Branch copied",
        description: branch,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy branch",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: ({ threadId }) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: threadId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const boringSidebarEnabled = useBoringSidebarEnabled();
  const folderRowsMultiline = useClientSettings((settings) => settings.boringSidebarMultilineRows);
  const newThreadContext = useHandleNewThread();
  // Row callbacks capture only the handler; the rest of the context changes with the route.
  const { handleNewThread } = newThreadContext;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  // A machine filter flip drops the selection: rows selected under the old
  // filter may be hidden now, and bulk actions must never touch invisible rows.
  const setEnvironmentScopeId = (environmentId: string | null) => {
    clearSelection();
    setStoredEnvironmentScopeId(environmentId);
  };
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const acknowledgeWoke = useAcknowledgeThreadWoke();
  const routeTarget = useThreadRouteTarget();
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const environmentMachineById = useEnvironmentMachines();
  const [environmentPickerOpen, setEnvironmentPickerOpen] = useState(false);
  const environmentPickerShortcut = shortcutLabelForCommand(
    keybindings,
    "environmentPicker.toggle",
  );
  const environmentJumpLabel = (index: number) => {
    const command = ENVIRONMENT_PICKER_JUMP_KEYBINDING_COMMANDS[index];
    return command === undefined
      ? null
      : shortcutLabelForCommand(keybindings, command, {
          context: { environmentPickerOpen: true },
        });
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener for the machine picker shortcuts while mounted
  useEffect(() => {
    if (environments.length <= 1) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen())
        return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused(), environmentPickerOpen },
      });
      if (command === "environmentPicker.toggle") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setEnvironmentPickerOpen((open) => !open);
        return;
      }
      if (!environmentPickerOpen) return;
      const index = ENVIRONMENT_PICKER_JUMP_KEYBINDING_COMMANDS.findIndex(
        (entry) => entry === command,
      );
      if (index < 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (index > 0 && environments[index - 1] === undefined) return;
      setEnvironmentScopeId(index === 0 ? null : environments[index - 1]!.environmentId);
      setEnvironmentPickerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [environmentPickerOpen, environments, keybindings, setEnvironmentScopeId]);
  // Read at click time by New thread, which defaults to the top project of
  // the filtered machine in the same manual order the shortcut uses.
  const orderedProjectsRef = useRef(orderedProjects);
  const projectGroupsRef = useRef(projectGroups);
  const persistedProjectScopeKeys = useUiStateStore((store) => store.sidebarProjectScopeKeys);
  const setPersistedProjectScopeKeys = useUiStateStore((store) => store.setSidebarProjectScopeKeys);
  const [projectScopeMenuState, dispatchProjectScopeMenu] = useReducer(
    reduceSidebarProjectScopeMenuState,
    { open: false, query: "" },
  );
  const projectScopeFilter = useComboboxFilter();
  const allProjectSnapshotsReady = useAllEnvironmentProjectSnapshotsReady();
  const allProjectConfigsReady = useAtomValue(environmentProjects.projectConfigsReadyAtom);
  const headerSearchRef = useRef<HTMLDivElement | null>(null);
  // Safari may click after Ctrl+click opens settings; suppress that selection until the picker reopens.
  const suppressNextScopeChangeRef = useRef(false);
  const highlightedProjectScopeKeyRef = useRef<string | null>(null);
  // Hold dropped rows until server placement is confirmed; block another pickup from replacing the hold.
  const [optimisticDrop, setOptimisticDrop] = useState<SidebarOptimisticDrop | null>(null);
  const [optimisticGroupOrder, setOptimisticGroupOrder] =
    useState<SidebarOptimisticGroupOrder | null>(null);
  const threadSearchInputRef = useRef<HTMLInputElement>(null);
  const [threadSearchQuery, setThreadSearchQuery] = useState("");
  const [searchHighlightKey, setSearchHighlightKey] = useState<string | null>(null);
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const searchEnvironmentIds =
    environmentScopeId === null
      ? connectedEnvironmentIds
      : connectedEnvironmentIds.filter((environmentId) => environmentId === environmentScopeId);
  const queuePendingFileDrop = useSidebarPendingFileDropStore((s) => s.queuePendingFileDrop);
  const clearPendingFileDrop = useSidebarPendingFileDropStore((s) => s.clearPendingFileDrop);
  const [renamingThreadRef, setRenamingThreadRef] = useState<ScopedThreadRef | null>(null);
  const canOperateRenamingThread = useEnvironmentScope(
    renamingThreadRef?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  // Losing operate access cancels the rename without committing the title, so
  // the editor does not return and take focus when access comes back.
  if (renamingThreadRef !== null && !canOperateRenamingThread) setRenamingThreadRef(null);
  const renamingThreadKey =
    renamingThreadRef !== null && canOperateRenamingThread
      ? scopedThreadKey(renamingThreadRef)
      : null;
  const [renamingTitle, setRenamingTitle] = useState("");
  const settlingThreadKeysRef = useRef(new Set<string>());
  const threadListRef = useRef<HTMLUListElement | null>(null);
  const dragLabelOffsetRef = useRef(0);
  const listMotionRef = useRef<ReturnType<typeof createSidebarListMotion> | null>(null);
  const [dragState, setDragState] = useState<{
    readonly activeKey: string;
    readonly activeSection: SidebarSection;
    readonly occurredAt: string;
    readonly activationY: number | null;
    readonly targetSection: SidebarSection | null;
    readonly contextDrag: boolean;
    /** The drag rearranges rows in place; see resolveSidebarArrangement. */
    readonly arranging: boolean;
  } | null>(null);
  // Where an in-place rearrange would land, in list coordinates.
  const [arrangeLine, setArrangeLine] = useState<{
    readonly top: number;
    readonly left: number;
  } | null>(null);
  const dragSensorRef = useRef<SidebarPointerSensor | null>(null);
  const contextDragKeyRef = useRef<string | null>(null);
  const [actionSweep, setActionSweep] = useState<{
    action: SidebarSweepAction;
    keys: ReadonlySet<string>;
  } | null>(null);
  const snoozingThreadKeysRef = useRef(new Set<string>());
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();
  const openAddProjectCommandPalette = () => openCommandPalette({ open: "add-project" });
  const routeThreadRef = resolveActiveThreadRouteRef(routeTarget, routeDraftThread);
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;

  // A selection made under one scope can hold threads the next scope hides.
  const setProjectScopeKeys = (keys: readonly string[]) => {
    clearSelection();
    setPersistedProjectScopeKeys(keys);
  };
  // A scope whose project is gone reads as all projects once every snapshot has
  // loaded. The stored keys are left alone, so the scope returns with its project.
  const chosenProjectScopeKeys = resolveSidebarProjectScopeKeys({
    groups: projectGroups,
    keys: persistedProjectScopeKeys,
    settings: projectGroupingSettings,
    // Under a machine filter the project may just live on another machine, so
    // the scope only goes inactive there and is checked again under All.
    canClearMissingScope:
      environmentScopeId === null && allProjectSnapshotsReady && allProjectConfigsReady,
  });
  const chosenProjectGroups = projectGroups.filter((project) =>
    chosenProjectScopeKeys.includes(project.projectKey),
  );
  const chosenScopeProjectKeys =
    chosenProjectGroups.length === 0
      ? null
      : new Set(
          chosenProjectGroups.flatMap((project) =>
            project.memberProjectRefs.map(
              (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
            ),
          ),
        );
  const allThreads = useQuietThreadShells();
  // The machine filter hides other machines' threads entirely.
  const threads =
    environmentScopeId === null
      ? allThreads
      : allThreads.filter((thread) => thread.environmentId === environmentScopeId);
  const routeRowThreadKey =
    routeThreadRef === null
      ? null
      : scopedThreadKey(
          scopeThreadRef(
            routeThreadRef.environmentId,
            resolveSidebarRowThreadId(
              routeThreadRef.threadId,
              routeThreadRef.environmentId,
              threads,
            ),
          ),
        );
  const isSearchingThreads = threadSearchQuery.trim().length > 0;

  // History, the palette and links can open a thread the scope hides or the list
  // scrolled away; a remount starts at the top, so each mount scrolls to the open
  // thread once. Render decides the widening, so the first frame of the new route
  // already lists the row; the active row's ref callback scrolls to it.
  const { widensScope: revealWidensScope } = resolveSidebarRouteReveal({
    reveal: routeReveal,
    routeKey: routeRowThreadKey,
    isSearching: isSearchingThreads,
    scopedProjectKeys: chosenScopeProjectKeys,
    delegatedUnderParent,
    findThread: (key) => threads.find((candidate) => threadShellKey(candidate) === key),
  });
  const projectScopeKeys = revealWidensScope ? [] : chosenProjectScopeKeys;
  const projectScopeKey = projectScopeKeys.length === 0 ? null : projectScopeKeys.join("\n");
  const toggleProjectScopeKey = (key: string) =>
    setProjectScopeKeys(
      projectScopeKeys.includes(key)
        ? projectScopeKeys.filter((candidate) => candidate !== key)
        : [...projectScopeKeys, key],
    );
  // The widened scope outlives the reveal, so it is written back to the persisted
  // scope. Route changes arrive from history, links and the palette, and only this
  // component holds the project groups that decide a widening, so no single
  // navigation handler can make the write.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes a route reveal's widened project scope back to the persisted sidebar scope and clears selection
  useEffect(() => {
    if (!revealWidensScope) return;
    clearSelection();
    setPersistedProjectScopeKeys([]);
  }, [clearSelection, revealWidensScope, setPersistedProjectScopeKeys]);
  const revealActiveRow = useActiveRowReveal(routeReveal, routeRowThreadKey);
  const showProjectEnvironments = projectGroupsSpanEnvironments(projectGroups);
  const scratchMachineLabelFor = (
    thread: Pick<SidebarThreadSummary, "environmentId" | "projectId">,
  ) => {
    if (!showProjectEnvironments) return null;
    const project = projectByKey.get(`${thread.environmentId}:${thread.projectId}`);
    if (
      !project ||
      !isScratchProject(project, serverConfigs.get(thread.environmentId)?.scratchWorkspaceRoot)
    ) {
      return null;
    }
    return environmentLabelById.get(thread.environmentId) ?? null;
  };
  const selectedProjectScopeItem =
    projectScopeKeys.length > 1
      ? null
      : (projectScopeItems.find((item) => item.value === (projectScopeKeys[0] ?? "all")) ??
        projectScopeItems[0]!);
  const filteredProjectScopeItems = filterSidebarProjectScopeItems({
    items: projectScopeItems,
    query: projectScopeMenuState.query,
    matches: (item, query) =>
      projectScopeFilter.contains(item, query, (candidate) => candidate.label),
  });
  const scopedProjectGroups = revealWidensScope ? [] : chosenProjectGroups;
  const scopedProjectRefs = scopedProjectGroups.flatMap((project) => project.memberProjectRefs);
  const scopedProjectKeys = revealWidensScope ? null : chosenScopeProjectKeys;
  const threadSearch = useThreadSearch(
    searchEnvironmentIds,
    threadSearchQuery,
    scopedProjectGroups.length === 0
      ? {}
      : { projectIds: scopedProjectRefs.map((projectRef) => projectRef.projectId) },
  );
  const routeDraftIdForRows = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  // The open draft's group, from "+ New chat in group".
  const routeDraftGroupKey =
    routeDraftIdForRows !== null &&
    routeDraftThread != null &&
    routeDraftThread.promotedTo == null &&
    routeDraftThread.groupId
      ? threadGroupKey({
          environmentId: routeDraftThread.environmentId,
          groupId: routeDraftThread.groupId,
        })
      : null;
  const visibleDraftSessionCount = useComposerDraftStore((store) => {
    let count = 0;
    for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
      if (session.promotedTo != null) {
        continue;
      }
      if (!composerDraftHasUserContent(store.draftsByThreadKey[draftKey])) {
        continue;
      }
      if (
        scopedProjectKeys !== null &&
        !scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)
      ) {
        continue;
      }
      if (environmentScopeId !== null && session.environmentId !== environmentScopeId) {
        continue;
      }
      count += 1;
    }
    return count;
  });

  const openProjectSettings = useStableCallback(
    (projectGroup: SidebarProjectSnapshot, projectRef?: ScopedProjectRef) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/projects/$projectKey",
        params: {
          projectKey: getSidebarProjectSettingsKey(
            projectGroup,
            projectGroupingSettings,
            projects,
            projectRef,
          ),
        },
      });
    },
  );
  const handleProjectSettings = useStableCallback(
    (
      event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLInputElement>,
      projectGroup: SidebarProjectSnapshot,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      suppressNextScopeChangeRef.current = true;
      dispatchProjectScopeMenu({ type: "project-settings-opened" });
      openProjectSettings(projectGroup);
    },
  );
  const startThreadInProjectFolder = useStableCallback((group: SidebarProjectSnapshot) => {
    if (isMobile) setOpenMobile(false);
    void handleNewThread(scopeProjectRef(group.environmentId, group.id));
  });
  const handleProjectFolderContextMenu = useStableCallback(
    (group: SidebarProjectSnapshot, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      void (async () => {
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            [
              { id: "new-thread", label: "New thread" },
              { id: "copy-path", label: "Copy path" },
              { id: "project-settings", label: "Project settings", icon: "settings" },
            ],
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "new-thread":
            startThreadInProjectFolder(group);
            return;
          case "copy-path":
            copyPathToClipboard(group.workspaceRoot, { path: group.workspaceRoot });
            return;
          case "project-settings":
            openProjectSettings(group);
            return;
        }
      })();
    },
  );

  const {
    pinnedThreads,
    draggableThreadKeys,
    activeReorderableThreadKeys,
    activeThreads,
    workingThreads,
    snoozedThreads,
    settledThreads,
    snoozeNow,
    searchableThreads,
    settledVisibleCount,
    settledCount,
    olderSettledShelf,
    hiddenSettledCount,
    showMoreSettled,
    settledShelfExpanded,
    toggleSettledShelf,
    snoozedShelfExpanded,
    toggleSnoozedShelf,
    workingShelfExpanded,
    toggleWorkingShelf,
    projectFolders,
    toggleProjectFolder,
    renderedSettledThreads,
    visibleSnoozedThreads,
    visibleWorkingThreads,
    orderedThreadKeys,
    threadByKey,
    settledThreadKeys,
    snoozedThreadKeys,
    sectionByThreadKey,
    pinnedKeys,
    activeKeys,
    pinnedKeysById,
    activeKeysById,
    threadGroupByKey,
    soloGroupsEnabled,
    activeGroups,
    snoozedGroups,
    settledGroups,
    groupKeyByThreadKey,
    sidebarThreadCount,
    isGroupExpanded,
    toggleGroupExpanded,
    isProjectCollapsed,
    toggleProjectCollapsed,
    buildActiveTree,
    activeTree,
    shownGroupsBySection,
    groupEntryByKey,
  } = useSidebarThreads({
    projectScopeKey,
    scopedProjectKeys,
    serverConfigs,
    optimisticDrop,
    optimisticGroupOrder,
    routeDraftProject: routeDraftThread ?? null,
    environmentScopeId,
    projectGroups,
    threads,
    allThreads,
    delegatedUnderParent,
    routeRowThreadKey,
    folderGroups: boringSidebarEnabled
      ? scopedProjectGroups.length === 0
        ? projectGroups
        : scopedProjectGroups
      : null,
    keepEmptyFolders: scopedProjectGroups.length > 0,
  });

  // Ranked across environments as the palette ranks them, so one
  // environment's list does not sit above another's better matches; rows
  // already shown keep their places while slower environments answer.
  const threadByMatchKey =
    threadSearch.matches.length === 0
      ? null
      : new Map(
          searchableThreads.map((thread) => [
            threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
            thread,
          ]),
        );
  const rankedServerMatches =
    threadByMatchKey === null
      ? []
      : rankMessageMatches(
          threadSearch.matches,
          (match) => {
            const thread = threadByMatchKey.get(threadSearchMatchKey(match));
            return thread ? threadSearchSubject(thread, null) : undefined;
          },
          foldSearchQuery(threadSearchQuery),
          // oxlint-disable-next-line react/purity -- Recency ranking samples the clock when the search matches change; the compiler recomputes it only then.
          Date.now(),
          // A list filter, as on mobile: a pick would move rows unexplained.
          { picks: false },
        );
  const serverMatchByKey = new Map(
    rankedServerMatches.map((match) => [threadSearchMatchKey(match), match] as const),
  );
  const [shownMessageOrder, setShownMessageOrder] = useState<ShownOrder | null>(null);
  const messageOrder = nextShownOrder(
    shownMessageOrder,
    threadSearch.query,
    [...serverMatchByKey.keys()],
    Number.POSITIVE_INFINITY,
  );
  if (messageOrder !== shownMessageOrder) setShownMessageOrder(messageOrder);
  const { titleMatches: threadTitleResults, contentMatches: threadContentResults } =
    searchSidebarThreads(searchableThreads, threadSearchQuery, new Set(messageOrder.keys));
  const threadSearchResults = [...threadTitleResults, ...threadContentResults];
  // Only rows listed for their messages show one, and open find on it.
  const threadSearchMatchByKey = new Map(
    threadContentResults.flatMap((thread) => {
      const key = threadSearchMatchKey({
        environmentId: thread.environmentId,
        threadId: thread.id,
      });
      const match = serverMatchByKey.get(key);
      return match ? [[key, match] as const] : [];
    }),
  );
  const threadSearchResultKeys = threadSearchResults.map((thread) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  );

  // The highlight follows its thread, so rows that arrive late do not move
  // it under Enter; a new query starts at the top.
  const activeSearchResultIndex = Math.max(
    0,
    searchHighlightKey === null ? 0 : threadSearchResultKeys.indexOf(searchHighlightKey),
  );
  const setActiveSearchResultIndex = (index: number | ((index: number) => number)) =>
    setSearchHighlightKey(
      threadSearchResultKeys[
        typeof index === "function" ? index(activeSearchResultIndex) : index
      ] ?? null,
    );
  const moveSearchHighlight = (step: 1 | -1) => {
    const count = threadSearchResults.length;
    setActiveSearchResultIndex((activeSearchResultIndex + step + count) % count);
  };

  const orderedThreadKeysRef = useRef(orderedThreadKeys);
  // Read changing maps/sets through refs so streamed events preserve row callbacks.
  const threadByKeyRef = useRef(threadByKey);
  const settledThreadKeysRef = useRef(settledThreadKeys);
  const snoozedThreadKeysRef = useRef(snoozedThreadKeys);
  const groupEntryByKeyRef = useRef(groupEntryByKey);
  const groupKeyByThreadKeyRef = useRef(groupKeyByThreadKey);

  const jumpLabelByKey = (() => {
    const mapping = new Map<string, string>();
    for (const [index, threadKey] of orderedThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(index);
      if (!jumpCommand) break;
      const label = shortcutLabelForCommand(keybindings, jumpCommand);
      if (label) mapping.set(threadKey, label);
    }
    return mapping;
  })();

  const navigateToThread = (threadRef: ScopedThreadRef) => {
    if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
      clearSelection();
    }
    setSelectionAnchor(scopedThreadKey(threadRef));
    if (isMobile) {
      setOpenMobile(false);
    }
    return router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  };

  const handleThreadFileDrop = async (threadRef: ScopedThreadRef, files: File[]) => {
    const dropId = queuePendingFileDrop({ threadRef, files });
    const landedBefore =
      router.buildLocation({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      }).pathname === router.state.location.pathname;
    if (landedBefore) return;

    try {
      await navigateToThread(threadRef);
      const landed =
        router.buildLocation({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        }).pathname === router.state.location.pathname;
      if (!landed) clearPendingFileDrop(dropId);
    } catch {
      clearPendingFileDrop(dropId);
    }
  };

  const navigateToDraft = (draftId: DraftId) => {
    clearSelection();
    if (isMobile) {
      setOpenMobile(false);
    }
    void router.navigate({ to: "/draft/$draftId", params: { draftId } });
  };

  const clearThreadSearch = () => {
    setThreadSearchQuery("");
    setSearchHighlightKey(null);
  };
  const selectThreadSearchResult = (thread: EnvironmentThreadShell) => {
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    // A row listed for a message match opens find on it, as the palette does.
    const match = threadSearchMatchByKey.get(
      threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
    );
    const query = threadSearch.query;
    clearThreadSearch();
    navigateToThread(ref);
    if (match) openThreadFindOnQuery(scopedThreadKey(ref), findForMessageMatch(match, query));
  };
  const handleThreadSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && isSearchingThreads) {
      event.preventDefault();
      event.stopPropagation();
      clearThreadSearch();
      return;
    }
    if (threadSearchResults.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSearchHighlight(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSearchHighlight(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const result = threadSearchResults[activeSearchResultIndex];
      if (result) selectThreadSearchResult(result);
    }
  };

  const startThreadRename = (threadRef: ScopedThreadRef, title: string) => {
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
    setRenamingThreadRef(threadRef);
    setRenamingTitle(title);
  };
  const cancelThreadRename = () => setRenamingThreadRef(null);
  const commitThreadRename = (threadRef: ScopedThreadRef, title: string, originalTitle: string) => {
    void (async () => {
      if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
      const trimmed = title.trim();
      setRenamingThreadRef(null);
      if (trimmed.length === 0) {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        return;
      }
      if (trimmed === originalTitle) return;
      const result = await updateThreadMetadata({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, title: trimmed },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };

  const handleThreadClick = (event: ReactMouseEvent, threadRef: ScopedThreadRef) => {
    if (isSidebarNestedLinkClick(event.target)) return;
    const isMac = isMacPlatform(navigator.platform);
    const isModClick = isMac ? event.metaKey : event.ctrlKey;
    const threadKey = scopedThreadKey(threadRef);
    if (isModClick) {
      event.preventDefault();
      // The open chat is always part of a new selection.
      const routeKey = readRouteThreadKey(router);
      if (
        routeKey !== null &&
        routeKey !== threadKey &&
        !useThreadSelectionStore.getState().hasSelection() &&
        threadByKeyRef.current.has(routeKey)
      ) {
        toggleThreadSelection(routeKey);
      }
      toggleThreadSelection(threadKey);
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      rangeSelectTo(threadKey, orderedThreadKeysRef.current);
      return;
    }
    if (isTrailingDoubleClick(event.detail)) {
      return;
    }
    navigateToThread(threadRef);
  };

  // Snapshot navigation before partition mutation; background parks use a null plan.
  const planForwardNavigation = (
    threadKey: string,
    coParkingKeys?: ReadonlySet<string>,
  ): (() => void) | null => {
    if (readRouteThreadKey(router) !== threadKey) return null;
    const shell = threadByKeyRef.current.get(threadKey);
    const orderedKeys = orderedThreadKeysRef.current;
    const settledKeys = settledThreadKeysRef.current;
    const snoozedKeys = snoozedThreadKeysRef.current;
    const currentIndex = orderedKeys.indexOf(threadKey);
    const nextCardKey =
      currentIndex === -1
        ? null
        : ([...orderedKeys.slice(currentIndex + 1), ...orderedKeys.slice(0, currentIndex)].find(
            (key) =>
              !settledKeys.has(key) &&
              !snoozedKeys.has(key) &&
              !coParkingKeys?.has(key) &&
              // A settled chat in a group is parked even though it renders under its group.
              threadByKeyRef.current.get(key)?.settledOverride !== "settled",
          ) ?? null);
    const nextThread = nextCardKey ? threadByKeyRef.current.get(nextCardKey) : null;
    return nextThread
      ? () => navigateToThread(scopeThreadRef(nextThread.environmentId, nextThread.id))
      : shell
        ? () => void handleNewThread(scopeProjectRef(shell.environmentId, shell.projectId))
        : () => void router.navigate({ to: "/" });
  };

  const attemptSettle = (
    threadRef: ScopedThreadRef,
    opts: { coSettlingKeys?: ReadonlySet<string> } = {},
  ) => {
    void (async () => {
      const threadKey = scopedThreadKey(threadRef);
      if (settlingThreadKeysRef.current.has(threadKey)) return;
      settlingThreadKeysRef.current.add(threadKey);
      const navigateAfterSettle = planForwardNavigation(threadKey, opts.coSettlingKeys);
      const result = await settleThread(threadRef);
      settlingThreadKeysRef.current.delete(threadKey);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to settle thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      if (
        shouldNavigateAfterThreadPark({
          threadKey,
          currentThreadKey: readRouteThreadKey(router),
          action: "settle",
          now: new Date().toISOString(),
          thread: readThreadShell(threadRef),
        })
      ) {
        navigateAfterSettle?.();
      }
    })();
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this sidebar's settle handler in the module-level settleAndAdvance registry
  useEffect(() => registerSettleAndAdvance(attemptSettle), [attemptSettle]);
  const settleThreads = (threadKeys: readonly string[]) => {
    const coSettlingKeys = new Set(threadKeys);
    for (const threadKey of threadKeys) {
      const thread = threadByKeyRef.current.get(threadKey);
      if (!thread || thread.settledOverride === "settled") continue;
      attemptSettle(scopeThreadRef(thread.environmentId, thread.id), { coSettlingKeys });
    }
  };
  const attemptUnsettle = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await unsettleThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to un-settle thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const attemptUnsnooze = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await unsnoozeThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to wake thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const restrictBelowPins: Modifier = (args) =>
    restrictBelowSidebarLabel(args, dragLabelOffsetRef.current);
  const dndModifiers = [
    restrictToVerticalAxis,
    restrictBelowPins,
    restrictToFirstScrollableAncestor,
  ];
  const attachListMotionRef = (node: HTMLUListElement) => {
    threadListRef.current = node;
    const motion = createSidebarListMotion(node);
    listMotionRef.current = motion;
    motion.update(false);
    return () => {
      // Search replaces this list while the Sidebar stays mounted, and a drag
      // whose rows are gone can never drop. The compiler memoizes this callback
      // with no deps (it reads only refs), so the cleanup runs only on unmount.
      dragSensorRef.current?.cancel();
      motion.dispose();
      if (listMotionRef.current === motion) listMotionRef.current = null;
      if (threadListRef.current === node) threadListRef.current = null;
    };
  };

  const attachTreeRef = (node: HTMLUListElement) => {
    const detachMotion = attachListMotionRef(node);
    const detachTree = attachSidebarTree(node);
    return () => {
      detachTree?.();
      detachMotion();
    };
  };

  const isContextDrag = dragState?.contextDrag === true || dragState?.activeSection === "working";
  const dragTargetSection = isContextDrag ? null : (dragState?.targetSection ?? null);
  const finishThreadDrag = (started: boolean) => {
    dragSensorRef.current = null;
    contextDragKeyRef.current = null;
    endThreadContextDrag();
    if (started) {
      listMotionRef.current?.release();
      setDragState(null);
      setArrangeLine(null);
    }
  };
  const attachDragSensor = (sensor: SidebarPointerSensor) => {
    dragSensorRef.current = sensor;
  };
  const cancelThreadDrag = () => {
    dragSensorRef.current?.cancel();
  };
  const contextDragThreads = (): ReadonlyArray<ScopedThreadRef> => {
    const key = contextDragKeyRef.current;
    if (key === null) return [];
    const selected = useThreadSelectionStore.getState().selectedThreadKeys;
    const keys = selected.has(key) ? [...selected] : [key];
    return keys.flatMap((candidate) => {
      const ref = parseScopedThreadKey(candidate);
      return ref ? [ref] : [];
    });
  };
  const pointerOutsideThreadList = (point: { x: number; y: number }) => {
    const bounds = threadListRef.current?.getBoundingClientRect();
    return bounds !== undefined && (point.x < bounds.left || point.x > bounds.right);
  };
  const moveThreadContextDrag = (point: { x: number; y: number }) => {
    const contextDrag = contextDragKeyRef.current !== null && pointerOutsideThreadList(point);
    setDragState((current) =>
      current === null || current.contextDrag === contextDrag
        ? current
        : { ...current, contextDrag },
    );
    if (!contextDrag) {
      endThreadContextDrag();
      return false;
    }
    const threads = contextDragThreads();
    const title =
      threadByKeyRef.current.get(contextDragKeyRef.current ?? "")?.title.trim() || "Thread";
    moveThreadContextDragGhost(point, { title, count: threads.length });
    return true;
  };
  const dropThreadContextDrag = (point: { x: number; y: number }) => {
    if (contextDragKeyRef.current === null || !pointerOutsideThreadList(point)) return false;
    dropThreadContext(point, contextDragThreads());
    return true;
  };
  // useSensor memoizes options identity; fresh options rebuild DndContext and every sortable row.
  const pointerSensorOptions = {
    distance: SIDEBAR_DRAG_DISTANCE,
    onAttach: attachDragSensor,
    onFinish: finishThreadDrag,
    onMove: moveThreadContextDrag,
    onDrop: dropThreadContextDrag,
  };
  const dndSensors = useSensors(useSensor(SidebarPointerSensor, pointerSensorOptions));
  const sectionByThreadKeyRef = useRef(sectionByThreadKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed list data to refs read by stable drag and sweep callbacks
  useLayoutEffect(() => {
    projectGroupsRef.current = projectGroups;
    orderedThreadKeysRef.current = orderedThreadKeys;
    threadByKeyRef.current = threadByKey;
    settledThreadKeysRef.current = settledThreadKeys;
    snoozedThreadKeysRef.current = snoozedThreadKeys;
    sectionByThreadKeyRef.current = sectionByThreadKey;
    groupEntryByKeyRef.current = groupEntryByKey;
    groupKeyByThreadKeyRef.current = groupKeyByThreadKey;
    orderedProjectsRef.current = orderedProjects;
  });
  const startActionSweep = useStableCallback(
    (threadRef: ScopedThreadRef, action: SidebarSweepAction, event: PointerEvent) => {
      const originKey = scopedThreadKey(threadRef);
      const originSection = sectionByThreadKeyRef.current.get(originKey);
      const canApply = (key: string) => {
        const thread = threadByKeyRef.current.get(key);
        return (
          thread !== undefined &&
          // Grouped rows have no section of their own and are never swept.
          originSection !== undefined &&
          sectionByThreadKeyRef.current.get(key) === originSection &&
          serverConfigs.has(thread.environmentId)
        );
      };
      let targetKey: string | null = null;
      let sweptKeys: string[] = [];
      const sweepTo = (key: string | null) => {
        if (key === null || key === targetKey) return;
        targetKey = key;
        sweptKeys = resolveSidebarSweepKeys(orderedThreadKeysRef.current, originKey, key, canApply);
        setActionSweep({ action, keys: new Set(sweptKeys) });
      };
      dragSensorRef.current = new SidebarPointerSensor({
        active: originKey,
        event,
        options: {
          distance: SIDEBAR_DRAG_DISTANCE,
          onAttach: () => {},
          onFinish: () => {
            dragSensorRef.current = null;
            setActionSweep(null);
          },
        },
        onPending: () => {},
        onStart: () => sweepTo(originKey),
        onMove: ({ y }) =>
          sweepTo(threadListRef.current && sidebarThreadKeyAtY(threadListRef.current, y)),
        onEnd: () => {
          const keys = sweptKeys.filter(canApply);
          if (action === "settle") {
            settleThreads(keys);
            return;
          }
          for (const key of keys) {
            const ref = parseScopedThreadKey(key);
            if (ref === null) continue;
            if (action === "unsettle") attemptUnsettle(ref);
            else attemptUnsnooze(ref);
          }
        },
        onCancel: () => {},
        onAbort: () => {},
      });
    },
  );
  // Release during render when server state catches up so canonical order appears in the same frame.
  if (
    optimisticDrop !== null &&
    isOptimisticDropReleased({
      optimisticDrop,
      threads,
      pinnedKeys,
      activeKeys,
      now: snoozeNow,
    })
  ) {
    setOptimisticDrop(null);
  }
  if (
    optimisticGroupOrder !== null &&
    isOptimisticGroupOrderReleased({ optimisticGroupOrder, groupEntryByKey, threads })
  ) {
    setOptimisticGroupOrder(null);
  }
  const attemptPin = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await pinThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to pin thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const attemptUnpin = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await confirmAndUnpinThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to unpin thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };

  const handleThreadDragStart = (event: DragStartEvent) => {
    const activeKey = String(event.active.id);
    const isThread = threadByKeyRef.current.has(activeKey);
    // Headings and group rows only rearrange the Active tree; they never
    // drag out as context.
    contextDragKeyRef.current = isThread ? activeKey : null;
    // A grouped chat sits in its group's section.
    const activeGroupKey = groupKeyByThreadKeyRef.current.get(activeKey);
    const activeSection = isThread
      ? (sectionByThreadKey.get(activeKey) ??
        (activeGroupKey === undefined
          ? undefined
          : groupEntryByKeyRef.current.get(activeGroupKey)?.section))
      : "active";
    if (activeSection === undefined) return;
    // Active-tree rows and group chats only rearrange where they are: no
    // section labels open, and the lifted row stays below Pinned.
    const arranging = !isThread || activeSection === "active" || activeGroupKey !== undefined;
    listMotionRef.current?.suspend();
    const list = threadListRef.current;
    // Active rows stay below Pinned; a pinned group's chats stay in Pinned.
    const belowPinned = arranging && activeSection === "active";
    const header = list?.querySelector<HTMLElement>(
      belowPinned
        ? '[data-testid="sidebar-pinned-divider"]'
        : '[data-testid="sidebar-pinned-header"]',
    );
    if (list && header) {
      const listRect = list.getBoundingClientRect();
      const scale = list.offsetWidth > 0 ? listRect.width / list.offsetWidth : 1;
      dragLabelOffsetRef.current =
        header.getBoundingClientRect().top -
        listRect.top +
        (arranging ? 0 : SIDEBAR_DRAG_LABEL_HEIGHT * scale);
    } else {
      dragLabelOffsetRef.current = 0;
    }
    setDragState({
      activeKey,
      activeSection,
      arranging,
      targetSection: activeSection,
      contextDrag: false,
      occurredAt: new Date().toISOString(),
      activationY:
        event.activatorEvent instanceof PointerEvent ? event.activatorEvent.clientY : null,
    });
  };
  const hasProjectFolders = projectFolders !== null && projectFolders.length > 0;
  const sidebarListItemsFresh = ((): readonly SidebarListItem[] => {
    const rowsOf = (
      list: readonly EnvironmentThreadShell[],
      section: SidebarSection,
    ): SidebarListItem[] =>
      list.map((thread) => {
        const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
        return { kind: "thread", key, section };
      });
    // Each group row is followed by its rendered members.
    const groupRowsOf = (
      shown: ReadonlyArray<{
        readonly entry: SidebarGroupEntry;
        readonly renderedMembers: readonly EnvironmentThreadShell[];
      }>,
      section: "pinned" | "snoozed" | "settled",
    ): SidebarListItem[] =>
      shown.flatMap(({ entry, renderedMembers }) => [
        { kind: "group", key: entry.key, section },
        ...renderedMembers.map((thread): SidebarListItem => ({
          kind: "thread",
          key: threadShellKey(thread),
          section,
          groupKey: entry.key,
        })),
      ]);
    // Boring mode keeps a project the user filtered to, so it can start a thread.
    if (!hasProjectFolders && sidebarThreadCount === 0) {
      return [];
    }
    const items: SidebarListItem[] = [{ kind: "marker", marker: "pinned-header" }];
    items.push(...groupRowsOf(shownGroupsBySection.pinned, "pinned"));
    items.push(...rowsOf(pinnedThreads, "pinned"));
    items.push({ kind: "marker", marker: "pinned-divider" });
    items.push({ kind: "marker", marker: "active-placeholder" });
    // Boring mode draws active rows inside its project folders instead.
    if (projectFolders === null) items.push(...activeTree.map(sidebarTreeEntryItem));
    if (workingThreads.length > 0) {
      items.push({ kind: "marker", marker: "working-header" });
      items.push(...rowsOf(visibleWorkingThreads, "working"));
    }
    if (snoozedThreads.length + snoozedGroups.length > 0) {
      items.push({ kind: "marker", marker: "snoozed-header" });
      items.push(...groupRowsOf(shownGroupsBySection.snoozed, "snoozed"));
      items.push(...rowsOf(visibleSnoozedThreads, "snoozed"));
    }
    items.push({ kind: "marker", marker: "settled-header" });
    items.push({ kind: "marker", marker: "settled-placeholder" });
    items.push(...groupRowsOf(shownGroupsBySection.settled, "settled"));
    items.push(...rowsOf(renderedSettledThreads, "settled"));
    return items;
  })();
  // Preserve the list while streamed updates leave order unchanged to retain row memoization.
  const sidebarListItemsKey = sidebarListItemsFresh
    .map((item) =>
      item.kind === "marker"
        ? item.marker
        : item.kind === "thread"
          ? `${item.section}:${item.key}:${item.groupKey ?? ""}`
          : `${sidebarListItemId(item)}:${"section" in item ? item.section : ""}`,
    )
    .join("\n");
  const [sidebarListItemsState, setSidebarListItems] = useState(sidebarListItemsFresh);
  const [sidebarListItemsKeyState, setSidebarListItemsKeyState] = useState(sidebarListItemsKey);
  let sidebarListItems = sidebarListItemsState;
  if (sidebarListItemsKeyState !== sidebarListItemsKey) {
    setSidebarListItemsKeyState(sidebarListItemsKey);
    setSidebarListItems(sidebarListItemsFresh);
    // Update the local list too; threadByKey already omits rows moved into collapsed shelves.
    sidebarListItems = sidebarListItemsFresh;
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the dnd-kit drag sensor when the dragged row leaves the list
  useEffect(() => {
    if (
      dragState !== null &&
      !sidebarListItems.some((item) => sidebarListItemId(item) === dragState.activeKey)
    ) {
      cancelThreadDrag();
    }
  }, [cancelThreadDrag, dragState, sidebarListItems]);
  // Only order, section, or draft changes need layout reads and motion.
  const listMotionLayoutKey = [
    sidebarListItemsKey,
    projectFolders
      ?.map((folder) => `${folder.group.projectKey}:${folder.threads.length}`)
      .join("\n") ?? "",
    visibleDraftSessionCount,
    routeDraftIdForRows ?? "",
  ].join("\0");
  const listMotionAnimate =
    dragState === null && sidebarListItems.length + visibleDraftSessionCount > 0;
  // Cache on both fields so layout-key changes trigger the effect even when animate is unchanged.
  const listMotionPass = { layoutKey: listMotionLayoutKey, animate: listMotionAnimate };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the list motion controller to animate or not after each layout-affecting commit
  useLayoutEffect(() => {
    listMotionRef.current?.update(listMotionPass.animate);
  }, [listMotionPass]);
  // A drag that rearranges rows in place: projects, the groups and lone
  // chats inside a project, and the chats inside a group.
  const resolveArrangement = (activeId: string, overId: string) => {
    const arrangement = resolveSidebarArrangement({ items: sidebarListItems, activeId, overId });
    if (arrangement?.kind !== "member") return arrangement;
    // A group's chat order lives on the server, which must be able to store it.
    const thread = threadByKey.get(activeId);
    return thread !== undefined &&
      serverConfigs.get(thread.environmentId)?.environment.capabilities.threadGroupReorder === true
      ? arrangement
      : null;
  };
  // Order is per device, like project order: the drop writes the full order
  // of what it rearranged and leaves everything else in place.
  const commitArrangement = (arrangement: SidebarArrangement) => {
    const store = useUiStateStore.getState();
    if (arrangement.kind === "unit") {
      const shells = readThreadShells();
      store.setGroupOrder(
        pruneSidebarUnitOrder({
          order: mergeSidebarOrder(store.groupOrder, arrangement.order),
          placed: arrangement.order,
          liveKeys: new Set([
            ...shells.map(threadShellKey),
            ...indexThreadGroups(readThreadGroups()).keys(),
          ]),
          chatGroupKeys: shells.flatMap((thread) => {
            const groupKey = sidebarThreadGroupKeyOf(thread);
            return groupKey === null ? [] : [[threadShellKey(thread), groupKey] as const];
          }),
        }),
      );
      return;
    }
    const logicalOrder = mergeSidebarOrder(
      projectGroups.map((project) => project.projectKey),
      arrangement.order,
    );
    const physicalOrder = logicalOrder.flatMap(
      (projectKey) =>
        projectGroupByScopeKey.get(projectKey)?.memberProjects.map(getProjectOrderKey) ?? [],
    );
    const placed = new Set(physicalOrder);
    store.setProjectOrder([
      ...physicalOrder,
      ...orderedProjects.map(getProjectOrderKey).filter((key) => !placed.has(key)),
    ]);
  };
  const handleThreadDragOver = (event: DragOverEvent) => {
    const activeKey = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    const arrangement = overId === null ? null : resolveArrangement(activeKey, overId);
    // Rearranging changes no section, so no section reads as the target;
    // nor does any hover of a grouped chat, which only reorders its group.
    const target =
      overId === null || arrangement !== null || groupKeyByThreadKey.has(activeKey)
        ? null
        : resolveSidebarDropTarget(sidebarListItems, activeKey, overId);
    setDragState((current) =>
      current === null || current.activeKey !== activeKey
        ? current
        : { ...current, targetSection: target?.section ?? null },
    );
    const line = arrangement?.line ?? null;
    setArrangeLine(line === null ? null : measureArrangeLine(threadListRef.current, line));
  };
  const sortableIds = sidebarListItems.map(sidebarListItemId);
  // Keep non-drag orders constant to preserve sorting strategy and row identity during streaming.
  const { settledOrder: draggedSettledOrder, activeOrder: draggedActiveOrder } =
    dragState === null
      ? NO_DRAGGED_ORDERS
      : resolveDraggedOrders({
          drag: dragState,
          threadByKey,
          settledThreads,
          activeThreads,
          buildActiveTree,
        });
  const sidebarSortingStrategy = createSidebarSortingStrategy({
    items: sidebarListItems,
    enabled: !isContextDrag,
    boundaryLabelHeight: dragState?.arranging ? 0 : SIDEBAR_DRAG_LABEL_HEIGHT,
    settledOrder: draggedSettledOrder,
    ...(draggedActiveOrder === undefined ? {} : { activeOrder: draggedActiveOrder }),
    settledExpanded: settledShelfExpanded,
    settledVisibleCount,
    routeThreadKey: routeRowThreadKey,
    snoozedThreadCount: snoozedThreads.length + snoozedGroups.length,
    // Every hover of a grouped chat leaves the list in place.
    holdsLayout: (activeId) => groupKeyByThreadKey.has(activeId),
    arranges: (activeId, overId) => resolveArrangement(activeId, overId) !== null,
  });
  const draggedThreadKey = dragState?.activeKey;
  const draggedFromSection = dragState?.activeSection;
  const dragActivationY = dragState?.activationY;
  const dndCollisionDetection = (() => {
    if (draggedThreadKey === undefined || draggedFromSection === undefined)
      return createSidebarCollisionDetection(() => true);
    const source = threadByKey.get(draggedThreadKey);
    if (source === undefined) {
      return createSidebarCollisionDetection(
        (id) => resolveArrangement(draggedThreadKey, id) !== null,
      );
    }
    return createSidebarCollisionDetection(
      (id) => {
        if (resolveArrangement(draggedThreadKey, id) !== null) return true;
        // A grouped chat's own pin and settle state no longer place it.
        if (groupKeyByThreadKey.has(draggedThreadKey)) return false;
        const target = resolveSidebarDropTarget(sidebarListItems, draggedThreadKey, id);
        if (target === null) return false;
        return (
          planSidebarThreadDrop({
            activeKey: draggedThreadKey,
            activeSection: draggedFromSection,
            activePinned: source.pinnedAt != null,
            activeSettled: source.settledOverride === "settled",
            supportsSettlement: serverConfigs.has(source.environmentId),
            target,
            pinnedOrder: pinnedKeys,
            pinnedKeysById,
            reorderableKeys: draggableThreadKeys,
            activeOrder: activeKeys,
            activeKeysById,
            activeReorderableKeys: activeReorderableThreadKeys,
            activeTimeOrdered: true,
          }).kind !== "none"
        );
      },
      {
        items: sidebarListItems,
        activationY: dragActivationY ?? null,
      },
    );
  })();
  const handleThreadDragEnd = (event: DragEndEvent) => {
    const activeKey = String(event.active.id);
    const arrangement =
      event.over === null ? null : resolveArrangement(activeKey, String(event.over.id));
    if (arrangement !== null && arrangement.kind !== "member") {
      if (arrangement.changed) commitArrangement(arrangement);
      return;
    }
    if (arrangement !== null) {
      const reorderGroupKey = arrangement.scopeKey;
      if (!arrangement.changed || reorderGroupKey === null) return;
      const members = groupEntryByKey.get(reorderGroupKey)?.members ?? [];
      const order = arrangement.order;
      const assignments = planGroupMemberReorder({
        orderedIds: order,
        keysById: new Map(members.map((thread) => [threadShellKey(thread), thread.groupOrderKey])),
        movedId: activeKey,
      });
      if (assignments.length === 0 || !checkThreadOperations(members)) return;
      const groupDrop = {
        groupKey: reorderGroupKey,
        order,
        assignedKeys: new Map(assignments.map(({ id, orderKey }) => [id, orderKey])),
      };
      setOptimisticGroupOrder(groupDrop);
      void (async () => {
        // Writes run bottom-up (see planGroupMemberReorder); stop on failure so the
        // keys already written keep their planned order.
        for (const assignment of assignments) {
          const thread = threadByKey.get(assignment.id);
          if (thread === undefined) continue;
          const result = await reorderGroupThread({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, orderKey: assignment.orderKey },
          });
          if (result._tag === "Success") continue;
          // A late failure must not cancel a newer drag's preview.
          setOptimisticGroupOrder((current) => (current === groupDrop ? null : current));
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to reorder chats",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
      })();
      return;
    }
    // Grouped chats otherwise move only between groups.
    if (groupKeyByThreadKey.has(activeKey)) return;
    const activeSection = sectionByThreadKey.get(activeKey);
    const target =
      event.over === null
        ? null
        : resolveSidebarDropTarget(sidebarListItems, activeKey, String(event.over.id));
    const activeThread = threadByKey.get(activeKey);
    if (activeSection === undefined || target === null || activeThread === undefined) return;
    const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    const plan = planSidebarThreadDrop({
      activeKey,
      activeSection,
      activePinned: activeThread.pinnedAt != null,
      activeSettled: activeThread.settledOverride === "settled",
      supportsSettlement: serverConfigs.has(activeThread.environmentId),
      target,
      pinnedOrder: pinnedKeys,
      pinnedKeysById,
      reorderableKeys: draggableThreadKeys,
      activeOrder: activeKeys,
      activeKeysById,
      activeReorderableKeys: activeReorderableThreadKeys,
      // Chat drops change lifecycle; project and group placement stays fixed.
      activeTimeOrdered: true,
    });
    if (plan.kind === "none") return;
    if (plan.kind === "settle" && settlingThreadKeysRef.current.has(activeKey)) return;
    const assignments =
      plan.kind === "pin"
        ? [
            ...(plan.orderKey === undefined ? [] : [{ id: activeKey, orderKey: plan.orderKey }]),
            ...plan.extraAssignments,
          ]
        : plan.kind === "reorder-pinned" || plan.kind === "move-active"
          ? plan.assignments
          : [];
    if (
      !checkThreadOperations(
        [activeKey, ...assignments.map(({ id }) => id)].flatMap((key) => {
          const thread = threadByKey.get(key);
          return thread ? [thread] : [];
        }),
      )
    )
      return;
    const drop = {
      key: activeKey,
      sourceSection: activeSection,
      section: target.section,
      occurredAt: new Date().toISOString(),
      clearsSnooze:
        plan.kind === "pin" ||
        plan.kind === "settle" ||
        (plan.kind === "move-active" && plan.unsnooze),
      order: plan.kind === "settle" ? null : plan.order,
      keysAtDrop: target.section === "active" ? activeKeysById : pinnedKeysById,
      assignedKeys: new Map(assignments.map(({ id, orderKey }) => [id, orderKey])),
    };
    setOptimisticDrop(drop);
    void (async () => {
      const run = async (
        operation: Promise<AtomCommandResult<unknown, unknown>>,
        title: string,
      ) => {
        const result = await operation;
        if (result._tag === "Success") return true;
        setOptimisticDrop((current) => (current === drop ? null : current));
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title,
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return false;
      };
      switch (plan.kind) {
        case "settle": {
          settlingThreadKeysRef.current.add(activeKey);
          const navigateAfterSettle = planForwardNavigation(activeKey);
          const settled = await run(settleThread(threadRef), "Failed to settle thread").finally(
            () => settlingThreadKeysRef.current.delete(activeKey),
          );
          if (
            settled &&
            shouldNavigateAfterThreadPark({
              threadKey: activeKey,
              currentThreadKey: readRouteThreadKey(router),
              action: "settle",
              now: new Date().toISOString(),
              thread: readThreadShell(threadRef),
            })
          )
            navigateAfterSettle?.();
          return;
        }
        case "move-active":
          if (plan.unpin && !(await run(unpinThread(threadRef), "Failed to unpin thread"))) return;
          if (
            plan.unsettle &&
            !(await run(unsettleThread(threadRef), "Failed to un-settle thread"))
          )
            return;
          if (plan.unsnooze && !(await run(unsnoozeThread(threadRef), "Failed to wake thread")))
            return;
          break;
        case "pin":
          if (
            !(await run(
              pinThread(threadRef, plan.orderKey === undefined ? {} : { orderKey: plan.orderKey }),
              "Failed to pin thread",
            ))
          )
            return;
          break;
        case "reorder-pinned":
          break;
      }
      const keyWrites = plan.kind === "pin" ? plan.extraAssignments : plan.assignments;
      for (const assignment of keyWrites) {
        const thread = threadByKey.get(assignment.id);
        if (thread === undefined) continue;
        if (
          !(await run(
            (plan.kind === "move-active" ? reorderActiveThread : reorderPinnedThread)(
              scopeThreadRef(thread.environmentId, thread.id),
              assignment.orderKey,
            ),
            plan.kind === "move-active"
              ? "Failed to reorder active threads"
              : "Failed to reorder pinned threads",
          ))
        )
          return;
      }
    })();
  };
  const performSnooze = async (
    threadRef: ScopedThreadRef,
    preset: Pick<SnoozePreset, "snoozedUntil">,
    opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
  ) => {
    const threadKey = scopedThreadKey(threadRef);
    if (snoozingThreadKeysRef.current.has(threadKey)) {
      return { status: "skipped" } as const;
    }
    snoozingThreadKeysRef.current.add(threadKey);
    const navigateAfterSnooze = planForwardNavigation(threadKey, opts.coSnoozingKeys);
    const result = await snoozeThread(threadRef, preset.snoozedUntil);
    snoozingThreadKeysRef.current.delete(threadKey);
    if (result._tag === "Failure") {
      return isAtomCommandInterrupted(result)
        ? ({ status: "interrupted" } as const)
        : ({ status: "failure", error: squashAtomCommandFailure(result) } as const);
    }
    if (
      shouldNavigateAfterThreadPark({
        threadKey,
        currentThreadKey: readRouteThreadKey(router),
        action: "snooze",
        // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
        now: new Date().toISOString(),
        thread: readThreadShell(threadRef),
      })
    ) {
      navigateAfterSnooze?.();
    }
    return { status: "success" } as const;
  };
  const attemptSnooze = (
    threadRef: ScopedThreadRef,
    preset: Pick<SnoozePreset, "snoozedUntil">,
    opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
  ) => {
    void (async () => {
      const outcome = await performSnooze(threadRef, preset, opts);
      if (outcome.status === "failure") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to snooze thread",
            description:
              outcome.error instanceof Error ? outcome.error.message : "An error occurred.",
          }),
        );
        return;
      }
    })();
  };

  const handleMultiSelectContextMenu = useStableCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const selectedThreadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      const threadKeys = selectedThreadKeys.filter((threadKey) =>
        threadByKeyRef.current.has(threadKey),
      );
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;
      // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
      const selectionNow = new Date();
      const selectedThreads = threadKeys.flatMap((threadKey) => {
        const thread = threadByKeyRef.current.get(threadKey);
        return thread ? [thread] : [];
      });
      const settlingThreads = selectedThreads.filter(
        (thread) => thread.settledOverride !== "settled",
      );
      const canSnoozeSelection = selectedThreads.every(
        (thread) =>
          serverConfigs.has(thread.environmentId) &&
          canSnooze(thread, { now: selectionNow.toISOString() }),
      );
      const titleRegenerationThreads = selectedThreads.filter((thread) =>
        serverConfigs.has(thread.environmentId),
      );
      const regeneratableTitleThreads = titleRegenerationThreads.filter(
        (thread) => thread.titleRegeneration == null,
      );
      const titleRegenerationMenuItem = buildBulkTitleRegenerationContextMenuItem({
        supportedCount: titleRegenerationThreads.length,
        actionableCount: regeneratableTitleThreads.length,
      });
      const pinnedSelectedThreads = selectedThreads.filter(
        (thread) => serverConfigs.has(thread.environmentId) && thread.pinnedAt != null,
      );
      const unpinMenuItem = buildBulkUnpinContextMenuItem({
        pinnedCount: pinnedSelectedThreads.length,
      });
      // Presets sync across environments, so the first selected thread's stand for all.
      // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
      const menuOpenedAt = new Date();
      const snoozePresets = resolveSnoozePresets(
        menuOpenedAt,
        timestampFormat,
        selectedThreads[0]!.environmentId,
      );
      // The open chat anchors a grouping: the others join its group.
      const groupAnchor =
        selectedThreads.find(
          (thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) ===
            readRouteThreadKey(router),
        ) ?? selectedThreads[0];
      const groupTarget =
        groupAnchor === undefined ||
        serverConfigs.get(groupAnchor.environmentId)?.environment.capabilities.threadGroups !== true
          ? null
          : resolveGroupThreadsTarget(selectedThreads, groupAnchor);
      const groupTargetTitle =
        groupTarget?.groupId == null || groupAnchor === undefined
          ? null
          : (threadGroupByKey.get(
              threadGroupKey({
                environmentId: groupAnchor.environmentId,
                groupId: groupTarget.groupId,
              }),
            )?.title ?? null);
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            ...(groupTarget !== null
              ? [
                  {
                    id: "group",
                    label:
                      groupTargetTitle === null
                        ? `Group chats (${count})`
                        : `Move to “${groupTargetTitle}” (${groupTarget.moving})`,
                    disabled: !canOperateThreads(selectedThreads),
                  },
                ]
              : []),
            ...(unpinMenuItem
              ? [{ ...unpinMenuItem, disabled: !canOperateThreads(pinnedSelectedThreads) }]
              : []),
            {
              id: "settle",
              label: `Settle (${count})`,
              disabled: settlingThreads.length === 0 || !canOperateThreads(settlingThreads),
            },
            ...(canSnoozeSelection
              ? [
                  {
                    id: "snooze",
                    label: `Snooze (${count})`,
                    disabled: !canOperateThreads(selectedThreads),
                    children: [
                      ...snoozePresets.map((preset) => ({
                        id: `snooze:${preset.id}`,
                        label: `${preset.label} (${preset.whenLabel})`,
                        disabled: !canOperateThreads(selectedThreads),
                      })),
                      {
                        id: "snooze:custom",
                        label: "Custom…",
                        separatorBefore: snoozePresets.length > 0,
                        disabled: !canOperateThreads(selectedThreads),
                      },
                    ],
                  },
                ]
              : []),
            ...(titleRegenerationMenuItem
              ? [
                  {
                    ...titleRegenerationMenuItem,
                    disabled:
                      titleRegenerationMenuItem.disabled ||
                      !canOperateThreads(regeneratableTitleThreads),
                  },
                ]
              : []),
            { id: "mark-unread", label: `Mark unread (${count})` },
            {
              id: "delete",
              label: `Delete (${count})`,
              destructive: true,
              disabled: !canOperateThreads(selectedThreads),
            },
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure" || clicked.value === null) return;
      const actionTargets =
        clicked.value === "unpin"
          ? pinnedSelectedThreads
          : clicked.value === "regenerate-title"
            ? regeneratableTitleThreads
            : clicked.value === "settle"
              ? settlingThreads.flatMap((thread) => {
                  const current = threadByKeyRef.current.get(
                    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
                  );
                  return current && current.settledOverride !== "settled" ? [current] : [];
                })
              : selectedThreads;
      if (clicked.value === "settle" && actionTargets.length === 0) return;
      if (clicked.value !== "mark-unread" && !checkThreadOperations(actionTargets)) return;
      if (clicked.value === "group") {
        if (groupAnchor === undefined) return;
        clearSelection();
        await groupActions.groupThreads(selectedThreads, groupAnchor);
        return;
      }
      if (clicked.value?.startsWith("snooze:")) {
        const preset =
          clicked.value === "snooze:custom"
            ? await requestCustomSnooze()
            : pickSnoozePreset(
                snoozePresets,
                clicked.value.slice("snooze:".length),
                timestampFormat,
                selectedThreads[0]!.environmentId,
              );
        if (preset) {
          const coSnoozingKeys = new Set(threadKeys);
          clearSelection();
          const outcomes = await Promise.all(
            selectedThreads.map(async (thread) => {
              const threadRef = scopeThreadRef(thread.environmentId, thread.id);
              const outcome = await performSnooze(threadRef, preset, { coSnoozingKeys });
              return { outcome, threadRef };
            }),
          );
          const snoozedThreadRefs = outcomes.flatMap(({ outcome, threadRef }) =>
            outcome.status === "success" ? [threadRef] : [],
          );
          const failures = outcomes.flatMap(({ outcome }) =>
            outcome.status === "failure" ? [outcome.error] : [],
          );

          if (failures.length > 0) {
            const firstError = failures[0];
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title:
                  snoozedThreadRefs.length > 0
                    ? `Failed to snooze ${failures.length} thread${failures.length === 1 ? "" : "s"}`
                    : "Failed to snooze threads",
                description:
                  firstError instanceof Error ? firstError.message : "An error occurred.",
              }),
            );
          }
        }
        return;
      }
      if (clicked.value === "unpin") {
        for (const thread of pinnedSelectedThreads) {
          attemptUnpin(scopeThreadRef(thread.environmentId, thread.id));
        }
        clearSelection();
        return;
      }
      if (clicked.value === "regenerate-title") {
        for (const thread of regeneratableTitleThreads) {
          const result = await updateThreadMetadata({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, regenerateTitle: true },
          });
          if (result._tag === "Success") continue;
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to regenerate thread titles",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        clearSelection();
        return;
      }
      if (clicked.value === "settle") {
        settleThreads(
          actionTargets.map((thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          ),
        );
        clearSelection();
        return;
      }
      if (clicked.value === "mark-unread") {
        for (const threadKey of threadKeys) {
          const thread = threadByKeyRef.current.get(threadKey);
          if (thread) markThreadUnread(scopeThreadRef(thread.environmentId, thread.id));
        }
        clearSelection();
        return;
      }
      if (clicked.value !== "delete") return;
      if (confirmThreadDelete) {
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(
            [
              `Delete ${count} thread${count === 1 ? "" : "s"}?`,
              "This permanently clears conversation history for these threads.",
            ].join("\n"),
            { variant: "destructive" },
          ),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
      }
      if (
        !checkThreadOperations(
          threadKeys.flatMap((threadKey) => {
            const thread = threadByKeyRef.current.get(threadKey);
            return thread ? [thread] : [];
          }),
        )
      )
        return;
      const { deletedThreadKeys, firstFailure } = await deleteSelectedThreadEntries({
        entries: threadKeys.map((threadKey) => ({ threadKey })),
        delete: async ({ threadKey }, deletedThreadKeys) => {
          const thread = threadByKeyRef.current.get(threadKey);
          if (!thread) return null;
          return deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
            deletedThreadKeys,
          });
        },
      });
      if (firstFailure !== null) {
        const firstError = squashAtomCommandFailure(firstFailure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete threads",
            description: firstError instanceof Error ? firstError.message : "An error occurred.",
          }),
        );
      }
      removeFromSelection(
        getThreadKeysToDeselectAfterDelete(selectedThreadKeys, deletedThreadKeys, (threadKey) => {
          const threadRef = parseScopedThreadKey(threadKey);
          return threadRef !== null && readThreadShell(threadRef) !== null;
        }),
      );
    },
  );

  const handleDraftContextMenu = useStableCallback(
    (draftId: DraftId, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        const session = useComposerDraftStore.getState().getDraftSession(draftId);
        if (!api || !session || session.promotedTo) return;
        const projectGroup = projectGroupsRef.current.find((group) =>
          group.memberProjectRefs.some(
            (ref) =>
              ref.environmentId === session.environmentId && ref.projectId === session.projectId,
          ),
        );
        const workspacePath =
          session.worktreePath ??
          projectByKey.get(`${session.environmentId}:${session.projectId}`)?.workspaceRoot;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            buildDraftActionMenuItems({
              hasPath: Boolean(workspacePath),
              hasBranch: Boolean(session.branch),
              hasProject: projectGroup != null,
            }),
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "project-settings":
            if (projectGroup)
              openProjectSettings(projectGroup, {
                environmentId: session.environmentId,
                projectId: session.projectId,
              });
            return;
          case "copy-path":
            if (workspacePath) copyPathToClipboard(workspacePath, { path: workspacePath });
            return;
          case "copy-branch":
            if (session.branch) copyBranchToClipboard(session.branch, { branch: session.branch });
            return;
          case "discard": {
            // The menu may outlive draft promotion; discarding then would strand the send.
            const current = useComposerDraftStore.getState().getDraftSession(draftId);
            if (current && !current.promotedTo) discardComposerDraft(draftId);
            return;
          }
        }
      })();
    },
  );

  const handleThreadContextMenu = useStableCallback(
    (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const threadKey = scopedThreadKey(threadRef);
        const selectionState = useThreadSelectionStore.getState();
        if (selectionState.hasSelection() && selectionState.selectedThreadKeys.has(threadKey)) {
          await handleMultiSelectContextMenu(position);
          return;
        }
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread) return;
        const threadWorkspacePath =
          thread.worktreePath ??
          projectByKey.get(`${thread.environmentId}:${thread.projectId}`)?.workspaceRoot ??
          null;
        const configLoaded = serverConfigs.has(thread.environmentId);
        const supportsAutoSettleOptOut =
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadAutoSettleOptOut === true;
        const supportsThreadGroups =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadGroups === true;
        const isRegeneratingTitle = thread.titleRegeneration != null;
        // A grouped chat's shelf is its group's: its own settle state still
        // shows, while Pin and Snooze act on the group.
        const groupKey = groupKeyByThreadKeyRef.current.get(threadKey);
        const groupEntry =
          groupKey === undefined ? undefined : groupEntryByKeyRef.current.get(groupKey);
        const isSettled = groupEntry
          ? configLoaded && thread.settledOverride === "settled"
          : settledThreadKeysRef.current.has(threadKey);
        // A grouped chat sits on its group's shelf, but keeps any snooze of its own.
        const isSnoozed = groupEntry
          ? configLoaded && effectiveSnoozed(thread, { now: new Date().toISOString() })
          : snoozedThreadKeysRef.current.has(threadKey);
        const isPinned = thread.pinnedAt != null;
        const snoozePresets = resolveSnoozePresets(
          new Date(),
          timestampFormat,
          thread.environmentId,
        );
        const threadProjectGroup =
          projectGroupsRef.current.find((project) =>
            project.memberProjectRefs.some(
              (projectRef) =>
                projectRef.environmentId === thread.environmentId &&
                projectRef.projectId === thread.projectId,
            ),
          ) ?? null;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            buildThreadActionMenuItems({
              canOperate: readEnvironmentScope(
                threadRef.environmentId,
                AuthOrchestrationOperateScope,
              ),
              branch: thread.branch ?? null,
              projectFilter: threadProjectGroup
                ? {
                    label: threadProjectGroup.displayName,
                    isActive: projectScopeKeys.includes(threadProjectGroup.projectKey),
                  }
                : null,
              isPinned,
              isSettled,
              autoSettleEnabled: thread.autoSettleDisabledAt == null,
              isSnoozed,
              canSnoozeNow: canSnooze(thread, { now: new Date().toISOString() }),
              isRegeneratingTitle,
              isRunning: !threadRuntimeCanArchive(thread.runtime),
              isSubagent: thread.lineage.relationshipToParent === "subagent",
              canShareWithGuest: appAtomRegistry.get(
                canShareWithGuestAtom(threadRef.environmentId),
              ),
              canTurnIntoProject: canTurnThreadIntoProject(threadRef),
              supports: {
                settlement: configLoaded,
                autoSettleOptOut: supportsAutoSettleOptOut,
                snooze: configLoaded,
                pinning: configLoaded,
                titleRegeneration: configLoaded,
                threadGroups: supportsThreadGroups,
              },
              snoozePresets,
              group: groupEntry
                ? {
                    isPinned: groupEntry.group.pinnedAt !== null,
                    isSnoozed: groupEntry.section === "snoozed",
                  }
                : null,
              moveToGroup: readMoveToGroupState(thread),
            }),
            position,
          ),
        );
        if (clicked._tag === "Failure" || clicked.value === null) return;
        if (threadActionRequiresOperate(clicked.value) && !checkThreadOperations([thread])) return;
        if (groupEntry && clicked.value.startsWith("snooze-group:")) {
          const preset =
            clicked.value === "snooze-group:custom"
              ? await requestCustomSnooze()
              : snoozePresets.find((candidate) => `snooze-group:${candidate.id}` === clicked.value);
          if (preset) await groupActions.snoozeGroup(groupEntry.group, preset.snoozedUntil);
          return;
        }
        if (clicked.value?.startsWith("snooze:")) {
          const preset =
            clicked.value === "snooze:custom"
              ? await requestCustomSnooze()
              : pickSnoozePreset(
                  snoozePresets,
                  clicked.value.slice("snooze:".length),
                  timestampFormat,
                  thread.environmentId,
                );
          if (preset) attemptSnooze(threadRef, preset);
          return;
        }
        const moveTarget = parseMoveToGroupTarget(clicked.value);
        if (moveTarget !== null) {
          await groupActions.moveThreadToGroupId(thread, moveTarget);
          return;
        }
        switch (clicked.value) {
          case "filter-by-project":
            if (threadProjectGroup) {
              setProjectScopeKeys(
                projectScopeKeys.includes(threadProjectGroup.projectKey)
                  ? []
                  : [threadProjectGroup.projectKey],
              );
            }
            return;
          case "project-settings":
            if (threadProjectGroup)
              openProjectSettings(threadProjectGroup, {
                environmentId: threadRef.environmentId,
                projectId: thread.projectId,
              });
            return;
          case "new-thread-on-branch": {
            const result = await settlePromise(() =>
              handleNewThread(scopeProjectRef(thread.environmentId, thread.projectId), {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? "worktree" : "local",
                startFromOrigin: false,
              }),
            );
            if (result._tag === "Failure") {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Could not create thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "settle":
            attemptSettle(threadRef);
            return;
          case "unsettle":
            attemptUnsettle(threadRef);
            return;
          case "unsnooze":
            attemptUnsnooze(threadRef);
            return;
          case "pin":
            attemptPin(threadRef);
            return;
          case "unpin":
            attemptUnpin(threadRef);
            return;
          case "pin-group":
            if (groupEntry) await groupActions.pinGroup(groupEntry.group);
            return;
          case "unpin-group":
            if (groupEntry) await groupActions.unpinGroup(groupEntry.group);
            return;
          case "unsnooze-group":
            if (groupEntry) await groupActions.unsnoozeGroup(groupEntry.group);
            return;
          case "open-group-panel":
            if (groupEntry) groupActions.openGroupPanel(groupEntry.group, thread.id);
            return;
          case "handoff":
            await groupActions.handOffThread(thread);
            return;
          case "remove-from-group":
            await groupActions.removeThreadFromGroup(thread);
            return;
          case "turn-into-project": {
            const result = await turnThreadIntoProject(threadRef);
            if (result._tag === "Success") {
              toastManager.add({
                type: "success",
                title: "Project created",
                description: thread.title,
              });
            } else if (!isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Could not turn thread into a project",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "auto-settle:enabled":
          case "auto-settle:disabled": {
            const result = await setThreadAutoSettle(
              threadRef,
              clicked.value === "auto-settle:enabled",
            );
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to update auto-settle",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "rename":
            startThreadRename(threadRef, thread.title);
            return;
          case "share-guest":
            openGuestShareDialog(threadRef);
            return;
          case "regenerate-title": {
            if (isRegeneratingTitle) return;
            const result = await updateThreadMetadata({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, regenerateTitle: true },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to regenerate thread title",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "mark-unread":
            markThreadUnread(threadRef);
            return;
          case "copy-path":
            if (!threadWorkspacePath) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Path unavailable",
                  description: "This thread does not have a workspace path to copy.",
                }),
              );
              return;
            }
            copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
            return;
          case "copy-branch":
            if (thread.branch) {
              copyBranchToClipboard(thread.branch, { branch: thread.branch });
            }
            return;
          case "copy-thread":
            void copyThreadReference(threadChipCopyTarget(threadRef, thread.title));
            return;
          case "copy-thread-id":
            copyThreadIdToClipboard(thread.id, { threadId: thread.id });
            return;
          case "archive": {
            if (confirmThreadArchive) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(`Archive thread "${thread.title}"?`),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            let didArchive = false;
            const result = await archiveThread(threadRef, {
              onArchived: () => {
                didArchive = true;
              },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: didArchive
                    ? "Thread archived, but navigation failed"
                    : "Failed to archive thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
              return;
            }
            return;
          }
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                  { variant: "destructive" },
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            const result = await deleteThread(threadRef);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to delete thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
              return;
            }
            return;
          }
          default:
            return;
        }
      })();
    },
  );

  const [renamingGroupKey, setRenamingGroupKey] = useState<string | null>(null);
  const cancelGroupRename = useStableCallback(() => setRenamingGroupKey(null));
  const commitGroupRename = useStableCallback((groupKey: string, title: string) => {
    setRenamingGroupKey(null);
    const entry = groupEntryByKeyRef.current.get(groupKey);
    if (entry) void groupActions.renameGroup(entry.group, title);
  });
  // A group row's click opens its first chat; the caret alone expands and collapses.
  const handleOpenGroup = useStableCallback((groupKey: string) => {
    const first = groupEntryByKeyRef.current.get(groupKey)?.members[0];
    if (first) void navigateToThread(scopeThreadRef(first.environmentId, first.id));
  });
  const handleNewChatInGroup = useStableCallback((groupKey: string) => {
    const entry = groupEntryByKeyRef.current.get(groupKey);
    if (entry) void groupActions.newChatInGroup(entry.group);
  });
  const handleNewChatWithThread = useStableCallback((threadRef: ScopedThreadRef) => {
    const thread = threadByKeyRef.current.get(scopedThreadKey(threadRef));
    if (thread) void groupActions.newChatWithThread(thread);
  });
  const handleGroupContextMenu = useStableCallback(
    (groupKey: string, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        const entry = groupEntryByKeyRef.current.get(groupKey);
        if (!api || !entry) return;
        const { group, members, section } = entry;
        const capabilities = serverConfigs.get(group.environmentId)?.environment.capabilities;
        const snoozePresets = resolveSnoozePresets(
          new Date(),
          timestampFormat,
          group.environmentId,
        );
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            buildThreadGroupMenuItems({
              canOperate: readEnvironmentScope(group.environmentId, AuthOrchestrationOperateScope),
              isPinned: group.pinnedAt !== null,
              isSnoozed: isThreadGroupSnoozed(group, Date.now()),
              isSettled: section === "settled",
              supports: {
                settlement: capabilities?.threadSettlement === true,
                snooze: capabilities?.threadSnooze === true,
                threadGroups: capabilities?.threadGroups === true,
              },
              snoozePresets,
            }),
            position,
          ),
        );
        if (clicked._tag === "Failure" || clicked.value === null) return;
        const action: ThreadGroupMenuId = clicked.value;
        if (action !== "open-group-panel" && !checkThreadOperations([group])) return;
        if (action.startsWith("snooze-group:")) {
          const preset =
            action === "snooze-group:custom"
              ? await requestCustomSnooze()
              : snoozePresets.find((candidate) => `snooze-group:${candidate.id}` === action);
          if (preset) await groupActions.snoozeGroup(group, preset.snoozedUntil);
          return;
        }
        switch (action) {
          case "new-chat-in-group":
            await groupActions.newChatInGroup(group);
            return;
          case "rename-group":
            setRenamingGroupKey(groupKey);
            return;
          case "pin-group":
            await groupActions.pinGroup(group);
            return;
          case "unpin-group":
            await groupActions.unpinGroup(group);
            return;
          case "unsnooze-group":
            await groupActions.unsnoozeGroup(group);
            return;
          case "settle-group":
            await groupActions.settleGroup(group);
            return;
          case "unsettle-group":
            await groupActions.unsettleGroup(group);
            return;
          case "open-group-panel": {
            // Stay on the open chat when it is one of the group's.
            const routeMember = members.find(
              (member) => threadShellKey(member) === readRouteThreadKey(router),
            );
            groupActions.openGroupPanel(group, routeMember?.id);
            return;
          }
          case "ungroup":
            await groupActions.ungroup(group);
            return;
          default:
            return;
        }
      })();
    },
  );
  const handleProjectHeadingContextMenu = useStableCallback(
    (projectKey: string, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        const project = projectGroupByScopeKey.get(projectKey);
        if (!api || !project) return;
        const isScoped = projectScopeKeys.includes(projectKey);
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            [
              {
                id: "filter-by-project" as const,
                label: isScoped ? "Show all projects" : `Filter by ${project.displayName}`,
                icon: "folder-tree",
              },
            ],
            position,
          ),
        );
        if (clicked._tag === "Success" && clicked.value === "filter-by-project") {
          setProjectScopeKeys(isScoped ? [] : [projectKey]);
        }
      })();
    },
  );

  // The heading's "+": a new chat in that project, on the scoped machine when one is picked.
  const handleProjectHeadingNewChat = useStableCallback((projectKey: string) => {
    const project = projectGroupByScopeKey.get(projectKey);
    if (!project) return;
    const target =
      (environmentScopeId === null
        ? null
        : project.memberProjects.find((member) => member.environmentId === environmentScopeId)) ??
      project;
    if (isMobile) setOpenMobile(false);
    void handleNewThread(scopeProjectRef(target.environmentId, target.id));
  });

  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to window keydown for thread navigation shortcuts using the current thread list
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
          isWeb: !isElectron,
          isDesktop: isElectron,
        },
      });
      const navigateToThreadKey = (targetThreadKey: string | null) => {
        if (!targetThreadKey) return false;
        const targetThread = threadByKey.get(targetThreadKey);
        if (!targetThread) return false;
        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return true;
      };
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        navigateToThreadKey(
          resolveAdjacentThreadId({
            threadIds: orderedThreadKeys,
            currentThreadId: routeRowThreadKey,
            direction: traversalDirection,
          }),
        );
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) return;
      navigateToThreadKey(orderedThreadKeys[jumpIndex] ?? null);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [
    keybindings,
    navigateToThread,
    orderedThreadKeys,
    routeRowThreadKey,
    routeTerminalOpen,
    threadByKey,
  ]);

  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform: navigator.platform,
      context: {
        terminalFocus: terminalFocused,
        terminalOpen: routeTerminalOpen,
        modelPickerOpen: isModelPickerOpen(),
        environmentPickerOpen,
        isWeb: !isElectron,
        isDesktop: isElectron,
      },
    },
  );
  const showJumpHints = useThreadJumpHintsVisible(shouldShowJumpHintsNow);

  const handleNewThreadClick = (event?: ReactMouseEvent) => {
    if (
      boringSidebarEnabled ||
      shouldCreateNewThreadInCurrentProject(event?.shiftKey ?? false, projectGroups.length)
    ) {
      if (isMobile) setOpenMobile(false);
      const scopedDefaultProject = orderedProjectsRef.current[0];
      void startNewThreadFromContext(
        scopeThreadActionContext(
          {
            activeDraftThread: newThreadContext.activeDraftThread,
            activeThread: newThreadContext.activeThread ?? undefined,
            defaultProjectRef: newThreadContext.defaultProjectRef,
            handleNewThread,
          },
          environmentScopeId,
          scopedDefaultProject
            ? scopeProjectRef(scopedDefaultProject.environmentId, scopedDefaultProject.id)
            : null,
        ),
      );
      return;
    }
    if (isMobile) setOpenMobile(false);
    openCommandPalette({ open: "new-thread-in" });
  };

  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.new") ??
    (projectGroups.length <= 1 ? shortcutLabelForCommand(keybindings, "chat.newLocal") : undefined);
  const newThreadInProjectShortcutLabel = shortcutLabelForCommand(keybindings, "chat.newLocal");
  return (
    <>
      <ThreadContextDragGhost />
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <SidebarThreadHeader
              searchFieldRef={headerSearchRef}
              hasProjects={projectGroups.length > 0}
              machineScope={
                environments.length > 1 ? (
                  <Menu open={environmentPickerOpen} onOpenChange={setEnvironmentPickerOpen}>
                    <MenuTrigger
                      render={
                        <SidebarHeaderIconButton
                          label={`${
                            environmentScopeId === null
                              ? "Show threads from: All machines"
                              : `Show threads from: ${environmentLabelById.get(environmentScopeId) ?? "Machine"}`
                          }${environmentPickerShortcut ? ` · ${environmentPickerShortcut}` : ""}`}
                        />
                      }
                    >
                      {environmentScopeId === null ? (
                        <LayersIcon />
                      ) : (
                        <EnvironmentMachineIcon
                          kind={environmentMachineById.get(environmentScopeId) ?? "server"}
                        />
                      )}
                    </MenuTrigger>
                    <MenuPopup align="end" side="bottom">
                      <MenuRadioGroup
                        value={environmentScopeId ?? ""}
                        onValueChange={(value) => setEnvironmentScopeId(value || null)}
                      >
                        <MenuRadioItem value="">
                          <span className="flex min-w-0 items-center justify-between gap-4">
                            <span>All machines</span>
                            <MenuShortcut>{environmentJumpLabel(0)}</MenuShortcut>
                          </span>
                        </MenuRadioItem>
                        {environments.map((environment, index) => (
                          <MenuRadioItem
                            key={environment.environmentId}
                            value={environment.environmentId}
                          >
                            <span className="flex flex-1 items-center justify-between gap-3">
                              <span>{environment.label}</span>
                              <EnvironmentBatteryIndicator
                                environmentId={environment.environmentId}
                              />
                              <MenuShortcut>{environmentJumpLabel(index + 1)}</MenuShortcut>
                            </span>
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuPopup>
                  </Menu>
                ) : null
              }
              projectScope={
                <Combobox
                  items={projectScopeItems}
                  filteredItems={filteredProjectScopeItems}
                  autoHighlight
                  itemToStringLabel={(item) => item.label}
                  isItemEqualToValue={(a, b) => a.value === b.value}
                  open={projectScopeMenuState.open}
                  onOpenChange={(open, eventDetails) => {
                    if (eventDetails.isCanceled) return;
                    if (open) suppressNextScopeChangeRef.current = false;
                    dispatchProjectScopeMenu({ type: "open-changed", open });
                  }}
                  onItemHighlighted={(item) => {
                    highlightedProjectScopeKeyRef.current = item?.value ?? null;
                  }}
                  value={selectedProjectScopeItem}
                  onValueChange={(item, eventDetails) => {
                    if (suppressNextScopeChangeRef.current) {
                      suppressNextScopeChangeRef.current = false;
                      return;
                    }
                    if (!item) return;
                    if (item.value === "all") {
                      setProjectScopeKeys([]);
                    } else if (
                      eventDetails.event instanceof MouseEvent &&
                      eventDetails.event.shiftKey
                    ) {
                      // Canceling skips Base UI's commit, which would freeze the search query, and its close.
                      eventDetails.cancel();
                      toggleProjectScopeKey(item.value);
                    } else {
                      setProjectScopeKeys([item.value]);
                    }
                  }}
                >
                  <ComboboxTrigger
                    render={
                      <SidebarHeaderIconButton
                        label={
                          scopedProjectGroups.length > 0
                            ? `Filter threads by project: ${scopedProjectGroups.map((project) => project.displayName).join(", ")}`
                            : "Filter threads by project"
                        }
                      />
                    }
                  >
                    {scopedProjectGroups.length > 1 ? (
                      <span className="flex shrink-0 -space-x-1.5">
                        {scopedProjectGroups.slice(0, 2).map((project) => (
                          <ProjectFavicon
                            key={project.projectKey}
                            project={project}
                            className="size-3.5"
                          />
                        ))}
                      </span>
                    ) : scopedProjectGroups[0] ? (
                      <span className="flex shrink-0">
                        <ProjectFavicon project={scopedProjectGroups[0]} className="size-4" />
                      </span>
                    ) : (
                      <ListFilterIcon className="size-4" />
                    )}
                  </ComboboxTrigger>
                  <ComboboxPopup
                    align="start"
                    anchor={headerSearchRef}
                    className="max-w-[min(18rem,var(--available-width))] overflow-hidden"
                  >
                    <ComboboxSearchInput
                      aria-label="Search projects"
                      placeholder="Search projects..."
                      value={projectScopeMenuState.query}
                      onKeyDown={(event) => {
                        if (
                          event.defaultPrevented ||
                          event.nativeEvent.isComposing ||
                          event.keyCode === 229 ||
                          event.ctrlKey ||
                          event.altKey ||
                          event.metaKey
                        ) {
                          return;
                        }
                        const scopeKey = highlightedProjectScopeKeyRef.current;
                        const project = scopeKey ? projectGroupByScopeKey.get(scopeKey) : null;
                        if (event.shiftKey && event.key === "Enter") {
                          if (!project) return;
                          event.preventDefault();
                          toggleProjectScopeKey(project.projectKey);
                          return;
                        }
                        if (
                          event.key !== "ContextMenu" &&
                          !(event.shiftKey && event.key === "F10")
                        ) {
                          return;
                        }
                        if (project) handleProjectSettings(event, project);
                      }}
                      onChange={(event) =>
                        dispatchProjectScopeMenu({
                          type: "query-changed",
                          query: event.target.value,
                        })
                      }
                    />
                    <ComboboxEmpty>No matching projects.</ComboboxEmpty>
                    <ComboboxList aria-multiselectable>
                      {(item: (typeof projectScopeItems)[number]) => {
                        const project = projectGroupByScopeKey.get(item.value) ?? null;
                        const isSelected = project
                          ? projectScopeKeys.includes(item.value)
                          : projectScopeKeys.length === 0;
                        return (
                          <ComboboxItem
                            key={item.value}
                            hideIndicator
                            value={item}
                            aria-selected={isSelected}
                            // The icon badge marks selection; Base UI's single value would shade one row.
                            data-selected={undefined}
                            onContextMenu={(event) => {
                              if (project) handleProjectSettings(event, project);
                            }}
                          >
                            <ProjectScopeRowIcon isSelected={isSelected}>
                              {project ? (
                                <ProjectFavicon project={project} className="size-4 shrink-0" />
                              ) : (
                                <FolderIcon className="size-4 shrink-0" />
                              )}
                            </ProjectScopeRowIcon>
                            <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                            {project && showProjectEnvironments ? (
                              <ProjectEnvironmentBadge
                                group={project}
                                primaryEnvironmentId={primaryEnvironmentId}
                                machineByEnvironmentId={environmentMachineById}
                              />
                            ) : null}
                            {project ? (
                              <Button
                                size="icon-xs"
                                variant="ghost-muted"
                                tabIndex={-1}
                                aria-hidden="true"
                                title={`Project settings for ${project.displayName}`}
                                className="ml-auto"
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                  void handleProjectSettings(event, project);
                                }}
                              >
                                <SettingsIcon className="size-3.5" />
                              </Button>
                            ) : null}
                          </ComboboxItem>
                        );
                      }}
                    </ComboboxList>
                  </ComboboxPopup>
                </Combobox>
              }
              onNewProject={openAddProjectCommandPalette}
              onNewThread={handleNewThreadClick}
              newThreadDisabled={projects.length === 0}
              newThreadShortcutLabel={newThreadShortcutLabel}
              newThreadInProjectShortcutLabel={newThreadInProjectShortcutLabel}
              showNewThreadInProjectHint={!boringSidebarEnabled && projectGroups.length > 1}
              searchInputRef={threadSearchInputRef}
              searchQuery={threadSearchQuery}
              onSearchQueryChange={(value) => {
                setThreadSearchQuery(value);
                setSearchHighlightKey(null);
              }}
              onSearchKeyDown={handleThreadSearchKeyDown}
              isSearching={isSearchingThreads}
              searchResultCount={threadSearchResults.length}
              activeSearchResultIndex={activeSearchResultIndex}
              onClearSearch={clearThreadSearch}
            />
          </SidebarGroup>
        }
      >
        <SidebarGroup className="flex-1" role="presentation">
          {isSearchingThreads ? (
            threadSearchResults.length > 0 ? (
              <TooltipProvider
                key="sidebar-thread-search-tooltips-150"
                delay={150}
                closeDelay={0}
                timeout={400}
              >
                <ul
                  id="sidebar-thread-search-results"
                  role="listbox"
                  aria-label="Thread search results"
                  className="flex flex-col gap-px"
                >
                  {threadSearchResults.map((thread, index) => {
                    const threadKey = scopedThreadKey(
                      scopeThreadRef(thread.environmentId, thread.id),
                    );
                    return (
                      <SidebarSearchResultRow
                        isSettled={settledThreadKeys.has(threadKey)}
                        key={threadKey}
                        thread={thread}
                        project={
                          projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
                        }
                        projectDisplayName={
                          projectDisplayNameByKey.get(
                            `${thread.environmentId}:${thread.projectId}`,
                          ) ?? null
                        }
                        environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
                        environmentMachine={
                          environmentMachineById.get(thread.environmentId) ?? "server"
                        }
                        providerEntryByInstanceId={
                          providerEntriesByEnvironment.get(thread.environmentId) ??
                          EMPTY_PROVIDER_ENTRIES
                        }
                        isHighlighted={activeSearchResultIndex === index}
                        isRouteActive={routeRowThreadKey === threadKey}
                        resultId={threadSearchResultId(index)}
                        searchMatch={
                          threadSearchMatchByKey.get(
                            threadSearchMatchKey({
                              environmentId: thread.environmentId,
                              threadId: thread.id,
                            }),
                          ) ?? null
                        }
                        searchQuery={threadSearchQuery}
                        searchMatchQuery={threadSearch.query}
                        onHighlight={() => setActiveSearchResultIndex(index)}
                        onSelect={() => selectThreadSearchResult(thread)}
                        onFileDropThreads={handleThreadFileDrop}
                      />
                    );
                  })}
                </ul>
              </TooltipProvider>
            ) : (
              <p
                role="status"
                className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
              >
                {threadSearch.isPending ? "Searching thread messages…" : "No threads found"}
              </p>
            )
          ) : null}
          {!isSearchingThreads ? (
            <TooltipProvider
              key="sidebar-thread-tooltips-150"
              delay={150}
              closeDelay={0}
              timeout={400}
            >
              <DndContext
                sensors={dndSensors}
                autoScroll={!isContextDrag}
                collisionDetection={dndCollisionDetection}
                modifiers={dndModifiers}
                onDragStart={handleThreadDragStart}
                onDragOver={handleThreadDragOver}
                onDragEnd={handleThreadDragEnd}
              >
                <SortableContext items={sortableIds} strategy={sidebarSortingStrategy}>
                  <ul
                    {...SIDEBAR_TREE_PROPS}
                    ref={attachTreeRef}
                    className={cn(
                      "relative flex flex-col gap-px",
                      sidebarListItems.length > 0 && "flex-1",
                      actionSweep !== null && "**:pointer-events-none",
                    )}
                  >
                    {(() => {
                      const renderThreadRow = (
                        thread: EnvironmentThreadShell,
                        section: SidebarSection,
                        groupKey: string | null,
                        // The tree row of the project folder this row sits in.
                        folderRow?: string,
                      ) => {
                        const threadKey = scopedThreadKey(
                          scopeThreadRef(thread.environmentId, thread.id),
                        );
                        // Ungrouped pinned chats and the Working shelf stay cards so
                        // their live status shows. The Active tree, group members and
                        // parked shelves are single-line rows.
                        const isCard =
                          folderRow === undefined &&
                          !soloGroupsEnabled &&
                          groupKey === null &&
                          (section === "pinned" || section === "working");
                        const rowVariant = folderRow
                          ? folderRowsMultiline
                            ? "folder-multiline"
                            : "folder"
                          : isCard
                            ? "card"
                            : "slim";
                        // With groups of one on, a lone chat is its group's row.
                        const solo =
                          folderRow === undefined &&
                          soloGroupsEnabled &&
                          groupKey === null &&
                          section !== "settled" &&
                          section !== "working";
                        const tree =
                          folderRow !== undefined
                            ? undefined
                            : solo
                              ? "solo"
                              : groupKey !== null
                                ? "member"
                                : section === "active"
                                  ? "root"
                                  : undefined;
                        return (
                          <SortableThreadRow
                            key={threadKey}
                            sortableId={threadKey}
                            contextDrag={isContextDrag}
                            sortableDisabled={
                              projectFolders !== null ||
                              renamingThreadKey === threadKey ||
                              // Active-tree rows always rearrange; elsewhere a drop
                              // needs the pin-order capability.
                              (groupKey === null &&
                                section !== "active" &&
                                !draggableThreadKeys.has(threadKey)) ||
                              // Grouped chats drag only to reorder their group.
                              (groupKey !== null &&
                                serverConfigs.get(thread.environmentId)?.environment.capabilities
                                  .threadGroupReorder !== true) ||
                              optimisticDrop !== null
                            }
                            thread={thread}
                            variant={rowVariant}
                            tree={tree}
                            // A new group starts unpinned and awake, so "+"
                            // on a pinned or snoozed chat would move it to Active.
                            onNewChatInGroup={
                              solo &&
                              section === "active" &&
                              serverConfigs.get(thread.environmentId)?.environment.capabilities
                                .threadGroups === true
                                ? handleNewChatWithThread
                                : undefined
                            }
                            navigationParent={
                              folderRow ??
                              (section === "working" ||
                              section === "snoozed" ||
                              section === "settled"
                                ? `shelf:${section}`
                                : undefined)
                            }
                            // Snoozed rows wake, settled rows un-settle, and cards
                            // settle. A group member acts on its own settle state.
                            variantAction={
                              groupKey !== null
                                ? thread.settledOverride === "settled"
                                  ? "unsettle"
                                  : "settle"
                                : section === "snoozed"
                                  ? "unsnooze"
                                  : section === "settled"
                                    ? "unsettle"
                                    : "settle"
                            }
                            settlementSupported={serverConfigs.has(thread.environmentId)}
                            snoozeSupported={serverConfigs.has(thread.environmentId)}
                            pinningSupported={serverConfigs.has(thread.environmentId)}
                            // A grouped chat's own pin no longer places it.
                            isPinned={groupKey === null && thread.pinnedAt != null}
                            dropVerb={
                              dragState?.activeKey === threadKey
                                ? resolveSidebarDropVerb(dragState.activeSection, dragTargetSection)
                                : null
                            }
                            dragOverPinned={
                              dragState?.activeKey === threadKey && dragTargetSection === "pinned"
                            }
                            sweepAction={
                              actionSweep?.keys.has(threadKey) ? actionSweep.action : null
                            }
                            snoozeWakeLabelText={
                              groupKey === null &&
                              section === "snoozed" &&
                              thread.snoozedUntil != null
                                ? snoozeWakeLabel(thread.snoozedUntil, {
                                    now: new Date().toISOString(),
                                  })
                                : null
                            }
                            wokeAt={threadWokeAt(thread, { now: snoozeNow })}
                            isActive={routeRowThreadKey === threadKey}
                            revealRef={
                              routeRowThreadKey === threadKey ? revealActiveRow : undefined
                            }
                            isRouteThread={routeThreadKey === threadKey}
                            openPullRequestsInRightPanel={routeThreadRef !== null}
                            jumpLabel={
                              showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null
                            }
                            currentEnvironmentId={primaryEnvironmentId}
                            environmentLabel={
                              environmentLabelById.get(thread.environmentId) ?? null
                            }
                            environmentMachine={
                              environmentMachineById.get(thread.environmentId) ?? "server"
                            }
                            scratchMachineLabel={scratchMachineLabelFor(thread)}
                            project={
                              projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ??
                              null
                            }
                            projectDisplayName={
                              projectDisplayNameByKey.get(
                                `${thread.environmentId}:${thread.projectId}`,
                              ) ?? null
                            }
                            providerEntryByInstanceId={
                              providerEntriesByEnvironment.get(thread.environmentId) ??
                              EMPTY_PROVIDER_ENTRIES
                            }
                            timestampFormat={timestampFormat}
                            onThreadClick={handleThreadClick}
                            onThreadActivate={navigateToThread}
                            onStartRename={startThreadRename}
                            onRenameTitleChange={setRenamingTitle}
                            onCommitRename={commitThreadRename}
                            onCancelRename={cancelThreadRename}
                            isRenaming={renamingThreadKey === threadKey}
                            renamingTitle={renamingThreadKey === threadKey ? renamingTitle : ""}
                            onContextMenu={handleThreadContextMenu}
                            onSettle={attemptSettle}
                            onActionSweepStart={startActionSweep}
                            onUnsettle={attemptUnsettle}
                            onSnooze={attemptSnooze}
                            onUnsnooze={attemptUnsnooze}
                            onUnpin={attemptUnpin}
                            onAcknowledgeWoke={acknowledgeWoke}
                            onFileDropThreads={handleThreadFileDrop}
                          />
                        );
                      };
                      // In-place rearranges open no section labels or targets.
                      const from =
                        isContextDrag || dragState?.arranging
                          ? null
                          : (dragState?.activeSection ?? null);
                      // The open "+ New chat in group" draft shows as a row at
                      // the end of its group's block, so it reads as that group's.
                      const inDraftGroup = (item: SidebarListItem | undefined) =>
                        routeDraftGroupKey !== null &&
                        item !== undefined &&
                        ((item.kind === "group" && item.key === routeDraftGroupKey) ||
                          (item.kind === "thread" &&
                            (item.groupKey === routeDraftGroupKey ||
                              item.soloGroupKey === routeDraftGroupKey)));
                      const items: ReactNode[] = [
                        <SidebarDraftBlock
                          key="draft-sessions"
                          projectByKey={projectByKey}
                          projectDisplayNameByKey={projectDisplayNameByKey}
                          scopedProjectKeys={scopedProjectKeys}
                          environmentScopeId={environmentScopeId}
                          routeDraftId={routeDraftIdForRows}
                          routeDraftShownInGroup={sidebarListItems.some(inDraftGroup)}
                          onNavigateToDraft={navigateToDraft}
                          onDraftContextMenu={handleDraftContextMenu}
                        />,
                      ];
                      for (const [index, item] of sidebarListItems.entries()) {
                        if (item.kind === "thread") {
                          const thread = threadByKey.get(item.key);
                          if (thread !== undefined) {
                            items.push(
                              renderThreadRow(thread, item.section, item.groupKey ?? null),
                            );
                          }
                        } else if (item.kind === "group") {
                          const entry = groupEntryByKey.get(item.key);
                          if (entry) {
                            items.push(
                              <SidebarGroupRow
                                key={sidebarListItemId(item)}
                                sortableId={sidebarListItemId(item)}
                                groupKey={item.key}
                                group={entry.group}
                                members={entry.members}
                                section={item.section}
                                snoozeNow={snoozeNow}
                                expanded={isGroupExpanded(item.key)}
                                draggable={
                                  item.section === "active" &&
                                  optimisticDrop === null &&
                                  renamingGroupKey !== item.key
                                }
                                isRenaming={renamingGroupKey === item.key}
                                onToggle={toggleGroupExpanded}
                                onOpen={handleOpenGroup}
                                onNewChat={handleNewChatInGroup}
                                onContextMenu={handleGroupContextMenu}
                                onCommitRename={commitGroupRename}
                                onCancelRename={cancelGroupRename}
                              />,
                            );
                          }
                        }
                        if (inDraftGroup(item) && !inDraftGroup(sidebarListItems[index + 1])) {
                          items.push(
                            <SidebarGroupDraftRow
                              key={`group-draft:${routeDraftGroupKey}`}
                              groupTitle={
                                threadGroupByKey.get(routeDraftGroupKey!)?.title ?? "group"
                              }
                            />,
                          );
                        }
                        if (item.kind === "thread" || item.kind === "group") continue;
                        if (item.kind === "project-heading") {
                          const project = projectGroupByScopeKey.get(item.key) ?? null;
                          items.push(
                            <SidebarProjectHeading
                              key={sidebarListItemId(item)}
                              sortableId={sidebarListItemId(item)}
                              projectKey={item.key}
                              project={project}
                              displayName={project?.displayName ?? "Project"}
                              collapsed={isProjectCollapsed(item.key)}
                              draggable={optimisticDrop === null}
                              onToggleCollapsed={toggleProjectCollapsed}
                              onNewChat={handleProjectHeadingNewChat}
                              onContextMenu={handleProjectHeadingContextMenu}
                            />,
                          );
                          continue;
                        }
                        if (projectFolders !== null && item.marker === "active-placeholder") {
                          for (const folder of projectFolders) {
                            items.push(
                              <SidebarProjectFolderHeader
                                key={`project-folder:${folder.group.projectKey}`}
                                group={folder.group}
                                collapsed={folder.collapsed}
                                hiddenThreads={folder.hiddenThreads}
                                onToggle={toggleProjectFolder}
                                onNewThread={startThreadInProjectFolder}
                                onContextMenu={handleProjectFolderContextMenu}
                              />,
                            );
                            for (const thread of folder.threads) {
                              items.push(
                                renderThreadRow(
                                  thread,
                                  "active",
                                  null,
                                  sidebarFolderRowId(folder.group.projectKey),
                                ),
                              );
                            }
                          }
                          continue;
                        }
                        switch (item.marker) {
                          case "pinned-header":
                            items.push(
                              <SidebarDragBoundary
                                key="pinned-header"
                                marker="pinned-header"
                                label="Pinned"
                                visible={from !== null && !dragState?.arranging}
                                isDropTarget={dragTargetSection === "pinned"}
                              />,
                            );
                            break;
                          case "pinned-divider":
                            items.push(
                              <SidebarDragBoundary
                                key="pinned-divider"
                                marker="pinned-divider"
                                label="Active"
                                visible={from !== null && !dragState?.arranging}
                                isDropTarget={dragTargetSection === "active"}
                              />,
                            );
                            break;
                          case "active-placeholder":
                            items.push(
                              <SidebarSectionPlaceholder
                                key="active-placeholder"
                                marker="active-placeholder"
                                label="Active"
                                showHint={
                                  from !== null &&
                                  (activeThreads.length + activeGroups.length === 0 ||
                                    (from === "active" &&
                                      activeThreads.length + activeGroups.length === 1 &&
                                      dragTargetSection !== null &&
                                      dragTargetSection !== "active"))
                                }
                                isDropTarget={dragTargetSection === "active"}
                              />,
                            );
                            break;
                          case "working-header":
                            items.push(
                              <SidebarSectionHeader
                                key="working-shelf-header"
                                marker="working-header"
                                className="mt-auto"
                                label="Working"
                                count={workingThreads.length}
                                toggle={{
                                  expanded: workingShelfExpanded,
                                  onToggle: toggleWorkingShelf,
                                }}
                              />,
                            );
                            break;
                          case "snoozed-header":
                            items.push(
                              <SidebarSectionHeader
                                key="snoozed-shelf-header"
                                marker="snoozed-header"
                                className={cn(workingThreads.length === 0 && "mt-auto")}
                                label="Snoozed"
                                count={snoozedThreads.length + snoozedGroups.length}
                                toggle={{
                                  expanded: snoozedShelfExpanded,
                                  onToggle: toggleSnoozedShelf,
                                }}
                              />,
                            );
                            break;
                          case "settled-header":
                            items.push(
                              <SidebarSectionHeader
                                key="settled-shelf-header"
                                marker="settled-header"
                                className={cn(
                                  workingThreads.length +
                                    snoozedThreads.length +
                                    snoozedGroups.length ===
                                    0 && "mt-auto",
                                )}
                                label="Settled"
                                count={settledCount + settledGroups.length}
                                dragging={from !== null}
                                isDropTarget={dragTargetSection === "settled"}
                                toggle={{
                                  expanded: settledShelfExpanded,
                                  onToggle: toggleSettledShelf,
                                }}
                              />,
                            );
                            break;
                          case "settled-placeholder":
                            items.push(
                              <SidebarSectionPlaceholder
                                key="settled-placeholder"
                                marker="settled-placeholder"
                                label="Settled"
                                showHint={
                                  from !== null &&
                                  (renderedSettledThreads.length +
                                    shownGroupsBySection.settled.length ===
                                    0 ||
                                    (from === "settled" &&
                                      renderedSettledThreads.length +
                                        shownGroupsBySection.settled.length ===
                                        1 &&
                                      dragTargetSection !== null &&
                                      dragTargetSection !== "settled"))
                                }
                                isDropTarget={dragTargetSection === "settled"}
                              />,
                            );
                            break;
                        }
                      }
                      return items;
                    })()}
                    {arrangeLine !== null ? (
                      <li
                        aria-hidden
                        className="pointer-events-none absolute right-1 z-30 h-0.5 -translate-y-1/2 list-none rounded-full bg-primary"
                        style={{ top: arrangeLine.top, left: arrangeLine.left }}
                      />
                    ) : null}
                    {settledShelfExpanded && hiddenSettledCount > 0 ? (
                      <li className="list-none">
                        <button
                          type="button"
                          role="treeitem"
                          tabIndex={-1}
                          data-sidebar-row="settled:more"
                          data-sidebar-parent="shelf:settled"
                          disabled={olderSettledShelf.loading}
                          onClick={() => {
                            olderSettledShelf.retry();
                            showMoreSettled();
                          }}
                          className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground disabled:cursor-default"
                        >
                          {/* Plus means "add", so revealing more uses a chevron. */}
                          <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
                          {olderSettledShelf.loading
                            ? "Loading"
                            : olderSettledShelf.failed
                              ? "Could not load older threads. Retry"
                              : `Show ${Math.min(hiddenSettledCount, SETTLED_TAIL_PAGE_COUNT)} more`}
                        </button>
                      </li>
                    ) : null}
                  </ul>
                </SortableContext>
              </DndContext>
            </TooltipProvider>
          ) : null}
          {!isSearchingThreads &&
          !hasProjectFolders &&
          visibleDraftSessionCount === 0 &&
          sidebarThreadCount === 0 ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
              {projects.length === 0 && environmentScopeId !== null ? (
                <>
                  <span>
                    No projects on {environmentLabelById.get(environmentScopeId) ?? "this machine"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEnvironmentScopeId(null)}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  >
                    Show all machines
                  </button>
                </>
              ) : projects.length === 0 ? (
                <>
                  <span>No projects yet</span>
                  <button
                    type="button"
                    onClick={openAddProjectCommandPalette}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  >
                    <PlusIcon className="-mx-0.5 size-3" />
                    Add project
                  </button>
                </>
              ) : scopedProjectGroups.length > 1 ? (
                "No threads in these projects yet"
              ) : scopedProjectGroups[0] ? (
                `No threads in ${scopedProjectGroups[0].displayName} yet`
              ) : (
                "No threads yet"
              )}
            </div>
          ) : null}
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
