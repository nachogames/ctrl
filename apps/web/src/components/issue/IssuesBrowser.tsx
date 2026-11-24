import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { IssueProgress } from "@t3tools/client-runtime/issue-board";
import type { EnvironmentIssueEntry } from "@t3tools/client-runtime/issue-list";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironments } from "~/state/environments";
import { useProjects } from "~/state/entities";
import { useDebouncedValue } from "~/state/queries";

import { PullRequestListGhost } from "../pullRequest/PullRequestGhosts";
import { PullRequestSearchInput } from "../pullRequest/PullRequestListFilters";
import { resolveFilterOptions } from "../pullRequest/pullRequestListOptions";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { IssueBoard } from "./IssueBoard";
import { ISSUE_INVOLVEMENT_OPTIONS, ISSUE_STATE_OPTIONS } from "./issueFilterOptions";
import { IssueFiltersMenu } from "./IssueListFilterPickers";
import {
  issueListPreferences,
  readIssueListPreferences,
  writeIssueListPreferences,
  type IssueListPreferences,
} from "./issueListPreferences";
import { IssueRow } from "./IssueRow";
import { issueFilterProjects, issueProjectKeys } from "./issuesSearch.logic";
import { IssueTreeList } from "./IssueTreeList";
import { issuesPanelMemory, rememberIssuesPanel } from "./issuesPanelMemory";
import { useIssueBrowserData } from "./useIssueBrowserData";

export type IssuesView = "tree" | "board";

const VIEW_STORAGE_KEY = "t3.issues.panel";

function readPanelView(): IssuesView {
  try {
    return JSON.parse(window.localStorage.getItem(VIEW_STORAGE_KEY) ?? "{}").view === "board"
      ? "board"
      : "tree";
  } catch {
    return "tree";
  }
}

function writePanelView(view: IssuesView) {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ view }));
  } catch {
    // Storage can be full or forbidden; the panel still works for this visit.
  }
}

/** Tree or board: the switch both the Issues page and the chat panel show. */
export function IssuesViewToggle({
  view,
  onView,
}: {
  view: IssuesView;
  onView: (view: IssuesView) => void;
}) {
  const gt = useGT();
  return (
    <ToggleGroup
      aria-label={gt("Issue view")}
      value={[view]}
      onValueChange={(next) => {
        if (next[0] === "tree" || next[0] === "board") onView(next[0]);
      }}
    >
      <Toggle value="tree">
        <T context="issue view that nests issues as a tree">Tree</T>
      </Toggle>
      <Toggle value="board">
        <T context="issue view with status columns">Board</T>
      </Toggle>
    </ToggleGroup>
  );
}

/**
 * Issues as a tree or a board, scrolled where they were left. `visible` hides rows; parents and
 * progress still come from every row.
 */
export function IssuesBrowser({
  rows,
  visible,
  view,
  memoryKey,
  loading,
  notices,
  footer,
  hasMore = false,
  isSelected,
  environmentLabel,
  onSelect,
}: {
  rows: ReadonlyArray<EnvironmentIssueEntry>;
  visible: (entry: EnvironmentIssueEntry) => boolean;
  view: IssuesView;
  /** Where the scroll and folds are remembered while the browser is not shown. */
  memoryKey: string;
  loading: boolean;
  notices?: ReactNode;
  /** Under the list, such as a tracker's next page. */
  footer?: ReactNode;
  /** More issues exist than are loaded, so an empty list is not the whole answer. */
  hasMore?: boolean;
  /** The row open beside the list, highlighted. */
  isSelected?: (entry: EnvironmentIssueEntry) => boolean;
  /** Which server a row came from, when several are listed. */
  environmentLabel?: (entry: EnvironmentIssueEntry) => string | undefined;
  onSelect: (entry: EnvironmentIssueEntry) => void;
}) {
  const [remembered] = useState(() => issuesPanelMemory(memoryKey));
  const [folded, setFoldedState] = useState(remembered.folded);
  const setFolded = (next: ReadonlySet<string>) => {
    rememberIssuesPanel(memoryKey, { folded: next });
    setFoldedState(next);
  };
  const scrollerRef = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const hasRows = rows.length > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- puts the scroller back where it was before the browser unmounted, once its rows render
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (restored.current || !hasRows || scroller === null) return;
    restored.current = true;
    scroller.scrollTo({ top: remembered.scrollTop, left: remembered.scrollLeft });
  }, [hasRows, remembered]);

  const renderRow = (
    row: EnvironmentIssueEntry,
    depth: number,
    progress: IssueProgress | null = null,
  ) => (
    <IssueRow
      key={`${row.environmentId}:${row.url}`}
      entry={row}
      selected={isSelected?.(row) ?? false}
      environmentLabel={environmentLabel?.(row)}
      showScope={false}
      showTracker={false}
      showParent={depth === 0}
      progress={progress}
      onSelect={() => onSelect(row)}
    />
  );
  const anyShown = rows.some(visible);

  return (
    // One scroller for both directions, so the board's sticky headers have a frame to stick to.
    <div
      ref={scrollerRef}
      className={cn("min-h-0 flex-1 overflow-auto", view === "tree" && "p-2")}
      onScroll={(event) => {
        rememberIssuesPanel(memoryKey, {
          scrollTop: event.currentTarget.scrollTop,
          scrollLeft: event.currentTarget.scrollLeft,
        });
      }}
    >
      {notices}
      {!hasRows && loading ? (
        <PullRequestListGhost />
      ) : !anyShown ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">
          {loading ? (
            <T>Loading…</T>
          ) : hasMore ? (
            <T>None of the issues loaded so far match these filters.</T>
          ) : (
            <T>No issues under these filters.</T>
          )}
        </p>
      ) : view === "board" ? (
        <IssueBoard rows={rows} visible={visible} onSelect={onSelect} />
      ) : (
        <IssueTreeList
          rows={rows}
          renderRow={renderRow}
          visible={visible}
          folded={folded}
          onFoldedChange={setFolded}
        />
      )}
      {footer}
    </div>
  );
}

