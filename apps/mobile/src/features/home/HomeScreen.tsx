import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import type { ThreadMoveDestination } from "../threads/threadOrder";
import { computeThreadMoveAvailability } from "../threads/threadOrder";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import {
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import { type EnvironmentId, type SidebarProjectGroupingMode } from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { planGroupMemberReorder } from "@t3tools/client-runtime/state/thread-sort";
import { AsyncResult } from "effect/reactivity";
import { useFocusEffect } from "@react-navigation/native";
import {
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  Alert,
  BackHandler,
  Platform,
  ScrollView,
  View,
  type ScrollViewProps,
  type GestureResponderEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { ScrollViewMarker } from "react-native-screens";
import { GestureDetector, useNativeGesture } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { cn } from "../../lib/cn";
import { EmptyState } from "../../components/EmptyState";
import { MaterialFloatingActionButton } from "../../components/MaterialFloatingActionButton";
import type { WorkspaceEnvironment, WorkspaceState } from "../../state/workspaceModel";
import type { SavedRemoteConnection } from "../../lib/connection";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { nativeHeaderScrollEdgeEffects } from "../../native/scrollEdgeEffects";
import {
  useNativeColumnLayoutMetrics,
  useNativeLayoutMetrics,
} from "../../native/native-layout-metrics";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useThreadSearch } from "../../state/queries";
import { useThreadJumpShortcuts } from "../keyboard/threadKeyboardShortcuts";
import { usePendingThreadOrder } from "../../state/thread-order";
import { threadListEnvironmentsAtom } from "../../state/server";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { useQueuedThreadKeys } from "../../state/use-thread-outbox";
import {
  ThreadListV2PendingRow,
  ThreadListV2Row,
  ThreadListV2SectionDivider,
  ThreadListV2SettledShelfHeader,
  ThreadListV2ShowMoreRow,
  ThreadListV2SnoozedShelfHeader,
  ThreadListV2WorkingShelfHeader,
} from "../threads/thread-list-v2-items";
import { useThreadRowProviderInstanceResolver } from "../threads/thread-provider-instance";
import {
  buildThreadListV2Items,
  getThreadListV2OrderedSection,
  buildThreadListV2ListItems,
  threadListV2ListItemsAreEqual,
  threadListInboxReturns,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  isThreadListV2ListItem,
  resolveThreadListV2Status,
} from "../threads/threadListV2";
import { useThreadListV2ShelfPreferences } from "../threads/use-thread-list-v2-shelf-preferences";
import type { HomeListFilterMenuEnvironment } from "./home-list-filter-menu";
import {
  buildHomeProjectScopes,
  findHomeProjectScope,
  type HomeProjectSortOrder,
} from "./homeThreadList";
import { createSwipeRowActivation } from "./swipe-row-activation";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "./thread-swipe-actions";
import { useMaterialFabScroll } from "./MaterialFabScrollContext";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import {
  ProjectFilterChips,
  ThreadListFilters,
  type ProjectChipIndicator,
} from "./ThreadListFilters";
import { HomeGroupRow } from "./HomeGroupRow";
import { HomeProjectHeader } from "./HomeProjectHeader";
import {
  buildHomeProjectSections,
  homeListItemsAreEqual,
  mergeArrangedKeys,
  moveKey,
  type HomeListItem,
  type HomeProjectSections,
} from "./homeProjectSections";
import { HomeArrangeRow } from "./HomeArrangeRow";
import { ListFilterChip } from "../workspace/ListFilterMenu";
import { appAtomRegistry } from "../../state/atom-registry";
import { homeArrangesInPlaceAtom, threadArrangementOpenAtom } from "../../state/thread-order";
import { environmentThreadGroups, threadEnvironment } from "../../state/threads";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";

/* ─── Types ──────────────────────────────────────────────────────────── */

/** A drag handle in Edit mode, and the offset of the row being dragged. */
interface ArrangeStamp {
  readonly handle: true;
  readonly liftOffset?: number;
}
type ListItem = HomeListItem & { readonly arrange?: ArrangeStamp };

interface HomeScreenProps {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly catalogState: WorkspaceState;
  readonly savedConnectionsById: Readonly<Record<string, SavedRemoteConnection>>;
  readonly environments: ReadonlyArray<
    HomeListFilterMenuEnvironment & Pick<WorkspaceEnvironment, "connectionState">
  >;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onAddConnection: () => void;
  readonly onOpenSettings: () => void;
  readonly onStartNewTask: () => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  /** Resolves true iff the settle was dispatched and succeeded. */
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSnoozeThread: (
    thread: EnvironmentThreadShell,
    snoozedUntil: string,
  ) => Promise<boolean>;
  readonly onUnsnoozeThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onPinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onUnpinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSetThreadAutoSettle: (
    thread: EnvironmentThreadShell,
    enabled: boolean,
  ) => Promise<boolean>;
  readonly onMoveThread: (
    thread: EnvironmentThreadShell,
    direction: ThreadMoveDestination,
  ) => Promise<boolean>;
  readonly onRenameThread: (thread: EnvironmentThreadShell) => void;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
}

/* ─── Layout constants ───────────────────────────────────────────────── */

// v2 rows are mixed-height: settled slim rows run ~60dp, single-line cards
// measured ~74dp on device (252px on the Pixel 10 Pro screenshot), two-line
// cards ~94dp. The estimate seeds the recycler's initial container count,
// `ceil((scrollLength + 2 * INITIAL_DRAW_DISTANCE) / estimate)` with the
// initial draw distance capped at 50, so an estimate at or below the average
// row height starts the pool at or above the item count for the short lists
// that LegendList otherwise keeps pooling to exactly its item count — that is
// what stopped the dev-mode "no unused container available" warning on the
// seeded short-list device passes. It is a mitigation, not an elimination:
// after first layout the full drawDistance applies, and a sudden expansion
// past the pooled headroom (~25+ items appearing at once) still creates a
// container on demand with the dev-only warning one pass ahead of the
// measured-height pool expansion. The old tallest-card estimate (~92) fired
// that warning on every ordinary shelf expand, so the average wins.
const ESTIMATED_THREAD_LIST_V2_ROW_HEIGHT = 72;
// Rows away from the viewport are cheap dormant frames (see
// swipe-row-activation), so render further ahead: a fast fling then reaches
// rows that are already built instead of rows still being rebuilt.
const THREAD_LIST_V2_DRAW_DISTANCE = 1_000;
/**
 * Top spacing between the list and the Android custom header. The Android
 * header is rendered in-flow above this screen and
 * already consumes the top safe-area inset, so the list only needs breathing
 * room here.
 */

function deriveEmptyState(props: {
  readonly catalogState: WorkspaceState;
  readonly projectCount: number;
}): { readonly title: string; readonly detail: string; readonly loading: boolean } {
  const { catalogState } = props;
  if (catalogState.isLoadingConnections) {
    return {
      title: "Loading environments",
      detail: "Checking saved environments on this device.",
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: "No environments connected",
      detail: "Add an environment to load projects and start coding sessions.",
      loading: false,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error" ||
      catalogState.connectionState === "unsupported") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title:
        catalogState.connectionState === "unsupported"
          ? "Client not supported"
          : "Environment unavailable",
      detail:
        catalogState.connectionError ??
        "The saved environment is offline. Check the URL or start the environment, then retry.",
      loading: false,
    };
  }

  if (
    catalogState.hasConnectingEnvironment &&
    !catalogState.hasLoadedShellSnapshot &&
    catalogState.connectionError === null
  ) {
    return {
      title: "Connecting to environment",
      detail: "Loading projects and threads from the saved environment.",
      loading: true,
    };
  }

  if (props.projectCount === 0 && catalogState.hasLoadedShellSnapshot) {
    return {
      title: "No projects found",
      detail: "The connected environment did not report any projects.",
      loading: false,
    };
  }

  return {
    title: "No threads yet",
    detail: "Create a task to start a new coding runtime in one of your connected projects.",
    loading: false,
  };
}

