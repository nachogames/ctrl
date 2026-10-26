import { useActiveNewTask } from "../../state/active-new-task";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import type { ThreadMoveDestination } from "../threads/threadOrder";
import type { LegendListRef } from "@legendapp/list/react-native";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { THREAD_SIDEBAR_ROW_LAYOUT } from "../threads/threadListAnimations";
import {
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { type EnvironmentId, type SidebarProjectGroupingMode } from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { planGroupMemberReorder } from "@t3tools/client-runtime/state/thread-sort";
import { AsyncResult } from "effect/reactivity";
import { useFocusEffect } from "@react-navigation/native";
import { use, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import {
  Alert,
  BackHandler,
  Platform,
  ScrollView,
  useWindowDimensions,
  View,
  type ScrollViewProps,
  type GestureResponderEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { NativeScrollViewMarker as ScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { GestureDetector, useNativeGesture } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { cn } from "../../lib/cn";
import {
  ANDROID_READING_MAX_WIDTH,
  deriveCenteredContentHorizontalPadding,
} from "../../lib/layout";
import { EmptyState } from "../../components/ui/EmptyState";
import { FloatingActionButton } from "../../components/ui/FloatingActionButton";
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
import { requestThreadMessageJump } from "../threads/threadMessageJump";
import { useThreadListSearchMatches } from "../threads/useThreadListSearchMatches";
import { useThreadListV2 } from "../threads/useThreadListV2";
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
import { useOpenThreadPullRequests } from "../threads/use-open-thread-pull-requests";
import type { ThreadPrPresentation } from "../../state/thread-pr-presentation";
import {
  threadListV2ListItemsAreEqual,
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
import { useFabScroll } from "./FabScrollContext";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import {
  ProjectFilterChips,
  ThreadListFilters,
  type ProjectChipIndicator,
} from "./ThreadListFilters";
import { HomeArrangeRow } from "./HomeArrangeRow";
import { HomeGroupRow } from "./HomeGroupRow";
import { HomeProjectHeader } from "./HomeProjectHeader";
import {
  buildHomeProjectSections,
  homeListItemsAreEqual,
  mergeArrangedKeys,
  moveKey,
  type HomeListItem,
} from "./homeProjectSections";
import { ListFilterChip } from "../workspace/ListFilterMenu";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { homeArrangesInPlaceAtom, threadArrangementOpenAtom } from "../../state/thread-order";
import { environmentThreadGroups, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/** A drag handle in Edit mode, and the offset of the row being dragged. */
interface ArrangeStamp {
  readonly handle: true;
  readonly liftOffset?: number;
}
type ListItem = HomeListItem & { readonly arrange?: ArrangeStamp };
const NO_ARRANGE: Partial<ArrangeStamp> = {};

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

const ESTIMATED_THREAD_LIST_V2_ROW_HEIGHT = 72;
// Rows away from the viewport skip their swipe actions (see
// swipe-row-activation), so render further ahead: a fast fling then reaches
// rows that are already built instead of rows still being rebuilt.
const THREAD_LIST_V2_DRAW_DISTANCE = 1_000;

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
  const primaryColumn = use(NativePrimaryColumnContext);
  if (Platform.OS !== "ios") return <ScrollView {...props} />;

  // Register the scroll view explicitly; layout and header siblings hide it from UIKit.
  return (
    <ScrollViewMarker
      style={{ flex: 1 }}
      scrollEdgeEffects={{
        ...nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version),
        top: Number.parseInt(String(Platform.Version), 10) >= 27 ? "automatic" : "soft",
      }}
    >
      <ScrollView
        {...props}
        // UIKit's scroll-edge material needs the scroll view's own surface color.
        className={cn(props.className, primaryColumn ? "bg-drawer" : "bg-screen")}
      />
    </ScrollViewMarker>
  );
}

function renderHomeScrollView(props: ScrollViewProps) {
  // FlatList clones this with cells and ref; keep the marker inside their actual ScrollView.
  return <HomeScrollView {...props} />;
}

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
  const activeNewTask = useActiveNewTask();
  const selectedThreadKey = activeNewTask ? null : (primaryColumn?.selectedThreadKey ?? null);
  const fullSwipeWidth = primaryColumn && columnMetrics ? columnMetrics.width - 20 : undefined;
  const queuedThreadKeys = useQueuedThreadKeys();
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const homeScrollGesture = useNativeGesture();
  const insets = useSafeAreaInsets();
  const { fabClearance } = useAndroidControlSizing();
  const screenMetrics = useNativeLayoutMetrics();
  const contentSideInsets = usesNativeWorkspaceColumns
    ? (columnMetrics ?? screenMetrics)?.safeArea
    : undefined;
  // Wide Android lists need reading-width gutters to clear edges and camera cutouts.
  const { width: windowWidth } = useWindowDimensions();
  const androidListGutter =
    Platform.OS === "android"
      ? deriveCenteredContentHorizontalPadding({
          viewportWidth: windowWidth,
          maxContentWidth: ANDROID_READING_MAX_WIDTH,
          minimumPadding: 0,
        })
      : 0;
  const iosBottomClearance = Math.max(
    columnMetrics?.safeArea.bottom ?? insets.bottom,
    24,
    workspace?.bottomClearance ?? 0,
  );
  const searchEnvironmentIds =
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
        : [];
  const handleSwipeableWillOpen = (methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  };

  const handleSwipeableClose = (methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  };

  const handleScrollBeginDrag = () => {
    openSwipeableRef.current?.close();
  };
  const openThreadPullRequests = useOpenThreadPullRequests();
  const handleOpenThreadPullRequests = (
    thread: EnvironmentThreadShell,
    pr: ThreadPrPresentation,
  ) => {
    openSwipeableRef.current?.close();
    openThreadPullRequests(thread, pr);
  };
  const onFabScroll = useFabScroll();
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
  const swipeRowActivation = createSwipeRowActivation();
  const activateVisibleRows = (rows: ReadonlyArray<{ readonly key: string }>) => {
    const state = listRef.current?.getState();
    if (state === undefined || !(state.end >= 0)) return;
    swipeRowActivation.activate(
      rows.slice(Math.max(0, state.start - 2), state.end + 3).map((row) => row.key),
    );
  };
  // Status-bar, accessibility and programmatic scrolls bypass the gate; activate visible rows after settling.
  const activationTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(activationTimerRef.current), []);
  const handleListScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    onFabScroll?.(event);
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
  };
  const trackListTouches = (event: GestureResponderEvent, started: boolean) => {
    const { changedTouches, touches } = event.nativeEvent;
    swipeRowActivation.trackTouches(
      started ? changedTouches.map((touch) => String(touch.identifier)) : [],
      touches.map((touch) => String(touch.identifier)),
    );
  };
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScroll: handleListScroll,
    onScrollBeginDrag: handleScrollBeginDrag,
  });

  const projectScopes = buildHomeProjectScopes({
    projects: props.projects,
    environmentId: props.selectedEnvironmentId,
    projectGroupingMode: props.projectGroupingMode,
  });
  const hasSearchQuery = props.searchQuery.trim().length > 0;
  const projectByKey = (() => {
    const map = new Map<string, EnvironmentProject>();
    for (const project of props.projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project);
    }
    return map;
  })();

  const v2ProjectScopeKey = props.selectedProjectKey;
  const v2ScopedProjectGroup = findHomeProjectScope(projectScopes, v2ProjectScopeKey);
  const threadSearch = useThreadSearch(
    searchEnvironmentIds,
    props.searchQuery,
    v2ScopedProjectGroup === null
      ? {}
      : { projectIds: v2ScopedProjectGroup.projectRefs.map((ref) => ref.projectId) },
  );
  const threadSearchMatchByKey = useThreadListSearchMatches(props.threads, threadSearch);
  const v2ProjectTitleByProjectKey = new Map(
    projectScopes.flatMap((scope) =>
      scope.projectRefs.map(
        (projectRef) =>
          [scopedProjectKey(projectRef.environmentId, projectRef.projectId), scope.title] as const,
      ),
    ),
  );
  const handleSettleThread = props.onSettleThread;
  const handleSnoozeThread = props.onSnoozeThread;
  const handleUnsnoozeThread = props.onUnsnoozeThread;
  const handlePinThread = props.onPinThread;
  // In project sections, Move up/down steps through the project's rows (groups
  // included) in the device-local row order; see `moveRowRef` below.
  const moveRowRef = useRef<
    ((thread: EnvironmentThreadShell, direction: "up" | "down") => boolean) | null
  >(null);
  const handleMoveThread = (thread: EnvironmentThreadShell, direction: ThreadMoveDestination) => {
    if (typeof direction === "string" && moveRowRef.current?.(thread, direction)) {
      return Promise.resolve(true);
    }
    return props.onMoveThread(thread, direction);
  };
  const handleUnpinThread = props.onUnpinThread;
  const handleSetThreadAutoSettle = props.onSetThreadAutoSettle;
  const handleRegenerateThreadTitle = props.onRegenerateThreadTitle;
  const handleRenameThread = props.onRenameThread;
  const handleDeleteThread = props.onDeleteThread;
  const handleUnsettleThread = props.onUnsettleThread;
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  );
  const settledResetKey = `${props.selectedEnvironmentId ?? "all"}:${v2ProjectScopeKey ?? "all"}:${props.searchQuery.trim()}`;
  const [lastSettledResetKey, setLastSettledResetKey] = useState(settledResetKey);
  if (lastSettledResetKey !== settledResetKey) {
    setLastSettledResetKey(settledResetKey);
    setSettledVisibleCount(THREAD_LIST_V2_SETTLED_INITIAL_COUNT);
  }
  const showMoreSettled = () =>
    setSettledVisibleCount((count) => count + THREAD_LIST_V2_SETTLED_PAGE_COUNT);
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
  // Keep time in state; the compiler would cache a render-time new Date().
  const [now, setNow] = useState(() => new Date().toISOString());
  const nowMinute = now.slice(0, 16);
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  useFocusEffect(() => {
    setNow(new Date().toISOString());
    const id = setInterval(() => setNow(new Date().toISOString()), 60_000);
    return () => clearInterval(id);
  });
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
  const {
    layout: threadListV2Layout,
    items: threadListV2Items,
    contentOnlyThreadKeys,
    olderSettledShelf,
  } = useThreadListV2({
    threads: props.threads,
    pendingTasks: props.pendingTasks,
    environmentId: props.selectedEnvironmentId,
    projectRefs: v2ScopedProjectGroup === null ? null : v2ScopedProjectGroup.projectRefs,
    searchQuery: props.searchQuery,
    searchMatches: threadSearchMatchByKey,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    pinReorderEnvironmentIds,
    activeReorderEnvironmentIds,
    queuedThreadKeys,
    settledLimit: settledVisibleCount,
    now,
    pendingOrder,
    shelfPreferencesLoaded,
    workingShelfEnabled,
    workingShelfExpanded,
    snoozedShelfExpanded,
    settledShelfExpanded,
    selectedThreadKey,
  });
  const nextSnoozeWakeAt = threadListV2Layout.nextSnoozeWakeAt;
  useEffect(() => {
    if (nextSnoozeWakeAt === null) return;
    const wakeAtMs = Date.parse(nextSnoozeWakeAt);
    if (Number.isNaN(wakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => {
      setNow(new Date().toISOString());
      bumpSnoozeWakeTick((tick) => tick + 1);
    }, delayMs);
    return () => clearTimeout(id);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- snoozeWakeTick re-arms clamped timers even when the wake date exceeds 32-bit setTimeout and stays unchanged.
  }, [nextSnoozeWakeAt, snoozeWakeTick]);
  const threadGroups = useAtomValue(environmentThreadGroups.threadGroupsAtom);
  const groupByThreadKey = new Map<
    string,
    { readonly key: string; readonly title: string; readonly index: number }
  >();
  for (const group of threadGroups) {
    if (!group.visible) continue;
    const key = `${group.environmentId}:${group.id}`;
    for (const [index, threadId] of group.threadIds.entries()) {
      groupByThreadKey.set(scopedThreadKey(group.environmentId, threadId), {
        key,
        title: group.title,
        index,
      });
    }
  }
  const projectScopeByKey = new Map(projectScopes.map((scope) => [scope.key, scope]));
  const projectScopeByProjectKey = new Map(
    projectScopes.flatMap((scope) =>
      scope.projectRefs.map(
        (projectRef) =>
          [
            scopedProjectKey(projectRef.environmentId, projectRef.projectId),
            { key: scope.key, title: scope.title },
          ] as const,
      ),
    ),
  );
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = (groupKey: string) =>
    setExpandedGroupKeys((current) => {
      const next = new Set(current);
      if (!next.delete(groupKey)) next.add(groupKey);
      return next;
    });
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
  const collapsedProjectKeys = new Set(
    AsyncResult.isSuccess(preferencesResult)
      ? (preferencesResult.value.threadListCollapsedProjects ?? [])
      : [],
  );
  // Builds from the stored list, not this render's: the list keeps unchanged
  // headers (and their callbacks) from earlier renders.
  const toggleProject = (projectKey: string) =>
    savePreferences({
      transform: (current) => {
        const next = new Set(current.threadListCollapsedProjects ?? []);
        if (!next.delete(projectKey)) next.add(projectKey);
        return { threadListCollapsedProjects: [...next] };
      },
    });

  // Called as `props.onSelectThread(...)`, the compiler would cache this handler on the whole
  // props object, which is new on every render of Home's parent.
  const { onSelectThread } = props;
  // A row listed for a message match opens the thread at that message, by
  // tap or by shortcut.
  const selectThread = (thread: EnvironmentThreadShell) => {
    const key = threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id });
    const messageId = contentOnlyThreadKeys.has(key)
      ? threadSearchMatchByKey.get(key)?.messageId
      : undefined;
    if (messageId) {
      requestThreadMessageJump(scopedThreadKey(thread.environmentId, thread.id), messageId);
    }
    onSelectThread(thread);
  };

  // Edit mode: drag handles on projects, groups, chats and threads, each moving
  // among its siblings. Dragging a project folds every project until release.
  const [editRequested, setArrangeMode] = useState(false);
  // Edit mode only exists while the list is grouped by project.
  const arrangeMode = editRequested && sectionedByProject;
  const [projectDrag, setProjectDrag] = useState<{
    readonly key: string;
    readonly order: ReadonlyArray<string>;
    readonly from: number;
    readonly startTop: number;
    readonly liftedTop: number | null;
    readonly translation: number;
  } | null>(null);
  const [projectHeaderHeight, setProjectHeaderHeight] = useState(40);
  const projectDragLayout = (() => {
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
  })();
  // Row heights vary, so a dragged row's slot comes from measured heights.
  const [rowHeights] = useState(() => new Map<string, number>());
  const [rowDrag, setRowDrag] = useState<{
    readonly key: string;
    readonly siblings: string;
    readonly keys: ReadonlyArray<string>;
    readonly translation: number;
  } | null>(null);
  const rowDragLayout = (() => {
    if (rowDrag === null) return null;
    const height = (key: string) => rowHeights.get(key) ?? 72;
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
  })();
  const projectOrderInput = projectDragLayout?.order ?? projectOrder;
  const homeSections = sectionedByProject
    ? buildHomeProjectSections({
        items: threadListV2Items,
        showProjectHeaders: v2ScopedProjectGroup === null,
        projectOf: (thread) =>
          projectScopeByProjectKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ??
          null,
        groupOf: (thread) =>
          groupByThreadKey.get(scopedThreadKey(thread.environmentId, thread.id)) ?? null,
        // Groups fold while a project's rows are dragged so its rows sit together;
        // otherwise the group holding the open chat (iPad split view) stays open.
        expandedGroupKeys: rowDrag?.siblings.startsWith("rows:")
          ? new Set<string>()
          : openGroupKey === undefined
            ? expandedGroupKeys
            : new Set([...expandedGroupKeys, openGroupKey]),
        collapsedProjectKeys: projectDrag ? new Set(projectDrag.order) : collapsedProjectKeys,
        ...(projectOrderInput ? { projectOrder: projectOrderInput } : {}),
        ...(rowOrder ? { rowOrder } : {}),
        ...(rowDrag && rowDragLayout
          ? { liveOrder: { siblings: rowDrag.siblings, order: rowDragLayout.order } }
          : {}),
      })
    : null;
  // Edit and drag state ride on the items: the list only redraws rows whose item changed.
  const homeListItems: ReadonlyArray<ListItem> = (() => {
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
  })();
  const threadByItemKey = new Map<string, EnvironmentThreadShell>();
  for (const item of homeListItems) {
    if (item.type === "v2-thread") threadByItemKey.set(item.key, item.item.thread);
  }

  // Gesture callbacks fire outside render, so they read the latest state from
  // here; the effect keeps these out of render for the compiler.
  const latest = useRef({
    projectDrag,
    projectDragLayout,
    projectOrder,
    projectKeys: [] as ReadonlyArray<string>,
    rowDrag,
    rowDragLayout,
    rowOrder,
    threadByItemKey,
    homeSections,
  });
  useEffect(() => {
    latest.current = {
      projectDrag,
      projectDragLayout,
      projectOrder,
      // The project order a drag starts from is frozen until it ends.
      projectKeys: projectDrag
        ? latest.current.projectKeys
        : (homeSections?.projects.map((project) => project.key) ?? []),
      rowDrag,
      rowDragLayout,
      rowOrder,
      threadByItemKey,
      homeSections,
    };
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
  });
  const projectDragHandlers = {
    onStart: (key: string, top: number) => {
      const order = latest.current.projectKeys;
      const from = order.indexOf(key);
      if (from < 0) return;
      setProjectDrag({ key, order, from, startTop: top, liftedTop: null, translation: 0 });
    },
    onLifted: (top: number) =>
      setProjectDrag((current) => (current === null ? null : { ...current, liftedTop: top })),
    onMove: (translation: number) =>
      setProjectDrag((current) => (current === null ? null : { ...current, translation })),
    onEnd: (cancelled: boolean) => {
      const { projectDrag: current, projectDragLayout: layout } = latest.current;
      setProjectDrag(null);
      if (
        current === null ||
        cancelled ||
        layout === null ||
        !layout.order.some((key, index) => key !== current.order[index])
      ) {
        return;
      }
      savePreferences({
        threadListProjectOrder: mergeArrangedKeys(
          latest.current.projectOrder ?? [],
          current.order,
          layout.order,
        ),
      });
    },
  };

  const reorderGroupMember = useAtomCommand(threadEnvironment.reorderGroup, {
    reportFailure: false,
  });
  const reorderChats = async (
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
  };
  const arrangeHandlers = {
    onHeight: (key: string, height: number) => rowHeights.set(key, height),
    onStart: (key: string) => {
      const siblings = latest.current.homeSections?.siblings.get(key);
      if (siblings === undefined) return;
      setRowDrag({ key, siblings: siblings.id, keys: siblings.keys, translation: 0 });
    },
    onMove: (translation: number) =>
      setRowDrag((current) => (current === null ? null : { ...current, translation })),
    onEnd: (cancelled: boolean) => {
      const { rowDrag: current, rowDragLayout: layout, threadByItemKey: threads } = latest.current;
      setRowDrag(null);
      if (current === null || cancelled || layout === null) return;
      const { order, target } = layout;
      if (!order.some((key, index) => key !== current.keys[index])) return;
      if (current.siblings.startsWith("rows:")) {
        savePreferences({
          threadListRowOrder: mergeArrangedKeys(latest.current.rowOrder ?? [], current.keys, order),
        });
        return;
      }
      const members = order.flatMap((key) => {
        const thread = threads.get(key);
        return thread ? [thread] : [];
      });
      const moved = threads.get(current.key);
      if (moved === undefined || members.length !== order.length) return;
      if (current.siblings.startsWith("chats:")) {
        void reorderChats(
          members,
          members.map((thread) => scopedThreadKey(thread.environmentId, thread.id)),
          scopedThreadKey(moved.environmentId, moved.id),
        );
        return;
      }
      // Pinned: place it next to its new neighbour in the server's pin order.
      const neighbor = target < members.length - 1 ? members[target + 1] : members[target - 1];
      if (neighbor !== undefined) {
        void props.onMoveThread(moved, {
          targetId: scopedThreadKey(neighbor.environmentId, neighbor.id),
          placement: target < members.length - 1 ? "before" : "after",
        });
      }
    },
  };
  const enterArrangeMode = () => setArrangeMode(true);
  const exitArrangeMode = () => {
    setRowDrag(null);
    setProjectDrag(null);
    setArrangeMode(false);
  };
  // The thread menu's Arrange threads opens Edit mode while the list is grouped.
  // oxlint-disable-next-line t3code/react-effect-budget -- publishes Home's mount state to an app-wide atom and clears it on unmount.
  useEffect(() => {
    appAtomRegistry.set(homeArrangesInPlaceAtom, sectionedByProject);
    return () => appAtomRegistry.set(homeArrangesInPlaceAtom, false);
  }, [sectionedByProject]);
  const arrangeRequested = useAtomValue(threadArrangementOpenAtom) && sectionedByProject;
  if (arrangeRequested && !editRequested) setArrangeMode(true);
  // oxlint-disable-next-line t3code/react-effect-budget -- consumes a one-shot request from another screen's menu after render picks it up.
  useEffect(() => {
    if (arrangeRequested) appAtomRegistry.set(threadArrangementOpenAtom, false);
  }, [arrangeRequested]);
  // Android back leaves Edit mode, like Done.
  // oxlint-disable-next-line t3code/react-effect-budget -- subscribes to the hardware back button only while editing.
  useEffect(() => {
    if (!arrangeMode || Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setRowDrag(null);
      setProjectDrag(null);
      setArrangeMode(false);
      return true;
    });
    return () => subscription.remove();
  }, [arrangeMode]);

  // Chips list projects with unsettled work, plus the selected one so it can be cleared.
  const liveProjectKeys = new Set<string>();
  // A chip dot says a project has a thread waiting on the user, or else one working.
  const projectIndicators = new Map<string, ProjectChipIndicator>();
  for (const thread of props.threads) {
    if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent") continue;
    const scopeKey = projectScopeByProjectKey.get(
      scopedProjectKey(thread.environmentId, thread.projectId),
    )?.key;
    if (scopeKey === undefined) continue;
    if (thread.settledOverride !== "settled") liveProjectKeys.add(scopeKey);
    if (projectIndicators.get(scopeKey) === "attention") continue;
    const status = resolveThreadListV2Status(thread);
    if (status === "approval" || status === "input") projectIndicators.set(scopeKey, "attention");
    else if (status === "working") projectIndicators.set(scopeKey, "working");
  }
  const chipProjects = projectScopes
    .filter((scope) => liveProjectKeys.has(scope.key) || scope.key === props.selectedProjectKey)
    .map((scope) => ({ key: scope.key, label: scope.title }));

  const shortcutItems = homeListItems.filter(isThreadListV2ListItem);
  useThreadJumpShortcuts(shortcutItems, selectThread);
  // oxlint-disable-next-line t3code/react-effect-budget -- swipe rows activate after the list commits, as upstream does for its flat list.
  useEffect(() => {
    if (swipeEnabled) activateVisibleRows(homeListItems);
  }, [activateVisibleRows, swipeEnabled, homeListItems]);

  const withArrangeHandle = (
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
    );

  const renderV2Item = ({ item }: { readonly item: ListItem }) => {
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
          groupKey={item.groupKey}
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
          pane={primaryColumn ? "sidebar" : "screen"}
          pendingTask={item.pendingTask}
          selected={
            activeNewTask?.pendingKey === item.pendingTask.key ||
            (item.pendingTask.kind === "pending" &&
              scopedThreadKey(item.pendingTask.environmentId, item.pendingTask.message.threadId) ===
                selectedThreadKey)
          }
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
          fullSwipeWidth={fullSwipeWidth}
          onSwipeableClose={handleSwipeableClose}
          onSwipeableWillOpen={handleSwipeableWillOpen}
          simultaneousSwipeGesture={homeScrollGesture}
          activationKey={item.key}
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
        wokeAt={item.item.wokeAt}
        snoozePresetMinute={item.snoozePresetMinute ?? ""}
        snoozeWakeLabelText={item.snoozeWakeLabelText}
        timeLabel={item.timeLabel}
        showTrailingDivider={item.showTrailingDivider}
        project={projectByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ?? null}
        hideProject={"underProject" in item}
        providerInstance={resolveProviderInstance(thread)}
        providers={providersByEnvironmentId.get(thread.environmentId)}
        environmentLabel={
          Object.keys(props.savedConnectionsById).length > 1
            ? (props.savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
            : null
        }
        environmentMachine={machineByEnvironmentId.get(thread.environmentId)}
        searchMatch={
          // Only rows listed for their messages show one and open at it.
          contentOnlyThreadKeys.has(
            threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
          )
            ? threadSearchMatchByKey.get(
                threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
              )
            : undefined
        }
        searchQuery={threadSearch.query}
        onSelectThread={selectThread}
        onOpenThreadPullRequests={handleOpenThreadPullRequests}
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
    const handled = withArrangeHandle(item.arrange, item.key, thread.title, row);
    // Chats of an expanded group sit under its row, one step in.
    return "groupMember" in item ? <View className="pl-4">{handled}</View> : handled;
  };
  const v2KeyExtractor = (item: ListItem) => item.key;
  const homeItemsAreEqual = (previous: ListItem, item: ListItem) => {
    const before = previous.arrange ?? NO_ARRANGE;
    const after = item.arrange ?? NO_ARRANGE;
    return (
      before.handle === after.handle &&
      before.liftOffset === after.liftOffset &&
      homeListItemsAreEqual(previous, item, threadListV2ListItemsAreEqual)
    );
  };

  // extraData changes invalidate every visible row; put the minute clock on items to limit updates.
  const v2ExtraData = {
    activeNewTask,
    projectByKey,
    projectTitleByProjectKey: v2ProjectTitleByProjectKey,
    listEnvironments,
    savedConnectionsById: props.savedConnectionsById,
    searchQuery: props.searchQuery,
    selectedThreadKey,
    threadSearchMatchByKey,
    workingShelfEnabled,
  };

  const hasAnyThreads =
    props.threads.some((thread) => thread.archivedAt === null) ||
    props.pendingTasks.length > 0 ||
    threadListV2Layout.settledCount > 0;
  const selectedEnvironmentLabel =
    props.selectedEnvironmentId === null
      ? null
      : (props.savedConnectionsById[props.selectedEnvironmentId]?.environmentLabel ??
        "this environment");
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
                  <FloatingActionButton
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
          gutter={primaryColumn ? 8 : 0}
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
        <SwipeableScrollGateProvider enabled={swipeEnabled} activation={swipeRowActivation}>
          <GestureDetector gesture={homeScrollGesture}>
            <AnimatedLegendList
              itemLayoutAnimation={primaryColumn ? THREAD_SIDEBAR_ROW_LAYOUT : undefined}
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
                    {...(olderSettledShelf.loading
                      ? { state: "loading" as const }
                      : olderSettledShelf.failed
                        ? { state: "failed" as const }
                        : {})}
                    onPress={() => {
                      olderSettledShelf.retry();
                      showMoreSettled();
                    }}
                  />
                ) : null
              }
              ListEmptyComponent={v2ListEmpty}
              style={{ flex: 1 }}
              automaticallyAdjustsScrollIndicatorInsets={Platform.OS === "ios"}
              // UIKit owns the bar's inset, so a minimizing bar and a resized column move
              // the list in the same frame as the bar.
              contentInsetAdjustmentBehavior="automatic"
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
                paddingLeft:
                  (contentSideInsets?.left ?? 0) + (primaryColumn ? 8 : 0) + androidListGutter,
                paddingRight:
                  (contentSideInsets?.right ?? 0) + (primaryColumn ? 8 : 0) + androidListGutter,
                paddingBottom:
                  Platform.OS === "ios"
                    ? iosBottomClearance - (columnMetrics?.safeArea.bottom ?? insets.bottom)
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
