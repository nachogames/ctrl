import {
  continueIssuePage,
  groupIssues,
  holdIssuePages,
  issueCursorsForHost,
  issueFilterScopes,
  type EnvironmentIssueEntry,
  type HeldIssuePage,
} from "@t3tools/client-runtime/issue-list";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, IssueListInput } from "@t3tools/contracts";
import { msg } from "gt-react";
import { useState } from "react";

import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { m } from "~/i18n/messages";
import { issueEnvironment, useIssueList, type IssueListTarget } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";

import { pullRequestProjectKey } from "../pullRequest/PullRequestListFilters";
import type { IssueListPreferences } from "./issueListPreferences";
import { issueListTargets, issueProjectKeys } from "./issuesSearch.logic";

// The most a tracker sends in one page. Closed issues share it: they count toward progress.
const PAGE_SIZE = 200;

/** A listing and the pages "Load more" has added to it, per environment. */
function usePagedIssueList(targets: ReadonlyArray<IssueListTarget>) {
  const list = useIssueList(targets);
  const [pages, setPages] = useState<ReadonlyMap<EnvironmentId, HeldIssuePage>>(new Map());
  const held = holdIssuePages(list.answers, pages);
  const loadPage = useAtomCommand(issueEnvironment.listPage, { reportFailure: false });
  // One tracker's next page, from that tracker's own cursors; nothing when it has no more.
  const loadNext = async (environmentId: EnvironmentId, host: string) => {
    const page = held.get(environmentId);
    const cursors = page ? issueCursorsForHost(page.nextCursors, host) : {};
    const target = targets.find((entry) => entry.environmentId === environmentId)?.input;
    if (!page || !target || Object.keys(cursors).length === 0) return;
    const result = await loadPage({ environmentId, input: { ...target, cursors } });
    const failure = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
    setPages((current) =>
      new Map(current).set(
        environmentId,
        continueIssuePage(
          page,
          result._tag === "Failure"
            ? {
                failure:
                  failure instanceof Error ? failure.message : m(msg("The next page failed.")),
              }
            : result.value,
          cursors,
        ),
      ),
    );
  };
  return { list, held, loadNext };
}

/**
 * Issues for the tree and the board. The list always holds every state and person, so parents
 * and progress are whole; the filters the Issues page offers decide which rows show. Whose an
 * issue is comes from a second listing, since a tracker names the viewer only when asked for
 * their issues; "Load more" pages both together.
 */
export function useIssueBrowserData({
  environmentIds,
  projects,
  filters,
  query,
}: {
  environmentIds: ReadonlyArray<EnvironmentId>;
  projects: ReadonlyArray<EnvironmentProject>;
  filters: IssueListPreferences;
  query: string;
}) {
  const input: IssueListInput = {
    state: "all",
    involvement: "all",
    limit: PAGE_SIZE,
    ...(filters.host ? { host: filters.host } : {}),
    ...(query ? { query } : {}),
    ...(filters.order ? { sort: filters.order } : {}),
  };
  const targets = issueListTargets(environmentIds, projects, filters.hideProjects, input);
  const main = usePagedIssueList(targets);
  const narrowed = filters.who !== "all";
  const involved = usePagedIssueList(
    narrowed
      ? issueListTargets(environmentIds, projects, filters.hideProjects, {
          ...input,
          involvement: filters.who,
        })
      : [],
  );
  const { list, held } = main;
  // Refreshing a list still loading would cancel it and start over, losing the scopes already read.
  useLiveRefresh(
    () => {
      if (!list.isPending) list.reload();
      if (narrowed && !involved.list.isPending) involved.list.reload();
    },
    { key: JSON.stringify(targets) },
  );

  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  const loadMore = async (environmentId: EnvironmentId, host: string) => {
    if (loadingMore !== null) return;
    setLoadingMore(`${environmentId} ${host}`);
    await Promise.all([
      main.loadNext(environmentId, host),
      narrowed ? involved.loadNext(environmentId, host) : undefined,
    ]);
    setLoadingMore(null);
  };

  const groups = groupIssues(held, query, projects, filters.order ?? "updated");
  const involvedGroups = narrowed
    ? groupIssues(involved.held, query, projects, filters.order ?? "updated")
    : [];
  const involvedUrls = new Set(involvedGroups.flatMap((group) => group.rows.map((row) => row.url)));
  const labels = filters.label ?? [];
  const visible = (entry: EnvironmentIssueEntry) =>
    (filters.status === "all" || entry.state.category === filters.status) &&
    (!narrowed || involvedUrls.has(entry.url)) &&
    labels.every((name) => entry.labels.some((label) => label.name === name)) &&
    (!filters.assignee || entry.assignees.some((actor) => actor.login === filters.assignee));

  const hidden = issueProjectKeys(filters.hideProjects);
  const moreKeys = new Set<string>();
  const more = [...groups, ...involvedGroups].flatMap((group) =>
    group.more.flatMap((environmentId) => {
      const key = `${environmentId} ${group.tracker.host}`;
      if (moreKeys.has(key)) return [];
      moreKeys.add(key);
      return [
        {
          environmentId,
          host: group.tracker.host,
          failure:
            held.get(environmentId)?.moreFailure ??
            involved.held.get(environmentId)?.moreFailure ??
            null,
        },
      ];
    }),
  );

  return {
    list,
    held,
    rows: groups.flatMap((group) => group.rows),
    trackers: groups.map((group) => group.tracker),
    // The involvement listing decides which rows show, so its failures are listed too.
    errors: [
      ...groups.flatMap((group) => group.errors),
      ...involvedGroups.flatMap((group) => group.errors),
      ...(narrowed && involved.list.error
        ? [{ projectTitle: m(msg("Your issues")), message: involved.list.error }]
        : []),
    ],
    visible,
    /** Still finding whose issues are whose; rows show once it answers. */
    resolvingInvolvement: narrowed && involved.list.isPending,
    filterScopes: issueFilterScopes(
      held,
      projects.filter((project) => !hidden.has(pullRequestProjectKey(project))),
    ),
    /** Trackers with issues past what is loaded, each with why its last next page failed. */
    more,
    loadMore,
    loadingMore,
  };
}