function HomeTopContentSpacer() {
  return <View className="h-4" />;
}

function HomeScrollView(props: ComponentProps<typeof ScrollView>) {
  const insets = useSafeAreaInsets();
  const primaryColumn = use(NativePrimaryColumnContext);
  if (Platform.OS !== "ios") return <ScrollView {...props} />;

  // v5 needs the actual content scroll view registered with its screen controller.
  // The layout observer and header siblings prevent UIKit from finding it implicitly.
  return (
    <ScrollViewMarker
      style={{ flex: 1 }}
      scrollEdgeEffects={{
        ...nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version),
        // Retain the existing sidebar fade on iOS 26; iOS 27 uses the native bar material.
        top: Number.parseInt(String(Platform.Version), 10) >= 27 ? "automatic" : "soft",
      }}
    >
      <ScrollView
        {...props}
        // UIKit's scroll-edge material needs the scroll view's own surface color.
        className={cn(props.className, primaryColumn ? "bg-drawer" : "bg-screen")}
        // Use the column's measured inset so UIKit recognizes the resting top.
        // Padding visually clears the bar but leaves the native scroll offset
        // past its edge, activating scroll-edge protection before any scroll.
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        contentOffset={props.contentOffset ?? { x: 0, y: -insets.top }}
      />
    </ScrollViewMarker>
  );
}

function renderHomeScrollView(props: ScrollViewProps) {
  // FlatList clones this element with its cells and ref. Keep the marker inside
  // the component so those cells remain children of the actual ScrollView.
  return <HomeScrollView {...props} />;
}

/* ─── Main screen ────────────────────────────────────────────────────── */