/** A button per tracker that has issues past what is loaded, with why its last try failed. */
export function IssueLoadMore({
  more,
  loadingMore,
  onLoadMore,
}: {
  more: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly host: string;
    readonly failure: string | null;
  }>;
  loadingMore: string | null;
  onLoadMore: (environmentId: EnvironmentId, host: string) => void;
}) {
  if (more.length === 0) return null;
  return (
    <div className="sticky left-0 flex w-fit flex-col items-start gap-1 px-2 py-2">
      {more.map(({ environmentId, host, failure }) => (
        <Fragment key={`${environmentId} ${host}`}>
          {failure === null ? null : <p className="text-xs text-destructive">{failure}</p>}
          <Button
            size="sm"
            variant="ghost-muted"
            disabled={loadingMore !== null}
            onClick={() => onLoadMore(environmentId, host)}
          >
            {loadingMore === `${environmentId} ${host}` ? (
              <T>Loading…</T>
            ) : failure === null ? (
              more.length > 1 ? (
                <T>
                  Load more from <Var>{host}</Var>
                </T>
              ) : (
                <T>Load more</T>
              )
            ) : (
              <T>Retry</T>
            )}
          </Button>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The issues beside a chat, with the Issues page's filters (shared with it). Opening an issue
 * shows it in the chat's panel and focuses the chat on it.
 */
export function ThreadIssuesPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const resolve = useMessages();
  const environmentId = threadRef.environmentId;
  const threadKey = scopedThreadKey(threadRef);
  const { environments } = useEnvironments();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [filters, setFiltersState] = useState(readIssueListPreferences);
  const setFilters = (patch: Partial<IssueListPreferences>) => {
    const next = issueListPreferences({ ...filters, ...patch });
    writeIssueListPreferences(next);
    setFiltersState(next);
  };
  const [view, setViewState] = useState(readPanelView);
  const [query, setQueryState] = useState(() => issuesPanelMemory(threadKey).query);
  const setQuery = (next: string) => {
    rememberIssuesPanel(threadKey, { query: next });
    setQueryState(next);
  };
  const debouncedQuery = useDebouncedValue(query, 300);
  const data = useIssueBrowserData({
    environmentIds: [environmentId],
    projects,
    filters,
    query: debouncedQuery,
  });
  const filterProjects = issueFilterProjects(
    projects,
    new Map(environments.map((e) => [e.environmentId, e.label] as const)),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <IssuesViewToggle
          view={view}
          onView={(next) => {
            writePanelView(next);
            setViewState(next);
          }}
        />
        <div className="min-w-40 flex-1">
          <PullRequestSearchInput
            value={query}
            label={gt("Search issues")}
            placeholder={gt("Search issues")}
            busy={query !== debouncedQuery || (debouncedQuery.length > 0 && data.list.isPending)}
            onChange={setQuery}
            onSubmit={setQuery}
          />
        </div>
        <IssueFiltersMenu
          state={filters.status}
          stateOptions={resolveFilterOptions(ISSUE_STATE_OPTIONS, resolve)}
          onState={(status) => setFilters({ status })}
          involvement={filters.who}
          involvementOptions={resolveFilterOptions(ISSUE_INVOLVEMENT_OPTIONS, resolve)}
          onInvolvement={(who) => setFilters({ who })}
          scopes={data.filterScopes}
          labels={filters.label ?? []}
          onLabels={(label) => setFilters({ label })}
          assignee={filters.assignee}
          onAssignee={(assignee) => setFilters({ assignee })}
          projects={filterProjects}
          hiddenProjects={issueProjectKeys(filters.hideProjects)}
          onHiddenProjects={(hideProjects) => setFilters({ hideProjects })}
        />
        <Button
          size="icon"
          variant="outline"
          aria-label={gt("Refresh issues")}
          onClick={data.list.refresh}
          disabled={data.list.isPending}
        >
          <RefreshIcon size="md" refreshing={data.list.isPending} />
        </Button>
      </div>
      <IssuesBrowser
        rows={data.rows}
        visible={data.visible}
        view={view}
        memoryKey={threadKey}
        loading={data.list.isPending || data.resolvingInvolvement}
        notices={<IssueBrowserNotices error={data.list.error} errors={data.errors} />}
        hasMore={data.more.length > 0}
        footer={
          <IssueLoadMore
            more={data.more}
            loadingMore={data.loadingMore}
            onLoadMore={(environmentId, host) => void data.loadMore(environmentId, host)}
          />
        }
        onSelect={(entry) => useRightPanelStore.getState().openIssue(threadRef, entry)}
      />
    </div>
  );
}

export function IssueBrowserNotices({
  error,
  errors,
}: {
  error: string | null;
  errors: ReadonlyArray<{ readonly projectTitle: string; readonly message: string }>;
}) {
  return (
    <>
      {error ? <p className="px-3 py-1 text-xs text-destructive">{error}</p> : null}
      {errors.map((failure) => (
        <p key={failure.projectTitle} className="px-3 py-1 text-xs text-destructive">
          {failure.projectTitle}: {failure.message}
        </p>
      ))}
    </>
  );
}
