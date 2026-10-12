import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import * as DateTime from "effect/DateTime";
import { deriveActiveWorkStartedAt } from "../session-logic.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { defaultAnimateLayoutChanges, type AnimateLayoutChanges } from "@dnd-kit/sortable";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  animateSidebarLayoutChanges,
  archiveSelectedThreadEntries,
  buildSidebarActiveTree,
  partitionThreadsByGroup,
  resolveForcedOpenGroupKey,
  resolveSidebarGroupExpanded,
  groupSettleStampMs,
  resolveSidebarGroupSection,
  resolveThreadGroupStatus,
  sidebarActivityMs,
  type SidebarTreeEntry,
  buildBulkTitleRegenerationContextMenuItem,
  buildBulkUnpinContextMenuItem,
  buildMultiSelectThreadContextMenuItems,
  createThreadJumpHintVisibilityController,
  deleteSelectedThreadEntries,
  filterSidebarProjectScopeItems,
  filterSidebarV2VisibleThreads,
  formatWorkingDurationLabel,
  getFallbackThreadIdAfterDelete,
  getProjectSortTimestamp,
  getSidebarForkParentThreadId,
  getSidebarThreadIdsToPrewarm,
  hasUnseenCompletion,
  isContextMenuPointerDown,
  isSidebarSubagentThread,
  isSidebarThreadWorking,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  pinOrderKeyBetween,
  reduceSidebarProjectScopeMenuState,
  resolveAdjacentThreadId,
  resolveProjectStatusIndicator,
  resolveSidebarSweepKeys,
  resolveSidebarStageBadgeLabel,
  resolveSidebarThreadSection,
  resolveSidebarRowAccessibility,
  resolveSidebarThreadStatus,
  resolveSidebarV2TopStatus,
  resolveThreadLastVisitedAt,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  resolveWorkingStartedAt,
  searchSidebarThreads,
  shouldClearThreadSelectionOnMouseDown,
  shouldShowSidebarV2Duration,
  shouldRecedeSidebarThread,
  sortLogicalProjectsForSidebar,
  sortInboxThreadsByReturn,
  resolveSidebarDropTarget,
  resolveSidebarGroupDropTarget,
  resolveSidebarGroupReorder,
  planGroupMemberReorder,
  planSidebarThreadDrop,
  sortPinnedThreadsForSidebar,
  sortProjectsForSidebar,
  sortScopedProjectsForSidebar,
  sortSidebarV2ProjectGroups,
  shouldCreateNewThreadInCurrentProject,
  shouldNavigateAfterThreadPark,
  THREAD_JUMP_HINT_SHOW_DELAY_MS,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
  resolveSidebarDropVerb,
  resolveSidebarEnvironmentScope,
} from "./Sidebar.logic";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { sortSettledThreads } from "@t3tools/client-runtime/state/thread-sort";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadGroupId,
  ThreadId,
} from "@t3tools/contracts";
import {
  presentThreadGroup,
  type EnvironmentThreadGroup,
} from "@t3tools/client-runtime/state/models";
import { threadGroupKey } from "@t3tools/client-runtime/state/entities";

import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Project,
  type Thread,
} from "../types";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../test-fixtures";

const localEnvironmentId = EnvironmentId.make("environment-local");

describe("resolveSidebarRowAccessibility", () => {
  it.each([
    {
      title: "Can you audit the UI?",
      statusLabel: "Working",
      projectDisplayName: "T3 Code",
      isActive: true,
      expected: { label: "Can you audit the UI?, Working, T3 Code", current: "page" },
    },
    {
      title: "The audit is done",
      statusLabel: null,
      projectDisplayName: "T3 Code",
      isActive: false,
      expected: { label: "The audit is done, T3 Code", current: undefined },
    },
    {
      title: "Untitled task",
      statusLabel: null,
      projectDisplayName: null,
      isActive: false,
      expected: { label: "Untitled task", current: undefined },
    },
  ])("leads with the title without folding row actions into its name: %j", (input) => {
    const { expected, ...state } = input;
    expect(resolveSidebarRowAccessibility(state)).toEqual(expected);
  });
});

describe("animateSidebarLayoutChanges", () => {
  const baseArgs: Parameters<AnimateLayoutChanges>[0] = {
    active: null,
    containerId: "pinned-threads",
    isDragging: false,
    isSorting: false,
    id: "thread-a",
    index: 1,
    items: ["thread-b", "thread-a"],
    newIndex: 0,
    previousItems: ["thread-a", "thread-b"],
    previousContainerId: "pinned-threads",
    transition: { duration: 200, easing: "ease" },
    wasDragging: true,
  };

  it("does not replay layout movement after the pointer is released", () => {
    expect(defaultAnimateLayoutChanges(baseArgs)).toBe(true);
    expect(animateSidebarLayoutChanges(baseArgs)).toBe(false);
  });

  it("keeps layout movement while the user is sorting", () => {
    expect(animateSidebarLayoutChanges({ ...baseArgs, isSorting: true })).toBe(true);
  });
});

describe("resolveSidebarThreadSection", () => {
  it("keeps a pinned thread in the pinned shelf", () => {
    expect(resolveSidebarThreadSection({ snoozed: false, settled: false, pinned: true })).toBe(
      "pinned",
    );
  });

  it("keeps lifecycle shelves authoritative over a stale pin", () => {
    expect(resolveSidebarThreadSection({ snoozed: true, settled: true, pinned: true })).toBe(
      "snoozed",
    );
    expect(resolveSidebarThreadSection({ snoozed: false, settled: true, pinned: true })).toBe(
      "settled",
    );
  });
});

describe("deleteSelectedThreadEntries", () => {
  const entries = [{ threadKey: "one" }, { threadKey: "two" }, { threadKey: "three" }] as const;
  const success = AsyncResult.success(undefined);
  const failure = AsyncResult.failure(Cause.fail(new Error("Delete failed")));
  const interrupted = AsyncResult.failure(Cause.interrupt());

  it("waits for each delete and excludes only earlier successes from worktree checks", async () => {
    let resolveDelete!: (result: typeof success) => void;
    const pendingDelete = new Promise<typeof success>((resolve) => {
      resolveDelete = resolve;
    });
    const worktreeChecks: { threadKey: string; deletedThreadKeys: string[] }[] = [];
    const deletion = deleteSelectedThreadEntries({
      entries,
      delete: async ({ threadKey }, deletedThreadKeys) => {
        worktreeChecks.push({ threadKey, deletedThreadKeys: [...deletedThreadKeys] });
        return threadKey === "one" ? pendingDelete : success;
      },
    });

    expect(worktreeChecks).toEqual([{ threadKey: "one", deletedThreadKeys: [] }]);
    resolveDelete(success);
    const outcome = await deletion;

    expect(worktreeChecks).toEqual([
      { threadKey: "one", deletedThreadKeys: [] },
      { threadKey: "two", deletedThreadKeys: ["one"] },
      { threadKey: "three", deletedThreadKeys: ["one", "two"] },
    ]);
    expect(outcome).toEqual({
      deletedThreadKeys: new Set(["one", "two", "three"]),
      firstFailure: null,
    });
  });

  it("continues after ordinary failures and keeps the first failure", async () => {
    const laterFailure = AsyncResult.failure(Cause.fail(new Error("Later failure")));
    const deletedKeysAtLastEntry: string[][] = [];
    const outcome = await deleteSelectedThreadEntries({
      entries: [...entries, { threadKey: "four" }],
      delete: async ({ threadKey }, deletedThreadKeys) => {
        if (threadKey === "one") return failure;
        if (threadKey === "three") return laterFailure;
        if (threadKey === "four") deletedKeysAtLastEntry.push([...deletedThreadKeys]);
        return success;
      },
    });

    expect(deletedKeysAtLastEntry).toEqual([["two"]]);
    expect(outcome).toEqual({
      deletedThreadKeys: new Set(["two", "four"]),
      firstFailure: failure,
    });
  });

  it.each([
    { firstResult: success, deletedThreadKeys: new Set(["one"]), firstFailure: null },
    { firstResult: failure, deletedThreadKeys: new Set<string>(), firstFailure: failure },
  ])("stops on interruption and preserves earlier results %#", async (testCase) => {
    const attemptedThreadKeys: string[] = [];
    const outcome = await deleteSelectedThreadEntries({
      entries,
      delete: async ({ threadKey }) => {
        attemptedThreadKeys.push(threadKey);
        return threadKey === "one" ? testCase.firstResult : interrupted;
      },
    });

    expect(attemptedThreadKeys).toEqual(["one", "two"]);
    expect(outcome).toEqual({
      deletedThreadKeys: testCase.deletedThreadKeys,
      firstFailure: testCase.firstFailure,
    });
  });

  it("does not count a skipped entry as deleted", async () => {
    const visibleEntries = new Set(entries.map(({ threadKey }) => threadKey));
    const worktreeChecks: string[][] = [];
    const outcome = await deleteSelectedThreadEntries({
      entries,
      delete: async ({ threadKey }, deletedThreadKeys) => {
        if (!visibleEntries.has(threadKey)) return null;
        worktreeChecks.push([...deletedThreadKeys]);
        visibleEntries.delete("two");
        return success;
      },
    });

    expect(worktreeChecks).toEqual([[], ["one"]]);
    expect(outcome).toEqual({
      deletedThreadKeys: new Set(["one", "three"]),
      firstFailure: null,
    });
  });
});

describe("archiveSelectedThreadEntries", () => {
  const entries = [{ threadKey: "one" }, { threadKey: "two" }, { threadKey: "three" }] as const;
  const success = { _tag: "Success" } as const;
  const failure = { _tag: "Failure" } as const;

  it("records every entry after full success", async () => {
    const outcome = await archiveSelectedThreadEntries({
      entries,
      archive: async (_entry, onArchived) => {
        onArchived();
        return success;
      },
    });

    expect(outcome).toEqual({
      archivedThreadKeys: ["one", "two", "three"],
      mutationFailure: null,
      followupFailures: [],
    });
  });

  it("stops at a mutation failure and retains prior successes", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      if (entry.threadKey === "two") return failure;
      onArchived();
      return success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one"],
      mutationFailure: failure,
      followupFailures: [],
    });
  });

  it("continues after a post-archive failure", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      onArchived();
      return entry.threadKey === "two" ? failure : success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(3);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one", "two", "three"],
      mutationFailure: null,
      followupFailures: [failure],
    });
  });
});

describe("buildBulkUnpinContextMenuItem", () => {
  it("counts only the pinned rows of a mixed selection", () => {
    expect(buildBulkUnpinContextMenuItem({ pinnedCount: 2 })).toEqual({
      id: "unpin",
      label: "Unpin (2)",
    });
  });

  it("omits the action when nothing selected is pinned", () => {
    expect(buildBulkUnpinContextMenuItem({ pinnedCount: 0 })).toBeNull();
  });
});

