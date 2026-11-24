import {
  groupIssues,
  holdIssuePages,
  issueFilterScopes,
  type EnvironmentIssueEntry,
} from "@t3tools/client-runtime/issue-list";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, IssueListInput } from "@t3tools/contracts";

import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { useIssueList } from "~/state/issues";

import type { IssueListPreferences } from "./issueListPreferences";
import { issueListTargets } from "./issuesSearch.logic";

// The most a tracker sends in one page. Closed issues share it: they count toward progress.
const PAGE_SIZE = 200;

/**
 * Issues for the tree and the board. The list always holds every state and person, so parents
 * and progress are whole; the filters the Issues page offers decide which rows show. Whose an
 * issue is comes from a second listing, since a tracker names the viewer only when asked for
 * their issues.
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
  const list = useIssueList(targets);
  const involved = useIssueList(
    filters.who === "all"
      ? []
      : issueListTargets(environmentIds, projects, filters.hideProjects, {
          ...input,
          involvement: filters.who,
        }),
  );
  // Refreshing a list still loading would cancel it and start over, losing the scopes already read.
  useLiveRefresh(
    () => {
      if (!list.isPending) list.reload();
    },
    { key: JSON.stringify(targets) },
  );

  const held = holdIssuePages(list.answers, new Map());
  const groups = groupIssues(held, query, projects, filters.order ?? "updated");
  const involvedUrls = new Set(
    involved.answers.flatMap(([, answer]) => answer.entries.map((entry) => entry.url)),
  );
  const labels = filters.label ?? [];
  const visible = (entry: EnvironmentIssueEntry) =>
    (filters.status === "all" || entry.state.category === filters.status) &&
    (filters.who === "all" || involvedUrls.has(entry.url)) &&
    labels.every((name) => entry.labels.some((label) => label.name === name)) &&
    (!filters.assignee || entry.assignees.some((actor) => actor.login === filters.assignee));

  return {
    list,
    held,
    rows: groups.flatMap((group) => group.rows),
    trackers: groups.map((group) => group.tracker),
    errors: groups.flatMap((group) => group.errors),
    visible,
    /** Still finding whose issues are whose; rows show once it answers. */
    resolvingInvolvement: filters.who !== "all" && involved.isPending,
    filterScopes: issueFilterScopes(held, projects),
  };
}