export function HomeScreen(props: HomeScreenProps) {
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const workspace = useWorkspaceTabs();
  const [initialScrollOffset] = useState(() => workspace?.getScrollOffset("threads") ?? 0);
  const primaryColumn = use(NativePrimaryColumnContext);
  const contentBackground = primaryColumn ? "bg-drawer" : "bg-screen";
  const containerClassName = cn(
    "flex-1",
    Platform.OS === "android" ? "bg-header" : contentBackground,
  );
  const columnMetrics = useNativeColumnLayoutMetrics();
  const selectedThreadKey = primaryColumn?.selectedThreadKey ?? null;
  const fullSwipeWidth = primaryColumn && columnMetrics ? columnMetrics.width - 20 : undefined;
  const queuedThreadKeys = useQueuedThreadKeys();
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  // Let trackpad scrolling coexist with each row's horizontal swipe gesture.
  const homeScrollGesture = useNativeGesture();
  const insets = useSafeAreaInsets();
  const { fabClearance } = useAndroidControlSizing();
  const screenMetrics = useNativeLayoutMetrics();
  const contentSideInsets = usesNativeWorkspaceColumns
    ? (columnMetrics ?? screenMetrics)?.safeArea
    : undefined;
  // UIKit's column safe area already includes its bottom toolbar.
  const iosBottomClearance = Math.max(
    columnMetrics?.safeArea.bottom ?? insets.bottom,
    24,
    workspace?.bottomClearance ?? 0,
  );
  const searchEnvironmentIds = useMemo(
    () =>
      props.selectedEnvironmentId === null
        ? props.environments
            .filter((environment) => environment.connectionState === "connected")
            .map((environment) => environment.environmentId)
        : props.environments.some(
              (environment) =>
                environment.environmentId === props.selectedEnvironmentId &&
                environment.connectionState === "connected",
            )
          ? [props.selectedEnvironmentId]
          : [],
    [props.environments, props.selectedEnvironmentId],
  );
  const threadSearch = useThreadSearch(searchEnvironmentIds, props.searchQuery);
  const threadSearchMatchByKey = useMemo(() => {
    const matches = new Map<string, EnvironmentThreadSearchMatch>();
    for (const match of threadSearch.matches) {
      if (match.source === "user" || match.source === "assistant") {
        matches.set(threadSearchMatchKey(match), match);
      }
    }
    return matches;
  }, [threadSearch.matches]);
  const matchedThreadKeys = useMemo(
    () => new Set(threadSearch.matches.map(threadSearchMatchKey)),
    [threadSearch.matches],
  );
  const handleSwipeableWillOpen = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  }, []);

  const handleSwipeableClose = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  }, []);

  const handleScrollBeginDrag = useCallback(() => {
    openSwipeableRef.current?.close();
  }, []);
  const onMaterialFabScroll = useMaterialFabScroll();
  const listRef = useRef<LegendListRef>(null);
  const searchMode = workspace?.state.tabs.threads.searchMode;
  const restoredOffset = workspace?.state.tabs.threads.scrollOffset;
  useEffect(() => {
    if (searchMode !== "resting" || restoredOffset === undefined) return;
    listRef.current?.scrollToOffset({
      offset: restoredOffset - (Platform.OS === "ios" ? insets.top : 0),
      animated: false,
    });
  }, [searchMode, insets.top, restoredOffset]);
  const swipeRowActivation = useMemo(() => createSwipeRowActivation(), []);
  const activateVisibleRows = useCallback(
    (rows: ReadonlyArray<{ readonly key: string }>) => {
      const state = listRef.current?.getState();
      if (state === undefined || !(state.end >= 0)) return;
      swipeRowActivation.activate(
        rows.slice(Math.max(0, state.start - 2), state.end + 3).map((row) => row.key),
      );
    },
    [swipeRowActivation],
  );
  // Status-bar, accessibility and programmatic scrolls never arm the scroll
  // gate, so every scroll also activates the visible rows once it settles.
  const activationTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(activationTimerRef.current), []);
  const handleListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      onMaterialFabScroll?.(event);
      if (workspace)
        workspace.recordScrollOffset(
          "threads",
          Math.max(0, event.nativeEvent.contentOffset.y + (Platform.OS === "ios" ? insets.top : 0)),
        );
      clearTimeout(activationTimerRef.current);
      activationTimerRef.current = setTimeout(
        () => activateVisibleRows(listRef.current?.getState().data ?? []),
        200,
      );
    },
    [activateVisibleRows, onMaterialFabScroll, workspace, insets.top],
  );
  const trackListTouches = useCallback(
    (event: GestureResponderEvent, started: boolean) => {
      const { changedTouches, touches } = event.nativeEvent;
      swipeRowActivation.trackTouches(
        started ? changedTouches.map((touch) => String(touch.identifier)) : [],
        touches.map((touch) => String(touch.identifier)),
      );
    },
    [swipeRowActivation],
  );
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScroll: handleListScroll,
    onScrollBeginDrag: handleScrollBeginDrag,
  });

  const projectScopes = useMemo(
    () =>
      buildHomeProjectScopes({
        projects: props.projects,
        environmentId: props.selectedEnvironmentId,
        projectGroupingMode: props.projectGroupingMode,
      }),
    [props.projectGroupingMode, props.projects, props.selectedEnvironmentId],
  );
  const hasSearchQuery = props.searchQuery.trim().length > 0;
  const projectByKey = useMemo(() => {
    const map = new Map<string, EnvironmentProject>();
    for (const project of props.projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project);
    }
    return map;
  }, [props.projects]);

  const v2ProjectScopeKey = props.selectedProjectKey;
  const v2ScopedProjectGroup = useMemo(
    () => findHomeProjectScope(projectScopes, v2ProjectScopeKey),
    [v2ProjectScopeKey, projectScopes],
  );
  const v2ProjectTitleByProjectKey = useMemo(
    () =>
      new Map(
        projectScopes.flatMap((scope) =>
          scope.projectRefs.map(
            (projectRef) =>
              [
                scopedProjectKey(projectRef.environmentId, projectRef.projectId),
                scope.title,
              ] as const,
          ),
        ),
      ),
    [projectScopes],
  );
  const v2ScopedProjectKeys = useMemo(
    () =>
      v2ScopedProjectGroup === null
        ? null
        : new Set(
            v2ScopedProjectGroup.projectRefs.map((projectRef) =>
              scopedProjectKey(projectRef.environmentId, projectRef.projectId),
            ),
          ),
    [v2ScopedProjectGroup],
  );
  // Thread List v2 (beta): one flat list in creation order, no grouping.
  // Settled threads collapse into a recency tail below the card block.
  // Settled threads stay in the live shell stream (settled ≠ archived), so
  // the partition works directly off live shells — no snapshot merging or
  // optimistic holds.
  const handleSettleThread = props.onSettleThread;
  const handleSnoozeThread = useCallback(
    (thread: EnvironmentThreadShell, snoozedUntil: string) => {
      void props.onSnoozeThread(thread, snoozedUntil);
    },
    [props.onSnoozeThread],
  );
  const handleUnsnoozeThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onUnsnoozeThread(thread);
    },
    [props.onUnsnoozeThread],
  );
  const handlePinThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onPinThread(thread);
    },
    [props.onPinThread],
  );
  // In project sections, Move up/down steps through the project's rows (groups
  // included) in the device-local row order; see `moveRowRef` below.
  const moveRowRef = useRef<
    ((thread: EnvironmentThreadShell, direction: "up" | "down") => boolean) | null
  >(null);
  const handleMoveThread = useCallback(
    (thread: EnvironmentThreadShell, direction: ThreadMoveDestination) => {
      if (typeof direction === "string" && moveRowRef.current?.(thread, direction)) return;
      void props.onMoveThread(thread, direction);
    },
    [props.onMoveThread],
  );
  const handleUnpinThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onUnpinThread(thread);
    },
    [props.onUnpinThread],
  );
  const handleSetThreadAutoSettle = useCallback(
    (thread: EnvironmentThreadShell, enabled: boolean) => {
      void props.onSetThreadAutoSettle(thread, enabled);
    },
    [props.onSetThreadAutoSettle],
  );
  const handleRegenerateThreadTitle = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onRegenerateThreadTitle(thread);
    },
    [props.onRegenerateThreadTitle],
  );
  const handleRenameThread = useCallback(
    (thread: EnvironmentThreadShell) => props.onRenameThread(thread),
    [props.onRenameThread],
  );
  const handleDeleteThread = props.onDeleteThread;
  const handleUnsettleThread = props.onUnsettleThread;
  // The settled tail renders in pages; expansion resets when the filter
  // context changes so environment/search flips never inherit a deep page.
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  );
  const settledResetKey = `${props.selectedEnvironmentId ?? "all"}:${v2ProjectScopeKey ?? "all"}:${props.searchQuery.trim()}`;
  const lastSettledResetKeyRef = useRef(settledResetKey);
  if (lastSettledResetKeyRef.current !== settledResetKey) {
    lastSettledResetKeyRef.current = settledResetKey;
    setSettledVisibleCount(THREAD_LIST_V2_SETTLED_INITIAL_COUNT);
  }
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + THREAD_LIST_V2_SETTLED_PAGE_COUNT),
    [],
  );
  const {
    loaded: shelfPreferencesLoaded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
    byProject,
  } = useThreadListV2ShelfPreferences();
  // The queued-start and snooze helpers need a clock while the list stays open.
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));
  // Snooze wake times are second-precise; a counter bumped exactly at the
  // next wake boundary re-runs the partition with a fresh clock so a woken
  // thread reappears immediately instead of on the next minute tick.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  useFocusEffect(
    useCallback(() => {
      // Refresh immediately on enable or focus because the previous value can be hours old.
      setNowMinute(new Date().toISOString().slice(0, 16));
      const id = setInterval(() => setNowMinute(new Date().toISOString().slice(0, 16)), 60_000);
      return () => clearInterval(id);
    }, []),
  );
  // Threads on servers without the settlement capability never classify as
  // settled (the user could neither un-settle nor pin them).
  const listEnvironments = useAtomValue(threadListEnvironmentsAtom);
  const {
    providersByEnvironmentId,
    machineByEnvironmentId,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    pinningEnvironmentIds,
    autoSettleOptOutEnvironmentIds,
    pinReorderEnvironmentIds,
    activeReorderEnvironmentIds,
    titleRegenerationEnvironmentIds,
  } = listEnvironments;
  const resolveProviderInstance = useThreadRowProviderInstanceResolver(providersByEnvironmentId);
  const pendingOrder = usePendingThreadOrder(nowMinute, snoozeWakeTick);
  // Up/down menu availability for every card, computed once per section per
  // rebuild (see computeThreadMoveAvailability): per-thread planner calls made
  // list construction quadratic, and this list rebuilds on every minute tick.
  const threadMoveAvailability = useMemo(() => {
    const sectionAvailability = (section: "pinned" | "active") =>
      computeThreadMoveAvailability({
        allThreads: props.threads,
        section,
        pendingOrder,
        reorderableEnvironmentIds:
          section === "pinned" ? pinReorderEnvironmentIds : activeReorderEnvironmentIds,
        ordered: getThreadListV2OrderedSection({
          threads: props.threads,
          section,
          pendingOrder,
          now: new Date().toISOString(),
          settlementEnvironmentIds,
          snoozeEnvironmentIds,
          queuedThreadKeys,
        }),
      });
    // The Working beta orders the inbox by time, so only pins can move.
    return new Map([
      ...sectionAvailability("pinned"),
      ...(workingShelfEnabled ? [] : sectionAvailability("active")),
    ]);
  }, [
    workingShelfEnabled,
    pinReorderEnvironmentIds,
    activeReorderEnvironmentIds,
    props.threads,
    pendingOrder,
    queuedThreadKeys,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    nowMinute,
    snoozeWakeTick,
  ]);
  const threadListV2Layout = useMemo(() => {
    threadListInboxReturns.observe(workingShelfEnabled ? props.threads : null);
    // Settled threads are live shells; archived threads keep their original
    // "hidden from lists" meaning.
    return buildThreadListV2Items({
      pendingOrder,
      threads: props.threads.filter((thread) => thread.archivedAt === null),
      environmentId: props.selectedEnvironmentId,
      projectRefs: v2ScopedProjectGroup === null ? null : v2ScopedProjectGroup.projectRefs,
      searchQuery: props.searchQuery,
      matchedThreadKeys,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      queuedThreadKeys,
      settledLimit: settledVisibleCount,
      now: new Date().toISOString(),
      workingShelfEnabled,
      workingShelfExpanded,
      inboxReturnAt: threadListInboxReturns.returnedAt,
      snoozedShelfExpanded,
      settledShelfExpanded,
      selectedThreadKey,
    });
  }, [
    workingShelfEnabled,
    workingShelfExpanded,
    pendingOrder,
    selectedThreadKey,
    queuedThreadKeys,
    nowMinute,
    snoozeWakeTick,
    snoozedShelfExpanded,
    settledShelfExpanded,
    settledVisibleCount,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    props.searchQuery,
    props.selectedEnvironmentId,
    props.threads,
    matchedThreadKeys,
    v2ScopedProjectGroup,
  ]);
  // Re-partition the moment the earliest snooze expires (clamped to the
  // signed-32-bit setTimeout range; far-future wakes re-arm at the clamp).
  const nextSnoozeWakeAt = threadListV2Layout.nextSnoozeWakeAt;
  useEffect(() => {
    if (nextSnoozeWakeAt === null) return;
    const wakeAtMs = Date.parse(nextSnoozeWakeAt);
    if (Number.isNaN(wakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => clearTimeout(id);
    // snoozeWakeTick must re-arm the timer even when nextSnoozeWakeAt is
    // unchanged: after a clamped fire (wake beyond the 32-bit setTimeout
    // range) the boundary string is identical and the chain would die.
  }, [nextSnoozeWakeAt, snoozeWakeTick]);
  // Queued tasks are not thread shells, so the v2 partition never sees them;
  // they are spliced in below the active block and stay visible and deletable
  // while their environment is offline. Same environment scope and search
  // filter as the list itself.
  const v2SearchQuery = props.searchQuery.trim().toLocaleLowerCase();
  const v2PendingTasks = useMemo(
    () =>
      props.pendingTasks.filter(
        (pendingTask) =>
          (props.selectedEnvironmentId === null ||
            pendingTask.environmentId === props.selectedEnvironmentId) &&
          (v2ScopedProjectKeys === null ||
            v2ScopedProjectKeys.has(
              scopedProjectKey(pendingTask.environmentId, pendingTask.projectId),
            )) &&
          (v2SearchQuery.length === 0 ||
            pendingTask.title.toLocaleLowerCase().includes(v2SearchQuery)),
      ),
    [props.pendingTasks, props.selectedEnvironmentId, v2ScopedProjectKeys, v2SearchQuery],
  );
  const threadListV2Items = useMemo(
    () =>
      buildThreadListV2ListItems({
        items: threadListV2Layout.items,
        pendingTasks: v2PendingTasks,
        workingCount: threadListV2Layout.workingCount,
        workingShelfExpanded,
        workingShelfHeaderIndex: threadListV2Layout.workingShelfHeaderIndex,
        snoozedCount: threadListV2Layout.snoozedCount,
        snoozedShelfExpanded,
        snoozedShelfHeaderIndex: threadListV2Layout.snoozedShelfHeaderIndex,
        settledCount: threadListV2Layout.settledCount,
        settledShelfExpanded,
        settledShelfHeaderIndex: threadListV2Layout.settledShelfHeaderIndex,
        snoozeLabelNow: `${nowMinute}:00.000Z`,
        snoozeEnvironmentIds,
        queuedThreadKeys,
        moveAvailability: threadMoveAvailability,
        shelfPreferencesLoading: !shelfPreferencesLoaded,
      }),
    [
      nowMinute,
      queuedThreadKeys,
      threadMoveAvailability,
      settledShelfExpanded,
      shelfPreferencesLoaded,
      snoozedShelfExpanded,
      snoozeEnvironmentIds,
      threadListV2Layout,
      v2PendingTasks,
      workingShelfExpanded,
    ],
  );

  const threadGroups = useAtomValue(environmentThreadGroups.threadGroupsAtom);
  const groupByThreadKey = useMemo(() => {
    const map = new Map<
      string,
      { readonly key: string; readonly title: string; readonly index: number }
    >();
    for (const group of threadGroups) {
      if (!group.visible) continue;
      const key = `${group.environmentId}:${group.id}`;
      for (const [index, threadId] of group.threadIds.entries()) {
        map.set(scopedThreadKey(group.environmentId, threadId), { key, title: group.title, index });
      }
    }
    return map;
  }, [threadGroups]);
  const projectScopeByKey = useMemo(
    () => new Map(projectScopes.map((scope) => [scope.key, scope])),
    [projectScopes],
  );
  const projectScopeByProjectKey = useMemo(
    () =>
      new Map(
        projectScopes.flatMap((scope) =>
          scope.projectRefs.map(
            (projectRef) =>
              [
                scopedProjectKey(projectRef.environmentId, projectRef.projectId),
                { key: scope.key, title: scope.title },
              ] as const,
          ),
        ),
      ),
    [projectScopes],
  );
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = useCallback((groupKey: string) => {
    setExpandedGroupKeys((current) => {
      const next = new Set(current);
      if (!next.delete(groupKey)) next.add(groupKey);
      return next;
    });
  }, []);
  const openGroupKey =
    selectedThreadKey === null ? undefined : groupByThreadKey.get(selectedThreadKey)?.key;
  // Search results stay one flat list ranked by match.
  const sectionedByProject = byProject && !hasSearchQuery;
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const projectOrder = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.threadListProjectOrder
    : undefined;
  const rowOrder = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.threadListRowOrder
    : undefined;
  const collapsedProjects = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.threadListCollapsedProjects
    : undefined;
  const collapsedProjectKeys = useMemo(() => new Set(collapsedProjects ?? []), [collapsedProjects]);
  const toggleProject = useCallback(
    (projectKey: string) => {
      const next = new Set(collapsedProjectKeys);
      if (!next.delete(projectKey)) next.add(projectKey);
      savePreferences({ threadListCollapsedProjects: [...next] });
    },
    [collapsedProjectKeys, savePreferences],
  );
  // Holding a project header folds every project and lifts it; the order
  // follows the finger and saves on release, then the old folding returns.
  const [projectDrag, setProjectDrag] = useState<{
    readonly key: string;
    readonly order: ReadonlyArray<string>;
    readonly from: number;
    readonly startTop: number;
    readonly liftedTop: number | null;
    readonly translation: number;
  } | null>(null);
  const [projectHeaderHeight, setProjectHeaderHeight] = useState(40);
  const projectDragLayout = useMemo(() => {
    if (projectDrag === null) return null;
    const delta =
      projectDrag.startTop +
      projectDrag.translation -
      (projectDrag.liftedTop ?? projectDrag.startTop);
    const target = Math.max(
      0,
      Math.min(
        projectDrag.order.length - 1,
        projectDrag.from + Math.round(delta / projectHeaderHeight),
      ),
    );
    const order = projectDrag.order.filter((key) => key !== projectDrag.key);
    order.splice(target, 0, projectDrag.key);
    return {
      order,
      liftOffset:
        projectDrag.liftedTop === null
          ? 0
          : delta - (target - projectDrag.from) * projectHeaderHeight,
    };
  }, [projectDrag, projectHeaderHeight]);
  // Arrange mode: drag handles on groups, chats and threads, each moving among
  // its siblings. Row heights vary, so the target slot comes from measured heights.
  const [arrangeMode, setArrangeMode] = useState(false);
  const rowHeightsRef = useRef(new Map<string, number>());
  const [rowDrag, setRowDrag] = useState<{
    readonly key: string;
    readonly siblings: string;
    readonly keys: ReadonlyArray<string>;
    readonly translation: number;
  } | null>(null);
  const rowDragLayout = useMemo(() => {
    if (rowDrag === null) return null;
    const height = (key: string) => rowHeightsRef.current.get(key) ?? 72;
    const from = rowDrag.keys.indexOf(rowDrag.key);
    const oldTop = rowDrag.keys.slice(0, from).reduce((sum, key) => sum + height(key), 0);
    const center = oldTop + rowDrag.translation + height(rowDrag.key) / 2;
    const rest = rowDrag.keys.filter((key) => key !== rowDrag.key);
    let target = rest.length;
    let top = 0;
    for (const [index, key] of rest.entries()) {
      if (center < top + height(key) / 2) {
        target = index;
        break;
      }
      top += height(key);
    }
    const newTop = rest.slice(0, target).reduce((sum, key) => sum + height(key), 0);
    const order = [...rest];
    order.splice(target, 0, rowDrag.key);
    return { order, target, liftOffset: oldTop + rowDrag.translation - newTop };
  }, [rowDrag]);
  const homeSections = useMemo((): HomeProjectSections | null => {
    if (!sectionedByProject) return null;
    return buildHomeProjectSections({
      ...(projectDragLayout
        ? { projectOrder: projectDragLayout.order }
        : projectOrder
          ? { projectOrder }
          : {}),
      ...(rowOrder ? { rowOrder } : {}),
      collapsedProjectKeys: projectDrag ? new Set(projectDrag.order) : collapsedProjectKeys,
      ...(rowDrag && rowDragLayout
        ? { liveOrder: { siblings: rowDrag.siblings, order: rowDragLayout.order } }
        : {}),
      items: threadListV2Items,
      showProjectHeaders: v2ScopedProjectGroup === null,
      projectOf: (thread) =>
        projectScopeByProjectKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ??
        null,
      groupOf: (thread) =>
        groupByThreadKey.get(scopedThreadKey(thread.environmentId, thread.id)) ?? null,
      // The group holding the open chat (iPad split view) stays open.
      // Groups fold while one is dragged so the project's groups sit together.
      expandedGroupKeys: rowDrag?.siblings.startsWith("rows:")
        ? new Set<string>()
        : openGroupKey === undefined
          ? expandedGroupKeys
          : new Set([...expandedGroupKeys, openGroupKey]),
    });
  }, [
    rowDrag,
    rowDragLayout,
    projectDrag,
    projectDragLayout,
    projectOrder,
    rowOrder,
    collapsedProjectKeys,
    openGroupKey,
    sectionedByProject,
    threadListV2Items,
    v2ScopedProjectGroup,
    projectScopeByProjectKey,
    groupByThreadKey,
    expandedGroupKeys,
  ]);
  // Edit and drag state ride on the items: the recycled list only redraws rows whose item changed.
  const homeListItems = useMemo((): ReadonlyArray<ListItem> => {
    const base: ReadonlyArray<ListItem> = homeSections?.items ?? threadListV2Items;
    if (homeSections === null || (!arrangeMode && projectDrag === null && rowDrag === null)) {
      return base;
    }
    const projectHandles =
      projectDrag !== null || (arrangeMode && homeSections.projects.length > 1);
    return base.map((item): ListItem => {
      if (item.type === "home-section") {
        if (item.projectKey === undefined || !projectHandles) return item;
        return {
          ...item,
          arrange:
            projectDrag?.key === item.projectKey
              ? { handle: true, liftOffset: projectDragLayout?.liftOffset ?? 0 }
              : { handle: true },
        };
      }
      if (!arrangeMode || !homeSections.siblings.has(item.key)) return item;
      return {
        ...item,
        arrange:
          rowDrag?.key === item.key
            ? { handle: true, liftOffset: rowDragLayout?.liftOffset ?? 0 }
            : { handle: true },
      };
    });
  }, [
    homeSections,
    threadListV2Items,
    arrangeMode,
    projectDrag,
    projectDragLayout,
    rowDrag,
    rowDragLayout,
  ]);
  const visibleProjectKeysRef = useRef<ReadonlyArray<string>>([]);
  visibleProjectKeysRef.current = projectDrag
    ? visibleProjectKeysRef.current
    : (homeSections?.projects.map((project) => project.key) ?? []);
  const projectDragRef = useRef(projectDrag);
  projectDragRef.current = projectDrag;
  const projectDragLayoutRef = useRef(projectDragLayout);
  projectDragLayoutRef.current = projectDragLayout;
  const projectOrderRef = useRef(projectOrder);
  projectOrderRef.current = projectOrder;
  const projectDragHandlers = useMemo(
    () => ({
      onStart: (key: string, top: number) => {
        const order = visibleProjectKeysRef.current;
        const from = order.indexOf(key);
        if (from < 0) return;
        setProjectDrag({ key, order, from, startTop: top, liftedTop: null, translation: 0 });
      },
      onLifted: (top: number) =>
        setProjectDrag((current) => (current === null ? null : { ...current, liftedTop: top })),
      onMove: (translation: number) =>
        setProjectDrag((current) => (current === null ? null : { ...current, translation })),
      onEnd: (cancelled: boolean) => {
        // Saves run outside the state updater: they update other components.
        const layout = projectDragLayoutRef.current;
        const current = projectDragRef.current;
        setProjectDrag(null);
        if (
          current !== null &&
          !cancelled &&
          layout !== null &&
          layout.order.some((key, index) => key !== current.order[index])
        ) {
          savePreferences({
            threadListProjectOrder: mergeArrangedKeys(
              projectOrderRef.current ?? [],
              current.order,
              layout.order,
            ),
          });
        }
      },
    }),
    [savePreferences],
  );
  useEffect(() => {
    moveRowRef.current = (thread, direction) => {
      const key = `v2-thread:${thread.environmentId}:${thread.id}`;
      const set = homeSections?.siblings.get(key);
      if (set === undefined || !set.id.startsWith("rows:")) return false;
      const next = moveKey(set.keys, key, direction);
      if (next !== null) {
        savePreferences({ threadListRowOrder: mergeArrangedKeys(rowOrder ?? [], set.keys, next) });
      }
      return true;
    };
  }, [homeSections, rowOrder, savePreferences]);

  const reorderGroupMember = useAtomCommand(threadEnvironment.reorderGroup, {
    reportFailure: false,
  });
  const reorderChats = useCallback(
    async (
      members: ReadonlyArray<EnvironmentThreadShell>,
      order: ReadonlyArray<string>,
      movedId: string,
    ) => {
      const assignments = planGroupMemberReorder({
        orderedIds: order,
        keysById: new Map(
          members.map((thread) => [
            scopedThreadKey(thread.environmentId, thread.id),
            thread.groupOrderKey,
          ]),
        ),
        movedId,
      });
      const byKey = new Map(
        members.map((thread) => [scopedThreadKey(thread.environmentId, thread.id), thread]),
      );
      // Writes run bottom-up (see planGroupMemberReorder); stop on the first failure.
      for (const assignment of assignments) {
        const thread = byKey.get(assignment.id);
        if (thread === undefined) continue;
        const result = await reorderGroupMember({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, orderKey: assignment.orderKey },
        });
        if (result._tag === "Failure") {
          Alert.alert(
            "Could not reorder chats",
            "Update the T3 Code server for this environment to arrange a group's chats.",
          );
          return;
        }
      }
    },
    [reorderGroupMember],
  );
  const threadByItemKey = useMemo(() => {
    const map = new Map<string, EnvironmentThreadShell>();
    for (const item of homeListItems) {
      if (item.type === "v2-thread") map.set(item.key, item.item.thread);
    }
    return map;
  }, [homeListItems]);
  const arrangeRefs = useRef({ rowDrag, rowDragLayout, rowOrder, threadByItemKey, homeSections });
  arrangeRefs.current = { rowDrag, rowDragLayout, rowOrder, threadByItemKey, homeSections };
  const arrangeHandlers = useMemo(
    () => ({
      onHeight: (key: string, height: number) => rowHeightsRef.current.set(key, height),
      onStart: (key: string) => {
        const siblings = arrangeRefs.current.homeSections?.siblings.get(key);
        if (siblings === undefined) return;
        setRowDrag({ key, siblings: siblings.id, keys: siblings.keys, translation: 0 });
      },
      onMove: (translation: number) =>
        setRowDrag((current) => (current === null ? null : { ...current, translation })),
      onEnd: (cancelled: boolean) => {
        const {
          rowDragLayout: layout,
          rowOrder: storedRowOrder,
          threadByItemKey: threads,
        } = arrangeRefs.current;
        const current = arrangeRefs.current.rowDrag;
        setRowDrag(null);
        // Saves and commands run outside the state updater: they update other components.
        (() => {
          if (current === null || cancelled || layout === null) return;
          const { order, target } = layout;
          if (!order.some((key, index) => key !== current.keys[index])) return;
          if (current.siblings.startsWith("rows:")) {
            savePreferences({
              threadListRowOrder: mergeArrangedKeys(storedRowOrder ?? [], current.keys, order),
            });
            return;
          }
          const members = order.flatMap((key) => {
            const thread = threads.get(key);
            return thread ? [thread] : [];
          });
          const scoped = members.map((thread) => scopedThreadKey(thread.environmentId, thread.id));
          const moved = threads.get(current.key);
          if (moved === undefined || members.length !== order.length) return;
          if (current.siblings.startsWith("chats:")) {
            void reorderChats(members, scoped, scopedThreadKey(moved.environmentId, moved.id));
            return;
          }
          // Pinned or a project's threads: place it next to its new neighbour.
          const neighbor = target < members.length - 1 ? members[target + 1] : members[target - 1];
          if (neighbor !== undefined) {
            void props.onMoveThread(moved, {
              targetId: scopedThreadKey(neighbor.environmentId, neighbor.id),
              placement: target < members.length - 1 ? "before" : "after",
            });
          }
        })();
      },
    }),
    [props.onMoveThread, reorderChats, savePreferences],
  );
  const enterArrangeMode = useCallback(() => setArrangeMode(true), []);
  const exitArrangeMode = useCallback(() => {
    setRowDrag(null);
    setArrangeMode(false);
  }, []);
  // The thread menu's Arrange threads opens this mode while the list is grouped.
  useEffect(() => {
    appAtomRegistry.set(homeArrangesInPlaceAtom, sectionedByProject);
    return () => appAtomRegistry.set(homeArrangesInPlaceAtom, false);
  }, [sectionedByProject]);
  const arrangeRequested = useAtomValue(threadArrangementOpenAtom);
  useEffect(() => {
    if (!arrangeRequested || !sectionedByProject) return;
    appAtomRegistry.set(threadArrangementOpenAtom, false);
    setArrangeMode(true);
  }, [arrangeRequested, sectionedByProject]);
  useEffect(() => {
    if (!sectionedByProject) exitArrangeMode();
  }, [sectionedByProject, exitArrangeMode]);
  // Android back leaves Arrange mode, like Done.
  useEffect(() => {
    if (!arrangeMode || Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      exitArrangeMode();
      return true;
    });
    return () => subscription.remove();
  }, [arrangeMode, exitArrangeMode]);

  const canArrangeProjects = (homeSections?.projects.length ?? 0) > 1;
  const shortcutItems = useMemo(
    () => homeListItems.filter(isThreadListV2ListItem),
    [homeListItems],
  );
  // Chips list projects with unsettled work, plus the selected one so it can be cleared.
  const chipProjects = useMemo(() => {
    const live = new Set<string>();
    for (const thread of props.threads) {
      if (
        thread.archivedAt !== null ||
        thread.settledOverride === "settled" ||
        thread.lineage.relationshipToParent === "subagent"
      )
        continue;
      const scopeKey = projectScopeByProjectKey.get(
        scopedProjectKey(thread.environmentId, thread.projectId),
      )?.key;
      if (scopeKey !== undefined) live.add(scopeKey);
    }
    return projectScopes
      .filter((scope) => live.has(scope.key) || scope.key === props.selectedProjectKey)
      .map((scope) => ({ key: scope.key, label: scope.title }));
  }, [props.threads, props.selectedProjectKey, projectScopes, projectScopeByProjectKey]);
  // A chip dot says a project has a thread waiting on the user, or else one working.
  const projectIndicators = useMemo(() => {
    const map = new Map<string, ProjectChipIndicator>();
    for (const thread of props.threads) {
      if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent")
        continue;
      const scopeKey = projectScopeByProjectKey.get(
        scopedProjectKey(thread.environmentId, thread.projectId),
      )?.key;
      if (scopeKey === undefined || map.get(scopeKey) === "attention") continue;
      const status = resolveThreadListV2Status(thread);
      if (status === "approval" || status === "input") map.set(scopeKey, "attention");
      else if (status === "working") map.set(scopeKey, "working");
    }
    return map;
  }, [props.threads, projectScopeByProjectKey]);

  useThreadJumpShortcuts(shortcutItems, props.onSelectThread);
  useEffect(() => {
    if (swipeEnabled) activateVisibleRows(homeListItems);
  }, [activateVisibleRows, swipeEnabled, homeListItems]);

  const withArrangeHandle = useCallback(
    (
      arrange: ArrangeStamp | undefined,
      key: string,
      label: string,
      row: ReactNode,
      interactive = false,
    ) =>
      arrange === undefined ? (
        row
      ) : (
        <HomeArrangeRow
          itemKey={key}
          label={label}
          handlers={arrangeHandlers}
          interactive={interactive}
          {...(arrange.liftOffset === undefined ? {} : { liftOffset: arrange.liftOffset })}
        >
          {row}
        </HomeArrangeRow>
      ),
    [arrangeHandlers],
  );
  const renderV2Item = useCallback(
    ({ item }: { readonly item: ListItem }) => {
      if (item.type === "home-section") {
        const divider = (
          <ThreadListV2SectionDivider
            label={item.label}
            tone={item.tone}
            pane={primaryColumn ? "sidebar" : "screen"}
          />
        );
        if (item.projectKey === undefined) return divider;
        const scope = projectScopeByKey.get(item.projectKey);
        return (
          <HomeProjectHeader
            projectKey={item.projectKey}
            label={item.label}
            project={scope?.representative ?? null}
            collapsed={item.collapsed === true}
            count={item.count ?? 0}
            pane={primaryColumn ? "sidebar" : "screen"}
            onToggle={toggleProject}
            onHeight={setProjectHeaderHeight}
            {...(item.arrange ? { drag: projectDragHandlers } : {})}
            {...(item.arrange?.liftOffset === undefined
              ? {}
              : { liftOffset: item.arrange.liftOffset })}
          />
        );
      }
      if (item.type === "home-group") {
        const groupRow = (
          <HomeGroupRow
            groupKey={item.key.slice("home-group:".length)}
            title={item.title}
            threads={item.threads}
            workingCount={item.workingCount}
            expanded={item.expanded}
            showTrailingDivider={item.showTrailingDivider}
            pane={primaryColumn ? "sidebar" : "screen"}
            onToggle={toggleGroup}
            onArrange={enterArrangeMode}
          />
        );
        return withArrangeHandle(item.arrange, item.key, item.title, groupRow, true);
      }
      if (item.type === "v2-pending") {
        const pendingScopeKey = scopedProjectKey(
          item.pendingTask.environmentId,
          item.pendingTask.projectId,
        );
        return (
          <ThreadListV2PendingRow
            pendingTask={item.pendingTask}
            project={projectByKey.get(pendingScopeKey) ?? null}
            projectTitle={v2ProjectTitleByProjectKey.get(pendingScopeKey)}
            environmentLabel={
              Object.keys(props.savedConnectionsById).length > 1
                ? (props.savedConnectionsById[item.pendingTask.environmentId]?.environmentLabel ??
                  null)
                : null
            }
            environmentMachine={machineByEnvironmentId.get(item.pendingTask.environmentId)}
            showPendingDivider={item.showPendingDivider}
            showTrailingDivider={item.showTrailingDivider}
            onSelectPendingTask={props.onSelectPendingTask}
            onDeletePendingTask={props.onDeletePendingTask}
          />
        );
      }
      if (item.type === "v2-working-shelf") {
        return (
          <ThreadListV2WorkingShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            onToggle={toggleWorkingShelf}
          />
        );
      }
      if (item.type === "v2-snoozed-shelf") {
        return (
          <ThreadListV2SnoozedShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            onToggle={toggleSnoozedShelf}
          />
        );
      }
      if (item.type === "v2-settled-shelf") {
        return (
          <ThreadListV2SettledShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            onToggle={toggleSettledShelf}
          />
        );
      }
      const thread = item.item.thread;
      const row = (
        <ThreadListV2Row
          pane={primaryColumn ? "sidebar" : "screen"}
          selected={scopedThreadKey(thread.environmentId, thread.id) === selectedThreadKey}
          fullSwipeWidth={fullSwipeWidth}
          onNewThreadOnBranch={props.onNewThreadOnBranch}
          thread={thread}
          variant={item.item.variant}
          hasQueuedMessages={item.hasQueuedMessages}
          snoozed={item.item.snoozed}
          pinned={item.item.pinned}
          snoozePresetMinute={item.snoozePresetMinute ?? ""}
          snoozeWakeLabelText={item.snoozeWakeLabelText}
          timeLabel={item.timeLabel}
          showTrailingDivider={item.showTrailingDivider}
          project={
            projectByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ?? null
          }
          projectTitle={v2ProjectTitleByProjectKey.get(
            scopedProjectKey(thread.environmentId, thread.projectId),
          )}
          hideProject={"underProject" in item}
          providerInstance={resolveProviderInstance(thread)}
          providers={providersByEnvironmentId.get(thread.environmentId)}
          environmentLabel={
            Object.keys(props.savedConnectionsById).length > 1
              ? (props.savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
              : null
          }
          environmentMachine={machineByEnvironmentId.get(thread.environmentId)}
          searchMatch={threadSearchMatchByKey.get(
            threadSearchMatchKey({
              environmentId: thread.environmentId,
              threadId: thread.id,
            }),
          )}
          searchQuery={props.searchQuery}
          onSelectThread={props.onSelectThread}
          onDeleteThread={handleDeleteThread}
          onArchiveThread={props.onArchiveThread}
          onRenameThread={handleRenameThread}
          onRegenerateThreadTitle={handleRegenerateThreadTitle}
          titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
          settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
          onSettleThread={handleSettleThread}
          snoozeSupported={snoozeEnvironmentIds.has(thread.environmentId)}
          pinningSupported={pinningEnvironmentIds.has(thread.environmentId)}
          autoSettleOptOutSupported={autoSettleOptOutEnvironmentIds.has(thread.environmentId)}
          reorderSupported={
            item.item.pinned
              ? pinReorderEnvironmentIds.has(thread.environmentId)
              : !workingShelfEnabled && activeReorderEnvironmentIds.has(thread.environmentId)
          }
          canMoveUp={item.canMoveUp}
          canMoveDown={item.canMoveDown}
          onSnoozeThread={handleSnoozeThread}
          onUnsnoozeThread={handleUnsnoozeThread}
          onUnsettleThread={handleUnsettleThread}
          onPinThread={handlePinThread}
          onUnpinThread={handleUnpinThread}
          onSetThreadAutoSettle={handleSetThreadAutoSettle}
          onMoveThread={handleMoveThread}
          onSwipeableClose={handleSwipeableClose}
          onSwipeableWillOpen={handleSwipeableWillOpen}
          simultaneousSwipeGesture={homeScrollGesture}
          activationKey={item.key}
        />
      );
      // Chats of an expanded group sit under its row, one step in.
      const handled = withArrangeHandle(item.arrange, item.key, thread.title, row);
      return "groupMember" in item ? <View className="pl-4">{handled}</View> : handled;
    },
    [
      withArrangeHandle,
      toggleGroup,
      toggleProject,
      projectScopeByKey,
      enterArrangeMode,
      canArrangeProjects,
      arrangeMode,
      projectDrag,
      projectDragLayout,
      projectDragHandlers,
      handleDeleteThread,
      activeReorderEnvironmentIds,
      handleMoveThread,
      handlePinThread,
      handleRegenerateThreadTitle,
      handleRenameThread,
      handleSettleThread,
      handleSnoozeThread,
      handleUnpinThread,
      handleUnsnoozeThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      handleUnsettleThread,
      handleSetThreadAutoSettle,
      homeScrollGesture,
      autoSettleOptOutEnvironmentIds,
      pinningEnvironmentIds,
      autoSettleOptOutEnvironmentIds,
      machineByEnvironmentId,
      pinReorderEnvironmentIds,
      projectByKey,
      props.onArchiveThread,
      props.onDeletePendingTask,
      props.onSelectPendingTask,
      props.onSelectThread,
      primaryColumn,
      selectedThreadKey,
      fullSwipeWidth,
      props.onNewThreadOnBranch,
      props.savedConnectionsById,
      resolveProviderInstance,
      providersByEnvironmentId,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      threadSearchMatchByKey,
      titleRegenerationEnvironmentIds,
      toggleSettledShelf,
      toggleSnoozedShelf,
      toggleWorkingShelf,
      v2ProjectTitleByProjectKey,
      props.searchQuery,
      workingShelfEnabled,
    ],
  );
  const v2KeyExtractor = useCallback((item: ListItem) => item.key, []);
  const homeItemsAreEqual = useCallback(
    (previous: ListItem, item: ListItem) =>
      previous.arrange?.handle === item.arrange?.handle &&
      previous.arrange?.liftOffset === item.arrange?.liftOffset &&
      homeListItemsAreEqual(previous, item, threadListV2ListItemsAreEqual),
    [],
  );

  // FlatList/LegendList treat a changed extraData identity as "re-render every
  // visible row", so an inline object literal would invalidate all rows on
  // every HomeScreen render — and the minute clock must stay out of it for
  // the same reason: the clock text is precomputed per item instead.
  const v2ExtraData = useMemo(
    () => ({
      projectByKey,
      projectTitleByProjectKey: v2ProjectTitleByProjectKey,
      listEnvironments,
      savedConnectionsById: props.savedConnectionsById,
      searchQuery: props.searchQuery,
      selectedThreadKey,
      threadSearchMatchByKey,
      // Rows read it for their reorder menu items.
      workingShelfEnabled,
    }),
    [
      projectByKey,
      props.searchQuery,
      selectedThreadKey,
      props.savedConnectionsById,
      listEnvironments,
      threadSearchMatchByKey,
      v2ProjectTitleByProjectKey,
      workingShelfEnabled,
    ],
  );

  /* Empty states */
  // The signal must ignore the search/environment filters: an active query
  // that matches nothing needs the in-list "No results" state, not the
  // full-page "No threads yet". Settled threads are unarchived live shells,
  // so the archived-at check already covers the settled shelf.
  const hasAnyThreads =
    props.threads.some((thread) => thread.archivedAt === null) || props.pendingTasks.length > 0;
  const selectedEnvironmentLabel =
    props.selectedEnvironmentId === null
      ? null
      : (props.savedConnectionsById[props.selectedEnvironmentId]?.environmentLabel ??
        "this environment");
  // Connection state surfaces in the header title slot
  // (WorkspaceConnectionTitle) — nothing renders inside the list, so
  // reconnects never shift the rows.
  const emptyState = deriveEmptyState({
    catalogState: props.catalogState,
    projectCount: props.projects.length,
  });

  if (!hasAnyThreads) {
    return (
      <View className={containerClassName}>
        <View
          className={cn(
            "flex-1 items-center justify-center px-8",
            contentBackground,
            Platform.OS === "android" && "overflow-hidden rounded-t-[28px]",
          )}
          style={{
            paddingBottom: Platform.OS === "ios" ? iosBottomClearance : Math.max(insets.bottom, 24),
            paddingTop: NATIVE_LIQUID_GLASS_SUPPORTED ? insets.top + 72 : 0,
            paddingLeft: 32 + (contentSideInsets?.left ?? 0),
            paddingRight: 32 + (contentSideInsets?.right ?? 0),
          }}
        >
          <View className="w-full max-w-[430px]">
            <EmptyState
              title={emptyState.title}
              detail={emptyState.detail}
              actionLabel={!props.catalogState.hasReadyEnvironment ? "Add environment" : undefined}
              onAction={!props.catalogState.hasReadyEnvironment ? props.onAddConnection : undefined}
              action={
                Platform.OS === "android" && !props.catalogState.hasReadyEnvironment ? (
                  <MaterialFloatingActionButton
                    label="Add environment"
                    icon="plus"
                    variant="extended"
                    tone="primary"
                    onPress={props.onAddConnection}
                  />
                ) : undefined
              }
              variant="plain"
            />
            {emptyState.loading ? (
              <View className="mt-4 items-center">
                <AppActivityIndicator colorClassName="accent-icon-muted" />
              </View>
            ) : null}
          </View>
        </View>
      </View>
    );
  }

  const listHeader = Platform.OS === "ios" ? undefined : <HomeTopContentSpacer />;

  const editButton = sectionedByProject ? (
    <ListFilterChip
      label={arrangeMode ? "Done" : "Edit"}
      accessibilityLabel={arrangeMode ? "Done arranging" : "Arrange projects, groups and threads"}
      active={arrangeMode}
      onPress={arrangeMode ? exitArrangeMode : enterArrangeMode}
    />
  ) : null;
  const v2ListHeader = (
    <>
      {listHeader}
      {Platform.OS === "ios" && workspace ? (
        <ThreadListFilters
          environments={props.environments}
          projects={chipProjects}
          selectedEnvironmentId={props.selectedEnvironmentId}
          selectedProjectKey={props.selectedProjectKey}
          onEnvironmentChange={props.onEnvironmentChange}
          onProjectChange={props.onProjectChange}
          indicatorByProjectKey={projectIndicators}
          trailing={editButton}
        />
      ) : (
        <ProjectFilterChips
          projects={chipProjects}
          selectedProjectKey={props.selectedProjectKey}
          onProjectChange={props.onProjectChange}
          indicatorByProjectKey={projectIndicators}
          trailing={editButton}
        />
      )}
    </>
  );

  // Use the v2 project scope for its empty state. Snoozed threads need no
  // special empty state: their shelf header is a list row even while collapsed.
  const v2ListEmpty =
    hasSearchQuery && threadSearch.isPending ? undefined : hasSearchQuery ? (
      <EmptyState
        title="No results"
        detail={`No threads matching "${props.searchQuery}".`}
        variant={Platform.OS === "android" ? "plain" : undefined}
      />
    ) : v2ScopedProjectGroup !== null ? (
      <EmptyState
        title={`No threads in ${v2ScopedProjectGroup.title}`}
        detail="Choose another project or create a new task."
        variant={Platform.OS === "android" ? "plain" : undefined}
      />
    ) : selectedEnvironmentLabel ? (
      <EmptyState
        title={`No threads in ${selectedEnvironmentLabel}`}
        detail="Choose another environment or create a new task."
        variant={Platform.OS === "android" ? "plain" : undefined}
      />
    ) : (
      <EmptyState
        title="No threads yet"
        detail="Create a task to start a new coding session."
        variant={Platform.OS === "android" ? "plain" : undefined}
      />
    );

  if (Platform.OS === "android" && homeListItems.length === 0) {
    return (
      <View className="flex-1 bg-header">
        <View
          className="flex-1 items-center justify-center overflow-hidden rounded-t-[28px] bg-screen px-4"
          style={{ paddingBottom: insets.bottom }}
        >
          {v2ListEmpty}
        </View>
      </View>
    );
  }

  return (
    <View className={containerClassName}>
      <View
        className={
          Platform.OS === "android"
            ? "flex-1 overflow-hidden rounded-t-[28px] bg-screen"
            : cn("flex-1", contentBackground)
        }
      >
        {/* Shared with the iPad sidebar: cells are reused across data
            rebuilds and `itemsAreEqual` keeps a minute tick (or an unrelated
            shell update) from re-rendering untouched rows. */}
        <SwipeableScrollGateProvider enabled={swipeEnabled} activation={swipeRowActivation}>
          <GestureDetector gesture={homeScrollGesture}>
            <LegendList
              ref={listRef}
              onLoad={() => activateVisibleRows(homeListItems)}
              onTouchStart={(event) => trackListTouches(event, true)}
              onTouchEnd={(event) => trackListTouches(event, false)}
              onTouchCancel={(event) => trackListTouches(event, false)}
              renderScrollComponent={Platform.OS === "ios" ? renderHomeScrollView : undefined}
              scrollEnabled={projectDrag === null && rowDrag === null}
              data={homeListItems}
              renderItem={renderV2Item}
              keyExtractor={v2KeyExtractor}
              getItemType={(item) => ("groupMember" in item ? "v2-thread-member" : item.type)}
              itemsAreEqual={homeItemsAreEqual}
              estimatedItemSize={ESTIMATED_THREAD_LIST_V2_ROW_HEIGHT}
              drawDistance={THREAD_LIST_V2_DRAW_DISTANCE}
              // Edit mode inserts and wraps rows; reused cells kept stale content there.
              recycleItems={!arrangeMode}
              extraData={v2ExtraData}
              ListHeaderComponent={v2ListHeader}
              ListFooterComponent={
                settledShelfExpanded && threadListV2Layout.hiddenSettledCount > 0 ? (
                  <ThreadListV2ShowMoreRow
                    hiddenCount={threadListV2Layout.hiddenSettledCount}
                    onPress={showMoreSettled}
                  />
                ) : null
              }
              ListEmptyComponent={v2ListEmpty}
              style={{ flex: 1 }}
              automaticallyAdjustsScrollIndicatorInsets={Platform.OS === "ios"}
              contentInsetAdjustmentBehavior="never"
              contentInset={Platform.OS === "ios" ? { top: insets.top } : undefined}
              contentInsetStartAdjustment={Platform.OS === "ios" ? insets.top : 0}
              initialScrollOffset={
                initialScrollOffset > 0
                  ? initialScrollOffset - (Platform.OS === "ios" ? insets.top : 0)
                  : undefined
              }
              showsVerticalScrollIndicator={false}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              {...scrollGateHandlers}
              scrollEventThrottle={16}
              contentContainerStyle={{
                paddingLeft: (contentSideInsets?.left ?? 0) + (primaryColumn ? 8 : 0),
                paddingRight: (contentSideInsets?.right ?? 0) + (primaryColumn ? 8 : 0),
                paddingBottom:
                  Platform.OS === "ios"
                    ? iosBottomClearance
                    : (workspace?.bottomClearance ??
                      Math.max(insets.bottom, 16) +
                        (Platform.OS === "android" ? fabClearance : 88)),
              }}
            />
          </GestureDetector>
        </SwipeableScrollGateProvider>
      </View>
    </View>
  );
}