describe("buildBulkTitleRegenerationContextMenuItem", () => {
  it("counts only threads that can start a new regeneration", () => {
    expect(
      buildBulkTitleRegenerationContextMenuItem({
        supportedCount: 4,
        actionableCount: 3,
      }),
    ).toEqual({
      id: "regenerate-title",
      label: "Regenerate titles (3)",
    });
  });

  it("shows a disabled progress item when every supported thread is pending", () => {
    expect(
      buildBulkTitleRegenerationContextMenuItem({
        supportedCount: 2,
        actionableCount: 0,
      }),
    ).toEqual({
      id: "regenerate-title",
      label: "Regenerating… (2)",
      disabled: true,
    });
  });

  it("omits the action when no selected environment supports it", () => {
    expect(
      buildBulkTitleRegenerationContextMenuItem({
        supportedCount: 0,
        actionableCount: 0,
      }),
    ).toBeNull();
  });
});

describe("buildMultiSelectThreadContextMenuItems", () => {
  it("offers bulk archive with the selected count", () => {
    expect(
      buildMultiSelectThreadContextMenuItems({ count: 3, hasRunningThread: false }),
    ).toContainEqual({ id: "archive", label: "Archive (3)", disabled: false });
  });

  it("disables bulk archive when a selected thread is running", () => {
    expect(
      buildMultiSelectThreadContextMenuItems({ count: 2, hasRunningThread: true }),
    ).toContainEqual({ id: "archive", label: "Archive (2)", disabled: true });
  });
});

describe("resolveSidebarStageBadgeLabel", () => {
  it("returns Nightly for nightly primary server versions", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: "0.0.28-nightly.20260616.12",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Nightly");
  });

  it("returns the fallback label for stable primary server versions", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: "0.0.27",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Alpha");
  });

  it("returns the fallback label when the primary server version is missing", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: null,
        fallbackStageLabel: "Dev",
      }),
    ).toBe("Dev");
  });

  it("returns the fallback label for malformed nightly prerelease versions", () => {
    expect(
      resolveSidebarStageBadgeLabel({
        primaryServerVersion: "0.0.28-nightly.20260616",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Alpha");
  });
});

describe("sidebar thread lineage helpers", () => {
  it("keeps only top-level, unarchived threads in the Sidebar V2 project scope", () => {
    const parentId = ThreadId.make("thread-parent");
    const projectId = ProjectId.make("project-visible");
    const environmentId = EnvironmentId.make("environment-visible");
    const root = makeThreadFixture({
      id: parentId,
      environmentId,
      projectId,
    });
    const subagent = makeThreadFixture({
      id: ThreadId.make("thread-subagent"),
      environmentId,
      projectId,
      lineage: {
        rootThreadId: parentId,
        parentThreadId: parentId,
        relationshipToParent: "subagent",
      },
    });
    const fork = makeThreadFixture({
      id: ThreadId.make("thread-fork"),
      environmentId,
      projectId,
      lineage: {
        rootThreadId: parentId,
        parentThreadId: parentId,
        relationshipToParent: "fork",
      },
    });
    const archived = makeThreadFixture({
      id: ThreadId.make("thread-archived"),
      environmentId,
      projectId,
      archivedAt: "2026-01-02T00:00:00.000Z",
    });
    const otherProject = makeThreadFixture({
      id: ThreadId.make("thread-other-project"),
      environmentId,
      projectId: ProjectId.make("project-other"),
    });

    expect(
      filterSidebarV2VisibleThreads(
        [root, subagent, fork, archived, otherProject],
        new Set([`${environmentId}:${projectId}`]),
      ).map((thread) => thread.id),
    ).toEqual([parentId, fork.id]);
  });

  it("identifies subagent threads so the sidebar can hide them", () => {
    const parentId = ThreadId.make("thread-parent");
    const subagent = makeThreadFixture({
      lineage: {
        rootThreadId: parentId,
        parentThreadId: parentId,
        relationshipToParent: "subagent",
      },
    });

    expect(isSidebarSubagentThread(subagent)).toBe(true);
    expect(isSidebarSubagentThread(makeThreadFixture())).toBe(false);
  });

  it("resolves the parent thread for fork sidebar affordances", () => {
    const parentId = ThreadId.make("thread-parent");
    const fallbackParentId = ThreadId.make("thread-fallback-parent");
    const runFork = makeThreadFixture({
      forkedFrom: { type: "run", threadId: parentId, runId: "run-1" as never },
      lineage: {
        rootThreadId: parentId,
        parentThreadId: fallbackParentId,
        relationshipToParent: "fork",
      },
    });
    const lineageFork = makeThreadFixture({
      lineage: {
        rootThreadId: parentId,
        parentThreadId: fallbackParentId,
        relationshipToParent: "fork",
      },
    });

    expect(getSidebarForkParentThreadId(runFork)).toBe(parentId);
    expect(getSidebarForkParentThreadId(lineageFork)).toBe(fallbackParentId);
    expect(getSidebarForkParentThreadId(makeThreadFixture())).toBeNull();
  });
});

function makeLatestRun(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): NonNullable<Thread["latestRun"]> {
  return {
    runId: "turn-1" as never,
    status: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt:
      overrides?.startedAt !== undefined ? overrides.startedAt : "2026-03-09T10:00:00.000Z",
    completedAt:
      overrides?.completedAt !== undefined ? overrides.completedAt : "2026-03-09T10:05:00.000Z",
  };
}

describe("hasUnseenCompletion", () => {
  it("returns true when a thread completed after its last visit", () => {
    expect(
      hasUnseenCompletion({
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestRun: makeLatestRun(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        runtime: null,
      }),
    ).toBe(true);
  });

  it("treats a missing client visit marker as read", () => {
    expect(
      hasUnseenCompletion({
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestRun: makeLatestRun(),
        lastVisitedAt: undefined,
        runtime: null,
      }),
    ).toBe(false);
  });
});

describe("shouldRecedeSidebarThread", () => {
  it.each(["working", "waiting"] as const)(
    "recedes an inactive %s thread even when it is unread and woke",
    (status) => {
      expect(
        shouldRecedeSidebarThread({
          status,
          isUnread: true,
          isWoke: true,
          isActive: false,
          isSelected: false,
        }),
      ).toBe(true);
    },
  );

  it.each(["ready", "approval", "input"] as const)(
    "keeps an unread %s thread prominent",
    (status) => {
      expect(
        shouldRecedeSidebarThread({
          status,
          isUnread: true,
          isWoke: false,
          isActive: false,
          isSelected: false,
        }),
      ).toBe(false);
    },
  );

  it("keeps active and selected working threads prominent", () => {
    const input = {
      status: "working" as const,
      isUnread: true,
      isWoke: true,
      isActive: false,
      isSelected: false,
    };

    expect(shouldRecedeSidebarThread({ ...input, isActive: true })).toBe(false);
    expect(shouldRecedeSidebarThread({ ...input, isSelected: true })).toBe(false);
  });

  it.each([false, true])("keeps input-required threads prominent with unread=%s", (isUnread) => {
    expect(
      shouldRecedeSidebarThread({
        status: "input",
        isUnread,
        isWoke: false,
        isActive: false,
        isSelected: false,
      }),
    ).toBe(false);
  });
});

describe("createThreadJumpHintVisibilityController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays showing jump hints until the configured delay elapses", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS - 1);

    expect(visibilityChanges).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(visibilityChanges).toEqual([true]);
  });

  it("hides immediately when the modifiers are released", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS);
    controller.sync(false);

    expect(visibilityChanges).toEqual([true, false]);
  });

  it("cancels a pending reveal when the modifier is released early", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(Math.floor(THREAD_JUMP_HINT_SHOW_DELAY_MS / 2));
    controller.sync(false);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS);

    expect(visibilityChanges).toEqual([]);
  });
});

describe("getSidebarThreadIdsToPrewarm", () => {
  it("returns only the first visible thread ids up to the prewarm limit", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2", "t3"], 2)).toEqual(["t1", "t2"]);
  });

  it("returns all visible thread ids when they fit within the limit", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2"], 10)).toEqual(["t1", "t2"]);
  });

  it("returns no thread ids when the limit is zero", () => {
    expect(getSidebarThreadIdsToPrewarm(["t1", "t2"], 0)).toEqual([]);
  });
});

describe("shouldClearThreadSelectionOnMouseDown", () => {
  it("preserves selection for thread items", () => {
    const child = {
      closest: (selector: string) =>
        selector.includes("[data-thread-item]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(child)).toBe(false);
  });

  it("preserves selection for thread list toggle controls", () => {
    const selectionSafe = {
      closest: (selector: string) =>
        selector.includes("[data-thread-selection-safe]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(selectionSafe)).toBe(false);
  });

  it("clears selection for unrelated sidebar clicks", () => {
    const unrelated = {
      closest: () => null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(unrelated)).toBe(true);
  });
});

describe("isTrailingDoubleClick", () => {
  it("treats a single click as a normal activation", () => {
    expect(isTrailingDoubleClick(1)).toBe(false);
  });

  it("treats synthetic/keyboard activations (detail 0) as a normal activation", () => {
    expect(isTrailingDoubleClick(0)).toBe(false);
  });

  it("ignores the second click of a double-click so it does not navigate", () => {
    expect(isTrailingDoubleClick(2)).toBe(true);
  });

  it("ignores further clicks of a triple-click", () => {
    expect(isTrailingDoubleClick(3)).toBe(true);
  });
});

describe("orderItemsByPreferredIds", () => {
  it("keeps preferred ids first, skips stale ids, and preserves the relative order of remaining items", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: ProjectId.make("project-1"), name: "One" },
        { id: ProjectId.make("project-2"), name: "Two" },
        { id: ProjectId.make("project-3"), name: "Three" },
      ],
      preferredIds: [
        ProjectId.make("project-3"),
        ProjectId.make("project-missing"),
        ProjectId.make("project-1"),
      ],
      getId: (project) => project.id,
    });

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.make("project-3"),
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it("does not duplicate items when preferred ids repeat", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: ProjectId.make("project-1"), name: "One" },
        { id: ProjectId.make("project-2"), name: "Two" },
      ],
      preferredIds: [
        ProjectId.make("project-2"),
        ProjectId.make("project-1"),
        ProjectId.make("project-2"),
      ],
      getId: (project) => project.id,
    });

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("honors projectOrder physical keys via getProjectOrderKey", async () => {
    // Regression guard for #1904 / the regression introduced by #2055:
    // `projectOrder` is populated with physical keys (envId + cwd-derived)
    // by the store and by drag-end handlers. Readers must identify projects
    // with the same key format, or manual sort silently snaps back.
    const { getProjectOrderKey } = await import("../logicalProject");
    const projects = [
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-alpha"),
        workspaceRoot: "/work/alpha",
      },
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-beta"),
        workspaceRoot: "/work/beta",
      },
      {
        environmentId: EnvironmentId.make("environment-local"),
        id: ProjectId.make("id-gamma"),
        workspaceRoot: "/work/gamma",
      },
    ];
    const ordered = orderItemsByPreferredIds({
      items: projects,
      preferredIds: [getProjectOrderKey(projects[2]!), getProjectOrderKey(projects[0]!)],
      getId: getProjectOrderKey,
    });

    expect(ordered.map((project) => project.workspaceRoot)).toEqual([
      "/work/gamma",
      "/work/alpha",
      "/work/beta",
    ]);
  });

  it("resolves legacy preference aliases without materializing project state", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: "physical-a", cwd: "/work/a" },
        { id: "physical-b", cwd: "/work/b" },
        { id: "physical-c", cwd: "/work/c" },
      ],
      preferredIds: ["legacy:/work/c", "legacy:/work/a"],
      getId: (project) => project.id,
      getPreferenceIds: (project) => [project.id, `legacy:${project.cwd}`],
    });

    expect(ordered.map((project) => project.id)).toEqual([
      "physical-c",
      "physical-a",
      "physical-b",
    ]);
  });
});

describe("resolveAdjacentThreadId", () => {
  it("resolves adjacent thread ids in ordered sidebar traversal", () => {
    const threads = [
      ThreadId.make("thread-1"),
      ThreadId.make("thread-2"),
      ThreadId.make("thread-3"),
    ];

    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[1] ?? null,
        direction: "previous",
      }),
    ).toBe(threads[0]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[1] ?? null,
        direction: "next",
      }),
    ).toBe(threads[2]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: null,
        direction: "next",
      }),
    ).toBe(threads[0]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: null,
        direction: "previous",
      }),
    ).toBe(threads[2]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[0] ?? null,
        direction: "previous",
      }),
    ).toBeNull();
  });
});

describe("isContextMenuPointerDown", () => {
  it("treats secondary-button presses as context menu gestures on all platforms", () => {
    expect(
      isContextMenuPointerDown({
        button: 2,
        ctrlKey: false,
        isMac: false,
      }),
    ).toBe(true);
  });

  it("treats ctrl+primary-click as a context menu gesture on macOS", () => {
    expect(
      isContextMenuPointerDown({
        button: 0,
        ctrlKey: true,
        isMac: true,
      }),
    ).toBe(true);
  });

  it("does not treat ctrl+primary-click as a context menu gesture off macOS", () => {
    expect(
      isContextMenuPointerDown({
        button: 0,
        ctrlKey: true,
        isMac: false,
      }),
    ).toBe(false);
  });
});

describe("resolveSidebarThreadStatus", () => {
  const runtime = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };

  const idle = { hasPendingApprovals: false, hasPendingUserInput: false, runtime: null };

  it("prioritizes approval over a running runtime", () => {
    expect(resolveSidebarThreadStatus({ ...idle, hasPendingApprovals: true, runtime })).toBe(
      "approval",
    );
  });

  it("prioritizes awaiting input over a running runtime, below approval", () => {
    expect(resolveSidebarThreadStatus({ ...idle, hasPendingUserInput: true, runtime })).toBe(
      "input",
    );
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
        runtime,
      }),
    ).toBe("approval");
  });

  it("reports working for running and starting runtimes", () => {
    expect(resolveSidebarThreadStatus({ ...idle, runtime })).toBe("working");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "starting" as const },
      }),
    ).toBe("working");
  });

  it("keeps usage-limit stops Limited and visible until the thread recovers", () => {
    const limited = {
      ...runtime,
      status: "failed" as const,
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit" as const,
    };
    expect(resolveSidebarThreadStatus({ ...idle, runtime: limited })).toBe("limited");
    expect(
      resolveSidebarThreadStatus({ ...idle, runtime: { ...limited, status: "running" } }),
    ).toBe("working");
    expect(
      resolveSidebarThreadStatus({ ...idle, runtime: { ...limited, status: "completed" } }),
    ).toBe("ready");
    expect(resolveSidebarV2TopStatus({ status: "limited", isUnread: false, isWoke: false })).toBe(
      "limited",
    );
    expect(
      shouldRecedeSidebarThread({
        status: "limited",
        isUnread: false,
        isWoke: false,
        isActive: false,
        isSelected: false,
      }),
    ).toBe(false);
  });

  it("reports failed only while the latest run failed", () => {
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "failed" as const, lastError: "boom" },
      }),
    ).toBe("failed");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "completed" as const, lastError: "persisted" },
      }),
    ).toBe("ready");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "idle" as const, lastError: "persisted" },
      }),
    ).toBe("waiting");
  });

  it("defaults to ready with no runtime", () => {
    expect(resolveSidebarThreadStatus(idle)).toBe("ready");
  });

  it("keeps a waiting runtime visible ahead of unread and woke presentation", () => {
    expect(resolveSidebarV2TopStatus({ status: "waiting", isUnread: true, isWoke: true })).toBe(
      "waiting",
    );
  });

  it("keeps Waiting static while Working shows elapsed duration", () => {
    expect(shouldShowSidebarV2Duration("waiting")).toBe(false);
    expect(shouldShowSidebarV2Duration("working")).toBe(true);
  });
});

describe("searchSidebarThreads", () => {
  const searchThread = (id: string, title: string, project: string) => ({
    environmentId: localEnvironmentId,
    id: ThreadId.make(id),
    title,
    project,
  });
  const threads = [
    searchThread("thread-1", "Fix workspace search", "Alpha"),
    searchThread("thread-2", "Review providers", "Workspace"),
    searchThread("thread-3", "WORKTREE cleanup", "Beta"),
  ];
  const contentKeys = (...ids: ReadonlyArray<string>) =>
    new Set(
      ids.map((id) =>
        threadSearchMatchKey({ environmentId: localEnvironmentId, threadId: ThreadId.make(id) }),
      ),
    );

  it("matches thread titles case-insensitively and preserves their order", () => {
    expect(searchSidebarThreads(threads, "work")).toEqual([threads[0], threads[2]]);
  });

  it("does not match project metadata", () => {
    expect(searchSidebarThreads(threads, "workspace")).toEqual([threads[0]]);
  });

  it("returns no results for an empty query", () => {
    expect(searchSidebarThreads(threads, "   ")).toEqual([]);
  });

  it("appends content-only matches after every title match", () => {
    expect(searchSidebarThreads(threads, "work", contentKeys("thread-2"))).toEqual([
      threads[0],
      threads[2],
      threads[1],
    ]);
  });

  it("lists a thread matching both title and content once", () => {
    expect(searchSidebarThreads(threads, "work", contentKeys("thread-1"))).toEqual([
      threads[0],
      threads[2],
    ]);
  });

  it("ignores content matches for threads outside the sidebar collection", () => {
    expect(searchSidebarThreads(threads, "work", contentKeys("thread-missing"))).toEqual([
      threads[0],
      threads[2],
    ]);
  });
});

describe("filterSidebarProjectScopeItems", () => {
  const items = [
    { value: "all", label: "All projects" },
    { value: "alpha", label: "Alpha workspace" },
    { value: "beta", label: "Beta tools" },
  ] as const;
  const filter = (query: string) =>
    filterSidebarProjectScopeItems({
      items,
      query,
      matches: (item, candidate) =>
        item.label.toLocaleLowerCase().includes(candidate.toLocaleLowerCase()),
    });

  it("shows the default row first while the query is empty", () => {
    expect(filter("")).toEqual(items);
    expect(filter("   ")).toEqual(items);
  });

  it("hides the default row while filtering", () => {
    expect(filter("all")).toEqual([]);
  });

  it("returns matching projects in source order and supports no-match results", () => {
    expect(filter("WORK")).toEqual([items[1]]);
    expect(filter("missing")).toEqual([]);
  });
});

describe("reduceSidebarProjectScopeMenuState", () => {
  const queriedOpenState = { open: true, query: "alpha" };

  it("clears the query when the combobox closes through onOpenChange", () => {
    expect(
      reduceSidebarProjectScopeMenuState(queriedOpenState, {
        type: "open-changed",
        open: false,
      }),
    ).toEqual({ open: false, query: "" });
  });

  it("clears the query when project settings closes the combobox", () => {
    expect(
      reduceSidebarProjectScopeMenuState(queriedOpenState, {
        type: "project-settings-opened",
      }),
    ).toEqual({ open: false, query: "" });
  });

  it("keeps the popup open while the query changes", () => {
    expect(
      reduceSidebarProjectScopeMenuState(
        { open: true, query: "" },
        { type: "query-changed", query: "beta" },
      ),
    ).toEqual({ open: true, query: "beta" });
  });
});

describe("resolveWorkingStartedAt", () => {
  const runtime = {
    status: "running" as const,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    activeRunId: RunId.make("turn-1"),
    lastError: null,
    updatedAt: "2026-03-09T10:02:00.000Z",
  };

  it("uses the running run's start time", () => {
    expect(
      resolveWorkingStartedAt({
        latestRun: makeLatestRun({ completedAt: null }),
        runtime,
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
  });

  it("uses the request time while a run awaits adoption", () => {
    expect(
      resolveWorkingStartedAt({
        latestRun: makeLatestRun({ startedAt: null, completedAt: null }),
        runtime,
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
  });

  it("does not invent a start from activity updates when the newest run completed", () => {
    expect(
      resolveWorkingStartedAt({
        latestRun: makeLatestRun(),
        runtime,
      }),
    ).toBeNull();
  });

  it("skips a malformed startedAt instead of returning it", () => {
    expect(
      resolveWorkingStartedAt({
        latestRun: makeLatestRun({ startedAt: "not-a-date", completedAt: null }),
        runtime,
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
  });

  it.each(["queued", "cancelled"] as const)(
    "shares the detail timer when a newer run is %s",
    (status) => {
      const activityStartedAt = "2026-03-09T10:00:00.000Z";
      const latestRun = {
        ...makeLatestRun(),
        runId: RunId.make("newer-run"),
        status,
        startedAt: null,
        completedAt: status === "queued" ? null : "2026-03-09T10:05:00.000Z",
      };
      for (const updatedAt of ["2026-03-09T10:30:00.000Z", "2026-03-09T10:50:00.000Z"]) {
        const activeRuntime = { ...runtime, updatedAt, activityStartedAt };
        expect(resolveWorkingStartedAt({ latestRun, runtime: activeRuntime })).toBe(
          activityStartedAt,
        );
        expect(deriveActiveWorkStartedAt(latestRun, activeRuntime, updatedAt)).toBe(
          activityStartedAt,
        );
      }
      // A server-owned run without a valid start must not borrow a local dispatch clock.
      expect(
        deriveActiveWorkStartedAt(
          latestRun,
          { ...runtime, activityStartedAt: null },
          "2026-03-09T10:50:00.000Z",
        ),
      ).toBeNull();
    },
  );

  it("returns null with neither a running run nor a runtime", () => {
    expect(resolveWorkingStartedAt({ latestRun: null, runtime: null })).toBeNull();
  });
});

describe("formatWorkingDurationLabel", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatWorkingDurationLabel(0)).toBe("0s");
    expect(formatWorkingDurationLabel(42_000)).toBe("42s");
    expect(formatWorkingDurationLabel(5 * 60_000)).toBe("5m");
    expect(formatWorkingDurationLabel(90 * 60_000)).toBe("1h 30m");
  });

  it("clamps negative and non-finite elapsed values to zero", () => {
    expect(formatWorkingDurationLabel(-5_000)).toBe("0s");
    expect(formatWorkingDurationLabel(Number.NaN)).toBe("0s");
  });
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "plan" as const,
    latestRun: null,
    lastVisitedAt: undefined,
    runtime: {
      status: "running" as const,
      providerName: "Codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      activeRunId: "turn-1" as never,
      lastError: null,
      updatedAt: "2026-03-09T10:00:00.000Z",
    },
  };

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingApprovals: true,
          hasPendingUserInput: true,
        },
      }),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("shows awaiting input when plan mode is blocked on user answers", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingUserInput: true,
        },
      }),
    ).toMatchObject({ label: "Awaiting Input", pulse: false });
  });

  it("falls back to working when the thread is actively running without blockers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows waiting for an idle thread with pending background tasks", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          pendingBackgroundTasks: [{ taskId: "bg-1", description: "Watch build", kind: "monitor" }],
          runtime: {
            ...baseThread.runtime,
            status: "idle",
            activeRunId: null,
          },
        },
      }),
    ).toMatchObject({
      label: "Waiting",
      colorClass: "text-sidebar-muted-foreground",
      dotClass: "bg-sidebar-muted-foreground",
      pulse: false,
    });
  });

  it("keeps an active turn working when background tasks are also present", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          pendingBackgroundTasks: [{ taskId: "bg-1", description: "sleep 20", kind: "command" }],
        },
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("does not show waiting after the background task roster clears", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          pendingBackgroundTasks: [],
          runtime: {
            ...baseThread.runtime,
            status: "idle",
            activeRunId: null,
          },
        },
      }),
    ).toBeNull();
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasActionableProposedPlan: true,
          latestRun: makeLatestRun(),
          runtime: {
            ...baseThread.runtime,
            status: "completed",
            activeRunId: null,
          },
        },
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("does not manufacture completed state without a client visit marker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestRun: makeLatestRun(),
          runtime: {
            ...baseThread.runtime,
            status: "completed",
            activeRunId: null,
          },
        },
      }),
    ).toBeNull();
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestRun: makeLatestRun(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          runtime: {
            ...baseThread.runtime,
            status: "completed",
            activeRunId: null,
          },
        },
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });
});

describe("resolveProjectStatusIndicator", () => {
  it("returns null when no threads have a notable status", () => {
    expect(resolveProjectStatusIndicator([null, null])).toBeNull();
  });

  it("surfaces the highest-priority actionable state across project threads", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Pending Approval",
          colorClass: "text-amber-600",
          dotClass: "bg-amber-500",
          pulse: false,
        },
        {
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        },
      ]),
    ).toMatchObject({ label: "Pending Approval", dotClass: "bg-amber-500" });
  });

  it("prefers plan-ready over completed when no stronger action is needed", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Plan Ready",
          colorClass: "text-violet-600",
          dotClass: "bg-violet-500",
          pulse: false,
        },
      ]),
    ).toMatchObject({ label: "Plan Ready", dotClass: "bg-violet-500" });
  });

  it("ranks waiting below active work and above plan-ready", () => {
    const waiting = {
      label: "Waiting" as const,
      colorClass: "text-sidebar-muted-foreground",
      dotClass: "bg-sidebar-muted-foreground",
      pulse: false,
    };

    expect(
      resolveProjectStatusIndicator([
        waiting,
        {
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        },
      ]),
    ).toMatchObject({ label: "Working" });
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Plan Ready",
          colorClass: "text-violet-600",
          dotClass: "bg-violet-500",
          pulse: false,
        },
        waiting,
      ]),
    ).toMatchObject({ label: "Waiting" });
  });
});

function makeProject(overrides: Partial<Project> = {}): Project {
  const { defaultModelSelection, ...rest } = overrides;
  return {
    id: ProjectId.make("project-1"),
    environmentId: localEnvironmentId,
    title: "Project",
    workspaceRoot: "/tmp/project",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...defaultModelSelection,
    },
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    scripts: [],
    ...rest,
  };
}

function makeThread(overrides: ThreadFixtureOverrides = {}): Thread {
  return makeThreadFixture({
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...overrides?.modelSelection,
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    runtime: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

describe("getFallbackThreadIdAfterDelete", () => {
  it("returns the top remaining thread in the deleted thread's project sidebar order", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.make("thread-oldest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-active"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-newest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-other-project"),
          projectId: ProjectId.make("project-2"),
          createdAt: "2026-03-09T10:20:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.make("thread-active"),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.make("thread-newest"));
  });

  it("skips other threads being deleted in the same action", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.make("thread-active"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-newest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-next"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:07:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.make("thread-active"),
      deletedThreadIds: new Set([ThreadId.make("thread-active"), ThreadId.make("thread-newest")]),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.make("thread-next"));
  });
});
describe("sortProjectsForSidebar", () => {
  it("sorts projects by the most recent user message across their threads", () => {
    const projects = [
      makeProject({ id: ProjectId.make("project-1"), title: "Older project" }),
      makeProject({ id: ProjectId.make("project-2"), title: "Newer project" }),
    ];
    const threads = [
      makeThread({
        projectId: ProjectId.make("project-1"),
        updatedAt: "2026-03-09T10:20:00.000Z",
        messages: [
          {
            id: "message-1" as never,
            role: "user",
            text: "older project user message",
            runId: null,
            createdAt: "2026-03-09T10:01:00.000Z",
            updatedAt: "2026-03-09T10:01:00.000Z",
            streaming: false,
          },
        ],
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        projectId: ProjectId.make("project-2"),
        updatedAt: "2026-03-09T10:05:00.000Z",
        messages: [
          {
            id: "message-2" as never,
            role: "user",
            text: "newer project user message",
            runId: null,
            createdAt: "2026-03-09T10:05:00.000Z",
            updatedAt: "2026-03-09T10:05:00.000Z",
            streaming: false,
          },
        ],
      }),
    ];

    const sorted = sortProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("falls back to project timestamps when a project has no threads", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-1"),
          title: "Older project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.make("project-2"),
          title: "Newer project",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("falls back to name and id ordering when projects have no sortable timestamps", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-2"),
          title: "Beta",
          createdAt: "invalid-created-at" as never,
          updatedAt: "invalid-updated-at" as never,
        }),
        makeProject({
          id: ProjectId.make("project-1"),
          title: "Alpha",
          createdAt: "invalid-created-at" as never,
          updatedAt: "invalid-updated-at" as never,
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it("preserves manual project ordering", () => {
    const projects = [
      makeProject({ id: ProjectId.make("project-2"), title: "Second" }),
      makeProject({ id: ProjectId.make("project-1"), title: "First" }),
    ];

    const sorted = sortProjectsForSidebar(projects, [], "manual");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });

  it("ignores archived threads when sorting projects", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.make("project-1"),
          title: "Visible project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.make("project-2"),
          title: "Archived-only project",
          updatedAt: "2026-03-09T10:00:00.000Z",
        }),
      ],
      [
        makeThread({
          id: ThreadId.make("thread-visible"),
          projectId: ProjectId.make("project-1"),
          updatedAt: "2026-03-09T10:02:00.000Z",
          archivedAt: null,
        }),
        makeThread({
          id: ThreadId.make("thread-archived"),
          projectId: ProjectId.make("project-2"),
          updatedAt: "2026-03-09T10:10:00.000Z",
          archivedAt: "2026-03-09T10:11:00.000Z",
        }),
      ].filter((thread) => thread.archivedAt === null),
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-1"),
      ProjectId.make("project-2"),
    ]);
  });

  it.each(["updated_at", "created_at"] as const)(
    "matches the per-comparison %s order on a shuffled list with ties",
    (sortOrder) => {
      const minute = (value: number) => `2026-03-09T10:0${value}:00.000Z`;
      // (index * 7) % 24 scrambles the input order. Titles repeat, and
      // projects 16-23 have no threads, so they use their own stamps.
      const projects = Array.from({ length: 24 }, (_, index) => {
        const n = (index * 7) % 24;
        return makeProject({
          id: ProjectId.make(`project-${n}`),
          title: n % 2 === 0 ? "Alpha" : "Beta",
          createdAt: minute(n % 3),
          updatedAt: n % 5 === 0 ? "invalid" : minute(n % 2),
        });
      });
      const threads = Array.from({ length: 48 }, (_, n) => ({
        projectId: ProjectId.make(`project-${n % 16}`),
        createdAt: minute(n % 6),
        updatedAt: minute(n % 3),
        latestUserMessageAt: n % 4 === 0 ? null : minute(n % 5),
      }));
      // The comparator this sort replaced: it walked each project's threads
      // on every call.
      const timestamp = (project: Project) =>
        getProjectSortTimestamp(
          project,
          threads.filter((thread) => thread.projectId === project.id),
          sortOrder,
        );
      const expected = projects.toSorted((left, right) => {
        const rightTimestamp = timestamp(right);
        const leftTimestamp = timestamp(left);
        const byTimestamp =
          rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
        return (
          byTimestamp || left.title.localeCompare(right.title) || left.id.localeCompare(right.id)
        );
      });

      expect(sortProjectsForSidebar(projects, threads, sortOrder)).toEqual(expected);
    },
  );

  it("returns the project timestamp when no threads are present", () => {
    const timestamp = getProjectSortTimestamp(
      makeProject({ updatedAt: "2026-03-09T10:10:00.000Z" }),
      [],
      "updated_at",
    );

    expect(timestamp).toBe(Date.parse("2026-03-09T10:10:00.000Z"));
  });
});

describe("sortScopedProjectsForSidebar", () => {
  it("keeps identical project ids in different environments separate", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const sharedProjectId = ProjectId.make("shared-project");
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: sharedProjectId,
        title: "Local project",
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: sharedProjectId,
        title: "Remote project",
      }),
    ];
    const threads = [
      makeThread({
        environmentId: localEnvironmentId,
        projectId: sharedProjectId,
        updatedAt: "2026-03-09T10:02:00.000Z",
      }),
      makeThread({
        environmentId: remoteEnvironmentId,
        projectId: sharedProjectId,
        updatedAt: "2026-03-09T10:10:00.000Z",
      }),
    ];

    const sorted = sortScopedProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.title)).toEqual(["Remote project", "Local project"]);
  });

  it("does not use archived threads as project activity", () => {
    const projects = [
      makeProject({
        id: ProjectId.make("project-visible"),
        title: "Visible project",
        updatedAt: "2026-03-09T10:01:00.000Z",
      }),
      makeProject({
        id: ProjectId.make("project-archived"),
        title: "Archived-only project",
        updatedAt: "2026-03-09T10:00:00.000Z",
      }),
    ];
    const threads = [
      makeThread({
        id: ThreadId.make("thread-visible"),
        projectId: ProjectId.make("project-visible"),
        updatedAt: "2026-03-09T10:02:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-archived"),
        projectId: ProjectId.make("project-archived"),
        updatedAt: "2026-03-09T10:10:00.000Z",
        archivedAt: "2026-03-09T10:11:00.000Z",
      }),
    ];

    const sorted = sortScopedProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.title)).toEqual([
      "Visible project",
      "Archived-only project",
    ]);
  });
});

describe("sortLogicalProjectsForSidebar", () => {
  it("uses saved order only in manual mode and activity order otherwise", () => {
    const olderProjectId = ProjectId.make("project-older");
    const newerProjectId = ProjectId.make("project-newer");
    const projects = [
      {
        ...makeProject({ id: olderProjectId, title: "Older project" }),
        projectKey: "logical-older",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: olderProjectId }],
      },
      {
        ...makeProject({ id: newerProjectId, title: "Newer project" }),
        projectKey: "logical-newer",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: newerProjectId }],
      },
    ];
    const threads = [
      makeThread({
        projectId: olderProjectId,
        updatedAt: "2026-03-09T10:01:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-newer"),
        projectId: newerProjectId,
        updatedAt: "2026-03-09T10:05:00.000Z",
      }),
    ];

    expect(sortLogicalProjectsForSidebar(projects, threads, "manual")).toEqual(projects);
    expect(
      sortLogicalProjectsForSidebar(projects, threads, "updated_at").map(
        (project) => project.projectKey,
      ),
    ).toEqual(["logical-newer", "logical-older"]);
  });
});

describe("sortSidebarV2ProjectGroups", () => {
  it("does not let a hidden subagent thread reorder projects", () => {
    const olderProjectId = ProjectId.make("project-older");
    const newerProjectId = ProjectId.make("project-newer");
    const olderRootThreadId = ThreadId.make("thread-older-root");
    const projects = [
      {
        ...makeProject({ id: olderProjectId, title: "A older project" }),
        projectKey: "logical-older",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: olderProjectId }],
      },
      {
        ...makeProject({ id: newerProjectId, title: "Z newer project" }),
        projectKey: "logical-newer",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: newerProjectId }],
      },
    ];
    const threads = [
      makeThread({
        id: olderRootThreadId,
        projectId: olderProjectId,
        updatedAt: "2026-03-09T10:01:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-newer-root"),
        projectId: newerProjectId,
        updatedAt: "2026-03-09T10:05:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-hidden-subagent"),
        projectId: olderProjectId,
        updatedAt: "2026-03-09T10:10:00.000Z",
        lineage: {
          rootThreadId: olderRootThreadId,
          parentThreadId: olderRootThreadId,
          relationshipToParent: "subagent",
        },
      }),
    ];

    expect(
      sortSidebarV2ProjectGroups(projects, threads, "updated_at").map(
        (project) => project.projectKey,
      ),
    ).toEqual(["logical-newer", "logical-older"]);
  });
});

describe("resolveThreadLastVisitedAt", () => {
  it("uses the local watermark when the server does not track visits", () => {
    expect(resolveThreadLastVisitedAt(undefined, "2026-07-30T10:00:00.000Z")).toBe(
      "2026-07-30T10:00:00.000Z",
    );
    expect(resolveThreadLastVisitedAt(undefined, undefined)).toBeUndefined();
  });

  it("keeps the server watermark authoritative when visited tracking exists", () => {
    // A rewound server value (mark-unread) must win even over a newer local
    // watermark left behind by earlier viewing on this device.
    expect(resolveThreadLastVisitedAt("2026-07-30T10:00:00.000Z", "2026-07-30T10:00:05.000Z")).toBe(
      "2026-07-30T10:00:00.000Z",
    );
    expect(resolveThreadLastVisitedAt("2026-07-30T10:00:00.000Z", undefined)).toBe(
      "2026-07-30T10:00:00.000Z",
    );
  });

  it("treats an explicit server-side null as never visited", () => {
    expect(resolveThreadLastVisitedAt(null, "2026-07-30T10:00:00.000Z")).toBeUndefined();
  });
});

describe("pinOrderKeyBetween", () => {
  it("produces keys that sort between their bounds", () => {
    const middle = pinOrderKeyBetween(null, null)!;
    const top = pinOrderKeyBetween(null, middle)!;
    const bottom = pinOrderKeyBetween(middle, null)!;
    expect(top < middle).toBe(true);
    expect(middle < bottom).toBe(true);

    const between = pinOrderKeyBetween(top, middle)!;
    expect(top < between && between < middle).toBe(true);
  });

  it("extends into new digits when bounds are adjacent", () => {
    const key = pinOrderKeyBetween("g", "h")!;
    expect("g" < key && key < "h").toBe(true);
  });

  it("stays strictly ordered under repeated top insertion", () => {
    // Every new pin lands at the head of the arranged run; keys must keep
    // sorting before the previous head without ever bottoming out.
    let head: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      const key: string = pinOrderKeyBetween(null, head)!;
      expect(key).not.toBeNull();
      if (head !== null) expect(key < head).toBe(true);
      keys.push(key);
      head = key;
    }
    expect(new Set(keys).size).toBe(100);
  });

  it("stays strictly ordered under repeated middle insertion", () => {
    let low = pinOrderKeyBetween(null, null)!;
    let high = pinOrderKeyBetween(low, null)!;
    for (let i = 0; i < 100; i += 1) {
      const key: string = pinOrderKeyBetween(low, high)!;
      expect(low < key && key < high).toBe(true);
      if (i % 2 === 0) low = key;
      else high = key;
    }
  });

  it("returns null for corrupt or out-of-order bounds instead of throwing", () => {
    expect(pinOrderKeyBetween("z", "a")).toBeNull();
    expect(pinOrderKeyBetween("A!", null)).toBeNull();
    expect(pinOrderKeyBetween(null, "ma")).toBeNull();
    expect(pinOrderKeyBetween("m", "m")).toBeNull();
  });
});

describe("sortPinnedThreadsForSidebar", () => {
  const pinnable = (input: { id: string; createdAt: string; pinOrderKey?: string | null }) => ({
    id: input.id,
    createdAt: input.createdAt,
    pinOrderKey: input.pinOrderKey ?? null,
  });

  it("sorts keyed threads by key ahead of keyless threads in creation order", () => {
    const sorted = sortPinnedThreadsForSidebar([
      pinnable({ id: "keyless-old", createdAt: "2026-03-09T08:00:00.000Z" }),
      pinnable({ id: "second", createdAt: "2026-03-09T09:00:00.000Z", pinOrderKey: "t" }),
      pinnable({ id: "keyless-new", createdAt: "2026-03-09T12:00:00.000Z" }),
      pinnable({ id: "first", createdAt: "2026-03-09T07:00:00.000Z", pinOrderKey: "g" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual([
      "first",
      "second",
      "keyless-new",
      "keyless-old",
    ]);
  });

  it("breaks equal keys by id so raced writes render identically everywhere", () => {
    const sorted = sortPinnedThreadsForSidebar([
      pinnable({ id: "b", createdAt: "2026-03-09T10:00:00.000Z", pinOrderKey: "m" }),
      pinnable({ id: "a", createdAt: "2026-03-09T11:00:00.000Z", pinOrderKey: "m" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["a", "b"]);
  });
});

describe("resolveSidebarSweepKeys", () => {
  const ordered = ["a", "b", "c", "d", "blocked"];
  const canSettle = (key: string) => key !== "blocked";

  it("covers every row between the pressed row and the pointer, in either direction", () => {
    expect(resolveSidebarSweepKeys(ordered, "b", "b", canSettle)).toEqual(["b"]);
    expect(resolveSidebarSweepKeys(ordered, "b", "d", canSettle)).toEqual(["b", "c", "d"]);
    expect(resolveSidebarSweepKeys(ordered, "d", "a", canSettle)).toEqual(["a", "b", "c", "d"]);
  });

  it("leaves out rows that cannot settle and rows that left the list", () => {
    expect(resolveSidebarSweepKeys(ordered, "c", "blocked", canSettle)).toEqual(["c", "d"]);
    expect(resolveSidebarSweepKeys(ordered, "gone", "a", canSettle)).toEqual([]);
  });
});

describe("navigation after parking a thread", () => {
  it.each([
    ["settle", "settled", null, "thread", true],
    ["settle", "active", null, "thread", false],
    ["settle", "settled", null, "other-thread", false],
    ["snooze", null, "2099-01-01T00:00:00.000Z", "thread", true],
    ["snooze", null, null, "thread", false],
    ["snooze", null, "2026-09-12T09:00:00.000Z", "thread", false],
    ["snooze", null, "2099-01-01T00:00:00.000Z", "thread", false, true],
    ["snooze", null, "2099-01-01T00:00:00.000Z", "other-thread", false],
  ] as const)(
    "%s with state %s / %s on %s navigates: %s",
    (
      action,
      settledOverride,
      snoozedUntil,
      currentThreadKey,
      expected,
      hasPendingApprovals: boolean = false,
    ) => {
      expect(
        shouldNavigateAfterThreadPark({
          threadKey: "thread",
          currentThreadKey,
          action,
          now: "2026-09-12T10:00:00.000Z",
          thread: {
            settledOverride,
            snoozedUntil,
            snoozedAt: null,
            session: null,
            latestTurn: null,
            hasPendingApprovals,
            hasPendingUserInput: false,
          },
        }),
      ).toBe(expected);
    },
  );
});

describe("unseen completion with background work", () => {
  it.each([
    { kind: "command", status: "ready", topStatus: "done", receded: false, pill: "Completed" },
    { kind: "monitor", status: "waiting", topStatus: "waiting", receded: true, pill: "Waiting" },
  ] as const)("presents a completed thread with a $kind roster", (expected) => {
    const thread = presentThreadShell(localEnvironmentId, {
      ...makeThreadFixture().source,
      latestRunId: RunId.make("run-background-completion"),
      status: "completed",
      latestRunCompletedAt: DateTime.makeUnsafe("2026-06-20T01:00:00.000Z"),
      lastVisitedAt: DateTime.makeUnsafe("2026-06-20T00:59:00.000Z"),
      pendingBackgroundTasks: [{ taskId: "background-work", kind: expected.kind }],
    });
    const status = resolveSidebarThreadStatus(thread);
    const isUnread = hasUnseenCompletion(thread);

    expect(isUnread).toBe(true);
    expect(status).toBe(expected.status);
    expect(resolveSidebarV2TopStatus({ status, isUnread, isWoke: false })).toBe(expected.topStatus);
    expect(
      shouldRecedeSidebarThread({
        status,
        isUnread,
        isWoke: false,
        isActive: false,
        isSelected: false,
      }),
    ).toBe(expected.receded);
    expect(isSidebarThreadWorking(thread)).toBe(expected.receded);
    expect(resolveThreadStatusPill({ thread })).toMatchObject({ label: expected.pill });
  });
});

describe("Working shelf (beta)", () => {
  const runtime = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };
  const backgroundTask = { taskId: "bg-1", description: "Watch build", kind: "monitor" as const };
  const idle = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    latestRun: makeLatestRun(),
    runtime: null,
  };
  // Stopped with background tasks still open: V2's "waiting" sidebar status.
  const waiting = {
    ...idle,
    runtime: { ...runtime, status: "idle" as const },
    pendingBackgroundTasks: [backgroundTask],
  };

  it("folds away running threads and threads waiting on background work only", () => {
    expect(isSidebarThreadWorking({ ...idle, runtime })).toBe(true);
    expect(isSidebarThreadWorking(waiting)).toBe(true);
    expect(isSidebarThreadWorking(idle)).toBe(false);
    expect(isSidebarThreadWorking({ ...idle, runtime, hasPendingApprovals: true })).toBe(false);
    expect(isSidebarThreadWorking({ ...idle, runtime, hasPendingUserInput: true })).toBe(false);
    expect(
      isSidebarThreadWorking({
        ...waiting,
        runtime: { ...runtime, status: "failed" as const, lastError: "boom" },
      }),
    ).toBe(false);
  });

  it("keeps a ready plan in the inbox while background work runs", () => {
    expect(
      isSidebarThreadWorking({
        ...waiting,
        interactionMode: "plan",
        hasActionableProposedPlan: true,
      }),
    ).toBe(false);
  });

  describe("sortInboxThreadsByReturn", () => {
    const thread = (
      id: string,
      input: { createdAt: string; completedAt?: string | null; unsettledAt?: string },
    ) => ({
      id: ThreadId.make(id),
      environmentId: localEnvironmentId,
      createdAt: input.createdAt,
      unsettledAt: input.unsettledAt ?? null,
      latestRun:
        input.completedAt === undefined
          ? null
          : { ...makeLatestRun({ completedAt: input.completedAt }), requestedAt: input.createdAt },
    });

    it("puts the thread that finished last on top, whatever its age", () => {
      const sorted = sortInboxThreadsByReturn([
        thread("new", { createdAt: "2026-03-09T11:00:00.000Z" }),
        thread("old-finished-now", {
          createdAt: "2026-03-01T09:00:00.000Z",
          completedAt: "2026-03-09T12:00:00.000Z",
        }),
        thread("reopened", {
          createdAt: "2026-03-02T09:00:00.000Z",
          unsettledAt: "2026-03-09T11:30:00.000Z",
        }),
      ]);
      expect(sorted.map((entry) => entry.id)).toEqual(["old-finished-now", "reopened", "new"]);
    });

    it("counts a return the server does not stamp, like an approval request", () => {
      const waiting = thread("asks-approval", {
        createdAt: "2026-03-09T09:00:00.000Z",
        completedAt: null,
      });
      const finished = thread("finished", {
        createdAt: "2026-03-09T09:30:00.000Z",
        completedAt: "2026-03-09T11:00:00.000Z",
      });
      expect(sortInboxThreadsByReturn([finished, waiting]).map((entry) => entry.id)).toEqual([
        "finished",
        "asks-approval",
      ]);
      expect(
        sortInboxThreadsByReturn([finished, waiting], (entry) =>
          entry === waiting ? Date.parse("2026-03-09T11:05:00.000Z") : undefined,
        ).map((entry) => entry.id),
      ).toEqual(["asks-approval", "finished"]);
    });
  });

  describe("dragging", () => {
    const marker = (name: SidebarListMarker): SidebarListItem => ({ kind: "marker", marker: name });
    const row = (key: string, section: SidebarSection): SidebarListItem => ({
      kind: "thread",
      key,
      section,
    });
    // Pinned p1 | Active a1 a2 | Working w1 | Settled s1
    const items: readonly SidebarListItem[] = [
      marker("pinned-header"),
      row("p1", "pinned"),
      marker("pinned-divider"),
      row("a1", "active"),
      row("a2", "active"),
      marker("working-header"),
      row("w1", "working"),
      marker("settled-header"),
      row("s1", "settled"),
    ];

    it("never drops into the Working shelf, and keeps it out of the inbox order", () => {
      expect(resolveSidebarDropTarget(items, "a1", "w1")).toBeNull();
      expect(resolveSidebarDropTarget(items, "p1", "a2")).toEqual({
        section: "active",
        pinnedOrder: [],
        activeOrder: ["a1", "a2", "p1"],
      });
      expect(resolveSidebarDropVerb("active", "working")).toBeNull();
    });

    it("resolves a drop over a project heading to its section, without ordering headings or groups", () => {
      // Pinned p1 | Active [heading] a1 [group] g-member
      const tree: readonly SidebarListItem[] = [
        marker("pinned-header"),
        row("p1", "pinned"),
        marker("pinned-divider"),
        { kind: "project-heading", key: "project-a" },
        row("a1", "active"),
        { kind: "group", key: "g1", section: "active" },
        { kind: "thread", key: "g-member", section: "active", groupKey: "g1" },
        marker("settled-header"),
        row("s1", "settled"),
      ];
      expect(resolveSidebarDropTarget(tree, "p1", "sidebar-project-project-a")).toEqual({
        section: "active",
        pinnedOrder: [],
        activeOrder: ["p1", "a1"],
      });
      expect(resolveSidebarDropTarget(tree, "s1", "sidebar-group-g1")).toEqual({
        section: "active",
        pinnedOrder: ["p1"],
        activeOrder: ["a1", "s1"],
      });
    });

    it("arranges the rows it can write when another row's server cannot store an order", () => {
      // None of the rows has a key yet, so the drop needs keys for its
      // neighbors too. "offline" sits on a server that cannot take them.
      const plan = planSidebarThreadDrop({
        activeKey: "a2",
        activeSection: "active",
        target: {
          section: "active",
          pinnedOrder: [],
          activeOrder: ["offline", "a2", "a1"],
        },
        pinnedOrder: [],
        pinnedKeysById: new Map(),
        activeOrder: ["offline", "a1", "a2"],
        activeKeysById: new Map([
          ["offline", null],
          ["a1", null],
          ["a2", null],
        ]),
        activeReorderableKeys: new Set(["a1", "a2"]),
      });
      expect(plan.kind).toBe("move-active");
      if (plan.kind !== "move-active") return;
      expect(plan.assignments.map(({ id }) => id)).toEqual(["a2", "a1"]);
      const [a2, a1] = plan.assignments.map(({ orderKey }) => orderKey);
      expect(a2! < a1!).toBe(true);

      // A keyed row on that server still sorts by its key, so it stays a bound.
      const above = planSidebarThreadDrop({
        activeKey: "a2",
        activeSection: "active",
        target: { section: "active", pinnedOrder: [], activeOrder: ["a2", "offline"] },
        pinnedOrder: [],
        pinnedKeysById: new Map(),
        activeOrder: ["offline", "a2"],
        activeKeysById: new Map([
          ["offline", "m"],
          ["a2", "t"],
        ]),
        activeReorderableKeys: new Set(["a2"]),
      });
      expect(above.kind === "move-active" && above.assignments[0]!.orderKey < "m").toBe(true);
    });

    it("only changes lifecycle when the inbox is time-ordered", () => {
      const base = {
        pinnedOrder: ["p1"],
        pinnedKeysById: new Map([["p1", "m"]]),
        activeOrder: ["a1", "a2"],
        activeKeysById: new Map([
          ["a1", "f"],
          ["a2", "t"],
        ]),
        activeTimeOrdered: true,
      };
      expect(
        planSidebarThreadDrop({
          ...base,
          activeKey: "a1",
          activeSection: "active",
          target: { section: "active", pinnedOrder: ["p1"], activeOrder: ["a2", "a1"] },
        }),
      ).toEqual({ kind: "none" });
      expect(
        planSidebarThreadDrop({
          ...base,
          activeKey: "p1",
          activeSection: "pinned",
          target: { section: "active", pinnedOrder: [], activeOrder: ["a1", "p1", "a2"] },
        }),
      ).toEqual({
        kind: "move-active",
        order: null,
        assignments: [],
        unpin: true,
        unsettle: false,
        unsnooze: false,
      });
    });
  });
});

function makeGroup(
  overrides: Partial<Omit<EnvironmentThreadGroup, "threadIds" | "source">> & {
    readonly threadIds?: ReadonlyArray<ThreadId>;
  } = {},
): EnvironmentThreadGroup {
  const {
    environmentId = localEnvironmentId,
    threadIds = [],
    visible = threadIds.length >= 2,
    ...shellOverrides
  } = overrides;
  const group = presentThreadGroup(
    environmentId,
    {
      id: ThreadGroupId.make("group-1"),
      projectId: ProjectId.make("project-1"),
      title: "Auth refactor",
      goal: null,
      branch: null,
      worktreePath: null,
      pullRequest: null,
      lastHandoff: null,
      pinnedAt: null,
      snoozedUntil: null,
      settledAt: null,
      manualResources: [],
      links: [],
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      ...shellOverrides,
    },
    [],
  );
  return { ...group, threadIds, visible };
}

describe("sidebarActivityMs", () => {
  it("uses the latest user message", () => {
    expect(
      sidebarActivityMs({
        createdAt: "2026-03-09T10:00:00.000Z",
        latestUserMessageAt: "2026-03-09T11:00:00.000Z",
      }),
    ).toBe(Date.parse("2026-03-09T11:00:00.000Z"));
  });

  it("falls back to creation time", () => {
    expect(
      sidebarActivityMs({ createdAt: "2026-03-09T10:00:00.000Z", latestUserMessageAt: null }),
    ).toBe(Date.parse("2026-03-09T10:00:00.000Z"));
  });

  it("lets a later unsettle win", () => {
    expect(
      sidebarActivityMs({
        createdAt: "2026-03-09T10:00:00.000Z",
        latestUserMessageAt: "2026-03-09T11:00:00.000Z",
        unsettledAt: "2026-03-09T12:00:00.000Z",
      }),
    ).toBe(Date.parse("2026-03-09T12:00:00.000Z"));
  });

  it("ignores a newer updatedAt, which renames and group moves bump", () => {
    const thread = makeThread({ createdAt: "2026-03-09T10:00:00.000Z" });
    const bumped = { ...thread, updatedAt: "2026-03-10T10:00:00.000Z" };
    expect(sidebarActivityMs(bumped)).toBe(sidebarActivityMs(thread));
  });
});

describe("resolveThreadGroupStatus", () => {
  const idle = { hasPendingApprovals: false, hasPendingUserInput: false, runtime: null };
  const working = makeThread({
    runtime: { ...makeThread().runtime!, status: "running" },
  });
  const failed = makeThread({
    runtime: { ...makeThread().runtime!, status: "failed", lastErrorClass: null },
  });

  it("lets an approval beat a working member", () => {
    expect(resolveThreadGroupStatus([working, { ...idle, hasPendingApprovals: true }])).toBe(
      "approval",
    );
  });

  it("lets a failure beat a working member", () => {
    expect(resolveThreadGroupStatus([working, failed])).toBe("failed");
  });

  it("has no status without members", () => {
    expect(resolveThreadGroupStatus([])).toBeNull();
  });
});

describe("resolveSidebarGroupSection", () => {
  const now = "2026-03-09T12:00:00.000Z";
  const shell = { pinnedAt: null, snoozedUntil: null, settledAt: null };
  const activity = { createdAt: "2026-03-09T09:00:00.000Z", latestUserMessageAt: null };
  const active = { ...activity, settledOverride: null };
  const settled = { ...activity, settledOverride: "settled" as const };

  it("lets a future snooze beat settled and pinned", () => {
    expect(
      resolveSidebarGroupSection({
        group: {
          pinnedAt: "2026-03-09T09:00:00.000Z",
          snoozedUntil: "2026-03-09T13:00:00.000Z",
          settledAt: "2026-03-09T10:00:00.000Z",
        },
        members: [settled],
        now,
      }),
    ).toBe("snoozed");
  });

  it("ignores a snooze that has passed", () => {
    expect(
      resolveSidebarGroupSection({
        group: { ...shell, snoozedUntil: "2026-03-09T11:00:00.000Z" },
        members: [active],
        now,
      }),
    ).toBe("active");
  });

  it("settles a stamped group", () => {
    expect(
      resolveSidebarGroupSection({
        group: { ...shell, settledAt: "2026-03-09T10:00:00.000Z" },
        members: [active],
        now,
      }),
    ).toBe("settled");
  });

  it("drops a settle stamp that a later use outlived, for labels and sorting too", () => {
    const group = { settledAt: "2026-03-09T10:00:00.000Z" };
    expect(groupSettleStampMs(group, [settled])).toBe(Date.parse("2026-03-09T10:00:00.000Z"));
    expect(
      groupSettleStampMs(group, [{ ...settled, unsettledAt: "2026-03-09T11:00:00.000Z" }]),
    ).toBeNull();
    expect(groupSettleStampMs({ settledAt: null }, [settled])).toBeNull();
  });

  it("brings a stamped group back when a member is used or unsettled after the stamp", () => {
    const group = { ...shell, settledAt: "2026-03-09T10:00:00.000Z" };
    expect(
      resolveSidebarGroupSection({
        group,
        members: [settled, { ...active, latestUserMessageAt: "2026-03-09T10:30:00.000Z" }],
        now,
      }),
    ).toBe("active");
    expect(
      resolveSidebarGroupSection({
        group,
        members: [{ ...active, unsettledAt: "2026-03-09T10:05:00.000Z" }],
        now,
      }),
    ).toBe("active");
    expect(
      resolveSidebarGroupSection({
        group,
        members: [{ ...settled, settledOverride: "active" }],
        now,
      }),
    ).toBe("active");
  });

  it("settles a group whose members are all settled, unless one is active", () => {
    expect(resolveSidebarGroupSection({ group: shell, members: [settled, settled], now })).toBe(
      "settled",
    );
    expect(resolveSidebarGroupSection({ group: shell, members: [settled, active], now })).toBe(
      "active",
    );
  });

  it("keeps a group with no members and no stamp active", () => {
    expect(resolveSidebarGroupSection({ group: shell, members: [], now })).toBe("active");
  });

  it("pins a pinned group", () => {
    expect(
      resolveSidebarGroupSection({
        group: { ...shell, pinnedAt: "2026-03-09T10:00:00.000Z" },
        members: [active],
        now,
      }),
    ).toBe("pinned");
  });
});

describe("partitionThreadsByGroup", () => {
  const groupId = ThreadGroupId.make("group-1");
  const otherEnvironmentId = EnvironmentId.make("environment-other");

  it("leaves a chat whose group is unknown ungrouped", () => {
    const thread = makeThread({ groupId: ThreadGroupId.make("missing") });
    const result = partitionThreadsByGroup({ threads: [thread], groups: new Map() });
    expect(result.ungrouped).toEqual([thread]);
    expect(result.byGroup.size).toBe(0);
  });

  it("keeps the same group id in two environments apart", () => {
    const local = makeThread({ id: ThreadId.make("local"), groupId });
    const remote = makeThread({
      id: ThreadId.make("remote"),
      environmentId: otherEnvironmentId,
      groupId,
    });
    const localKey = threadGroupKey({ environmentId: localEnvironmentId, groupId });
    const remoteKey = threadGroupKey({ environmentId: otherEnvironmentId, groupId });
    const result = partitionThreadsByGroup({
      threads: [local, remote],
      groups: new Map([
        [localKey, makeGroup({ threadIds: [local.id], visible: true })],
        [
          remoteKey,
          makeGroup({ environmentId: otherEnvironmentId, threadIds: [remote.id], visible: true }),
        ],
      ]),
    });
    expect(result.byGroup.get(localKey)).toEqual([local]);
    expect(result.byGroup.get(remoteKey)).toEqual([remote]);
  });

  it("renders a hidden group's lone chat ungrouped, in the chat's own section", () => {
    const lone = makeThread({ groupId, pinnedAt: null });
    const key = threadGroupKey({ environmentId: localEnvironmentId, groupId });
    // The server clears a hidden group's pin; a stale one still never places the chat.
    const hidden = makeGroup({ threadIds: [lone.id], pinnedAt: "2026-03-09T10:00:00.000Z" });
    expect(hidden.visible).toBe(false);
    const result = partitionThreadsByGroup({ threads: [lone], groups: new Map([[key, hidden]]) });
    expect(result.ungrouped).toEqual([lone]);
    expect(result.byGroup.size).toBe(0);
    expect(
      resolveSidebarThreadSection({
        snoozed: false,
        settled: false,
        pinned: lone.pinnedAt != null,
      }),
    ).toBe("active");
  });

  it("leaves a chat whose group belongs to another project ungrouped", () => {
    const stray = makeThread({ projectId: ProjectId.make("project-2"), groupId });
    const result = partitionThreadsByGroup({
      threads: [stray],
      groups: new Map([
        [
          threadGroupKey({ environmentId: localEnvironmentId, groupId }),
          makeGroup({ threadIds: [stray.id] }),
        ],
      ]),
    });
    expect(result.ungrouped).toEqual([stray]);
    expect(result.byGroup.size).toBe(0);
  });

  it("orders members by the group's threadIds", () => {
    const first = makeThread({ id: ThreadId.make("first"), groupId });
    const second = makeThread({ id: ThreadId.make("second"), groupId });
    const key = threadGroupKey({ environmentId: localEnvironmentId, groupId });
    const result = partitionThreadsByGroup({
      threads: [second, first],
      groups: new Map([[key, makeGroup({ threadIds: [first.id, second.id] })]]),
    });
    expect(result.byGroup.get(key)).toEqual([first, second]);
  });
});

describe("buildSidebarActiveTree", () => {
  type Item = { readonly id: string; readonly project: string } & Parameters<
    typeof sidebarActivityMs
  >[0];
  const item = (id: string, project: string, at: string): Item => ({
    id,
    project,
    createdAt: at,
    latestUserMessageAt: null,
  });
  const group = (id: string, project: string) =>
    makeGroup({ id: ThreadGroupId.make(id), projectId: ProjectId.make(project) });
  const projectKeyOf = (entry: Item | EnvironmentThreadGroup) =>
    "project" in entry ? entry.project : entry.projectId;
  const describeTree = (entries: ReadonlyArray<SidebarTreeEntry<Item>>) =>
    entries.map((entry) =>
      entry.kind === "project-heading"
        ? `project:${entry.projectKey}`
        : entry.kind === "group"
          ? `group:${entry.groupKey}`
          : `thread:${entry.thread.id}${entry.groupKey === null ? "" : `@${entry.groupKey}`}`,
    );

  it("orders projects by their newest item", () => {
    const tree = buildSidebarActiveTree({
      ungrouped: [
        item("old", "a", "2026-03-09T10:00:00.000Z"),
        item("new", "b", "2026-03-09T11:00:00.000Z"),
      ],
      groups: [],
      projectKeyOf,
      isExpanded: () => false,
    });
    expect(describeTree(tree)).toEqual(["project:b", "thread:new", "project:a", "thread:old"]);
  });

  it("puts a group with a newer member above an older ungrouped chat", () => {
    const tree = buildSidebarActiveTree({
      ungrouped: [item("loose", "a", "2026-03-09T10:00:00.000Z")],
      groups: [
        {
          key: "g1",
          group: group("g1", "a"),
          members: [item("member", "a", "2026-03-09T11:00:00.000Z")],
        },
      ],
      projectKeyOf,
      isExpanded: () => false,
    });
    expect(describeTree(tree)).toEqual(["project:a", "group:g1", "thread:loose"]);
  });

  it("emits members after an expanded group in threadIds order, and none for a collapsed one", () => {
    const members = [
      item("first", "a", "2026-03-09T10:00:00.000Z"),
      item("second", "a", "2026-03-09T12:00:00.000Z"),
    ];
    const input = {
      ungrouped: [item("loose", "a", "2026-03-09T11:00:00.000Z")],
      groups: [{ key: "g1", group: group("g1", "a"), members }],
      projectKeyOf,
    };
    expect(describeTree(buildSidebarActiveTree({ ...input, isExpanded: () => true }))).toEqual([
      "project:a",
      "group:g1",
      "thread:first@g1",
      "thread:second@g1",
      "thread:loose",
    ]);
    expect(describeTree(buildSidebarActiveTree({ ...input, isExpanded: () => false }))).toEqual([
      "project:a",
      "group:g1",
      "thread:loose",
    ]);
  });

  it("emits nothing for a group with no members", () => {
    const tree = buildSidebarActiveTree({
      ungrouped: [],
      groups: [{ key: "g1", group: group("g1", "a"), members: [] }],
      projectKeyOf,
      isExpanded: () => true,
    });
    expect(tree).toEqual([]);
  });
});

describe("resolveSidebarGroupExpanded", () => {
  const base = {
    groupKey: "g",
    parked: false,
    persisted: true,
    parkedOverride: undefined,
    routeGroupKey: null,
  };
  it("follows the persisted choice outside the parked shelves", () => {
    expect(resolveSidebarGroupExpanded(base)).toBe(true);
    expect(resolveSidebarGroupExpanded({ ...base, persisted: false, routeGroupKey: "g" })).toBe(
      false,
    );
  });
  it("shows a parked group collapsed unless it holds the open chat", () => {
    expect(resolveSidebarGroupExpanded({ ...base, parked: true })).toBe(false);
    expect(resolveSidebarGroupExpanded({ ...base, parked: true, routeGroupKey: "g" })).toBe(true);
  });
  it("lets a toggle in a parked shelf win for the session", () => {
    expect(resolveSidebarGroupExpanded({ ...base, parked: true, parkedOverride: true })).toBe(true);
    expect(
      resolveSidebarGroupExpanded({
        ...base,
        parked: true,
        routeGroupKey: "g",
        parkedOverride: false,
      }),
    ).toBe(false);
  });
});

describe("resolveForcedOpenGroupKey", () => {
  const groupKeyByThreadKey = new Map([["env:member", "env:group"]]);

  it("opens the group holding the routed chat", () => {
    expect(resolveForcedOpenGroupKey({ routeThreadKey: "env:member", groupKeyByThreadKey })).toBe(
      "env:group",
    );
  });

  it("opens nothing for an ungrouped route", () => {
    expect(
      resolveForcedOpenGroupKey({ routeThreadKey: "env:loose", groupKeyByThreadKey }),
    ).toBeNull();
    expect(resolveForcedOpenGroupKey({ routeThreadKey: null, groupKeyByThreadKey })).toBeNull();
  });
});

describe("resolveSidebarGroupDropTarget", () => {
  const remoteEnvironmentId = EnvironmentId.make("environment-remote");
  const inProject = {
    environmentId: localEnvironmentId,
    projectId: "project-a",
    lineage: { relationshipToParent: null },
    groupId: null as ThreadGroupId | null,
  };
  const groups = new Map([
    ["group:auth", { environmentId: localEnvironmentId, projectId: ProjectId.make("project-a") }],
    ["group:docs", { environmentId: localEnvironmentId, projectId: ProjectId.make("project-a") }],
    ["group:other", { environmentId: localEnvironmentId, projectId: ProjectId.make("project-b") }],
  ]);
  const threads = new Map([
    ["env:lone", inProject],
    ["env:member", inProject],
    ["env:pinned", inProject],
    ["env:elsewhere", { ...inProject, projectId: "project-b" }],
    ["env:remote", { ...inProject, environmentId: remoteEnvironmentId }],
  ]);
  const active = (
    overrides: Partial<Parameters<typeof resolveSidebarGroupDropTarget>[0]["activeThread"]> = {},
  ) => ({
    ...inProject,
    key: "env:dragged",
    section: "active" as const,
    groupKey: null,
    ...overrides,
  });
  const resolve = (overItem: SidebarListItem | undefined, activeThread = active()) =>
    resolveSidebarGroupDropTarget({
      activeThread,
      overItem,
      groups,
      threads,
      supportsGroups: true,
    });

  it("offers no group drop where the chat's server cannot run groups", () => {
    const drop = (overItem: SidebarListItem) =>
      resolveSidebarGroupDropTarget({
        activeThread: active(),
        overItem,
        groups,
        threads,
        supportsGroups: false,
      });
    expect(drop({ kind: "group", key: "group:auth", section: "active" })).toBeNull();
    expect(
      drop({ kind: "thread", key: "env:member", section: "active", groupKey: null }),
    ).toBeNull();
  });

  it("joins a group row in any section", () => {
    for (const section of ["pinned", "active", "snoozed", "settled"] as const) {
      expect(resolve({ kind: "group", key: "group:auth", section })).toEqual({
        kind: "join",
        groupKey: "group:auth",
      });
    }
    expect(
      resolve(
        { kind: "group", key: "group:auth", section: "pinned" },
        active({ section: "pinned" }),
      ),
    ).toEqual({ kind: "join", groupKey: "group:auth" });
  });

  it("joins the group of an Active-tree member row", () => {
    expect(
      resolve({ kind: "thread", key: "env:member", section: "active", groupKey: "group:docs" }),
    ).toEqual({ kind: "join", groupKey: "group:docs" });
  });

  it("groups with a lone Active chat", () => {
    expect(resolve({ kind: "thread", key: "env:lone", section: "active", groupKey: null })).toEqual(
      {
        kind: "create-with",
        threadKey: "env:lone",
      },
    );
  });

  it("moves a grouped chat to another group", () => {
    const grouped = active({ groupKey: "group:auth", section: "pinned" });
    expect(resolve({ kind: "group", key: "group:docs", section: "active" }, grouped)).toEqual({
      kind: "join",
      groupKey: "group:docs",
    });
    expect(
      resolve({ kind: "thread", key: "env:lone", section: "active", groupKey: null }, grouped),
    ).toEqual({ kind: "create-with", threadKey: "env:lone" });
  });

  it("is not a group drop onto the chat's own group or its own row", () => {
    const grouped = active({ groupKey: "group:auth" });
    expect(resolve({ kind: "group", key: "group:auth", section: "active" }, grouped)).toBeNull();
    expect(
      resolve(
        { kind: "thread", key: "env:member", section: "active", groupKey: "group:auth" },
        grouped,
      ),
    ).toBeNull();
    expect(resolve({ kind: "thread", key: "env:dragged", section: "active" })).toBeNull();
  });

  it("is not a group drop across projects or environments", () => {
    expect(resolve({ kind: "group", key: "group:other", section: "active" })).toBeNull();
    expect(resolve({ kind: "thread", key: "env:elsewhere", section: "active" })).toBeNull();
    expect(resolve({ kind: "thread", key: "env:remote", section: "active" })).toBeNull();
  });

  it("never groups a subagent", () => {
    expect(
      resolve(
        { kind: "group", key: "group:auth", section: "active" },
        active({ lineage: { relationshipToParent: "subagent" } }),
      ),
    ).toBeNull();
  });

  it("keeps pin and settle drops on Pinned and Settled chat rows", () => {
    expect(resolve({ kind: "thread", key: "env:pinned", section: "pinned" })).toBeNull();
    expect(resolve({ kind: "thread", key: "env:pinned", section: "settled" })).toBeNull();
  });

  it("keeps an ungrouped shelf chat's drop into Active as unpin, un-settle or wake", () => {
    for (const section of ["pinned", "settled", "snoozed"] as const) {
      expect(
        resolve({ kind: "thread", key: "env:lone", section: "active" }, active({ section })),
      ).toBeNull();
    }
  });

  it("joins the hidden group of a lone chat instead of forming a new one", () => {
    const soloGroupId = ThreadGroupId.make("group-solo");
    const soloKey = threadGroupKey({ environmentId: localEnvironmentId, groupId: soloGroupId });
    const drop = (activeThread = active()) =>
      resolveSidebarGroupDropTarget({
        activeThread,
        overItem: { kind: "thread", key: "env:solo", section: "active", groupKey: null },
        groups: new Map([
          ...groups,
          [soloKey, { environmentId: localEnvironmentId, projectId: ProjectId.make("project-a") }],
        ]),
        threads: new Map([...threads, ["env:solo", { ...inProject, groupId: soloGroupId }]]),
        supportsGroups: true,
      });
    expect(drop()).toEqual({ kind: "join", groupKey: soloKey });
    // A grouped chat dragged out of its visible group joins it too.
    expect(drop(active({ groupKey: "group:auth" }))).toEqual({ kind: "join", groupKey: soloKey });
  });

  it("forms a new group with a lone chat whose group is unknown or elsewhere", () => {
    const strayGroupId = ThreadGroupId.make("group-stray");
    const strayKey = threadGroupKey({ environmentId: localEnvironmentId, groupId: strayGroupId });
    const drop = (projectId: string | null) =>
      resolveSidebarGroupDropTarget({
        activeThread: active(),
        overItem: { kind: "thread", key: "env:solo", section: "active", groupKey: null },
        groups:
          projectId === null
            ? groups
            : new Map([
                ...groups,
                [
                  strayKey,
                  { environmentId: localEnvironmentId, projectId: ProjectId.make(projectId) },
                ],
              ]),
        threads: new Map([...threads, ["env:solo", { ...inProject, groupId: strayGroupId }]]),
        supportsGroups: true,
      });
    expect(drop(null)).toEqual({ kind: "create-with", threadKey: "env:solo" });
    expect(drop("project-b")).toEqual({ kind: "create-with", threadKey: "env:solo" });
  });

  it("ignores markers, headings and unknown groups", () => {
    expect(resolve({ kind: "marker", marker: "pinned-divider" })).toBeNull();
    expect(resolve({ kind: "project-heading", key: "project-a" })).toBeNull();
    expect(resolve({ kind: "group", key: "group:gone", section: "active" })).toBeNull();
    expect(resolve(undefined)).toBeNull();
  });
});

describe("resolveSidebarGroupReorder", () => {
  const member = (key: string, groupKey: string | null): SidebarListItem => ({
    kind: "thread",
    key,
    section: "active",
    groupKey,
  });

  it("reorders when a member drops on another member of its own group", () => {
    expect(
      resolveSidebarGroupReorder({
        activeItem: member("env:a", "group:auth"),
        overItem: member("env:b", "group:auth"),
        supportsReorder: true,
      }),
    ).toBe("group:auth");
  });

  it("is not a reorder across groups, onto itself, onto a group row, or without support", () => {
    const resolve = (overItem: SidebarListItem | undefined, supportsReorder = true) =>
      resolveSidebarGroupReorder({
        activeItem: member("env:a", "group:auth"),
        overItem,
        supportsReorder,
      });
    expect(resolve(member("env:b", "group:docs"))).toBeNull();
    expect(resolve(member("env:b", null))).toBeNull();
    expect(resolve(member("env:a", "group:auth"))).toBeNull();
    expect(resolve({ kind: "group", key: "group:auth", section: "active" })).toBeNull();
    expect(resolve(undefined)).toBeNull();
    expect(resolve(member("env:b", "group:auth"), false)).toBeNull();
    expect(
      resolveSidebarGroupReorder({
        activeItem: member("env:a", null),
        overItem: member("env:b", null),
        supportsReorder: true,
      }),
    ).toBeNull();
  });
});

describe("planGroupMemberReorder", () => {
  it("spreads keys over the whole group in its new order when members are keyless", () => {
    const assignments = planGroupMemberReorder({
      orderedIds: ["c", "a", "b"],
      keysById: new Map([
        ["a", null],
        ["b", null],
        ["c", null],
      ]),
      movedId: "c",
    });
    expect(assignments.map(({ id }) => id)).toEqual(["c", "a", "b"]);
    const keys = assignments.map(({ orderKey }) => orderKey);
    expect(keys.toSorted()).toEqual(keys);
  });

  it("writes one key between keyed neighbors", () => {
    const first = pinOrderKeyBetween(null, null)!;
    const second = pinOrderKeyBetween(first, null)!;
    const keysById = new Map([
      ["a", first],
      ["b", second],
      ["c", pinOrderKeyBetween(second, null)!],
    ]);
    const assignments = planGroupMemberReorder({
      orderedIds: ["a", "c", "b"],
      keysById,
      movedId: "c",
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.id).toBe("c");
    expect(assignments[0]!.orderKey > first && assignments[0]!.orderKey < second).toBe(true);
  });
});

describe("resolveSidebarEnvironmentScope", () => {
  const work = { environmentId: EnvironmentId.make("environment-work") };
  const home = { environmentId: EnvironmentId.make("environment-home") };

  it("limits the sidebar to a saved machine", () => {
    expect(resolveSidebarEnvironmentScope([work, home], "environment-work")).toBe(
      work.environmentId,
    );
  });

  it("shows every machine when the saved one is gone or there is only one", () => {
    expect(resolveSidebarEnvironmentScope([work, home], "environment-removed")).toBeNull();
    expect(resolveSidebarEnvironmentScope([work], "environment-work")).toBeNull();
    expect(resolveSidebarEnvironmentScope([work, home], null)).toBeNull();
  });
});
