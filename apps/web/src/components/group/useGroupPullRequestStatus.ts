import type { EnvironmentThreadGroup } from "@t3tools/client-runtime/state/models";
import type { ThreadPullRequestLink } from "@t3tools/contracts";

import { useServerConfigs } from "~/state/entities";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import {
  classifyPullRequestChecks,
  describePullRequestChecks,
} from "../pullRequest/pullRequestDetail.logic";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";

/**
 * The group's pull request as the Group panel and chat header show it: live
 * detail and checks where the environment can read them, else the link's
 * snapshot. `checkStatus` and `checksText` are set only for an open pull
 * request with checks. A null `link` reads nothing and reports nothing.
 */
export function useGroupPullRequestStatus(
  group: Pick<EnvironmentThreadGroup, "environmentId" | "projectId">,
  link: ThreadPullRequestLink | null,
) {
  const capabilities = useServerConfigs().get(group.environmentId)?.environment.capabilities;
  const reference =
    link !== null && capabilities?.pullRequests === true
      ? {
          projectId: group.projectId,
          host: link.host,
          repository: link.repository,
          number: link.number,
        }
      : null;
  const detailQuery = useEnvironmentQuery(
    reference === null
      ? null
      : pullRequestEnvironment.detail({ environmentId: group.environmentId, input: reference }),
  );
  const detail = detailQuery.data;
  const checks = useEnvironmentQuery(
    reference !== null && detail !== null && capabilities?.pullRequestChecks === true
      ? pullRequestEnvironment.checks({ environmentId: group.environmentId, input: reference })
      : null,
  ).data;
  const snapshot = link?.snapshot ?? null;
  const state = detail?.state ?? snapshot?.state ?? null;
  const isDraft = detail?.isDraft ?? snapshot?.isDraft ?? false;
  const checkList = checks?.checks ?? detail?.checks ?? [];
  const checksState = state === "open" ? classifyPullRequestChecks(checkList) : "none";
  return {
    title: detail?.title ?? snapshot?.title ?? null,
    presentation:
      state === null
        ? null
        : resolvePullRequestState({
            state,
            isDraft,
          }),
    state: state === null ? null : state === "open" && isDraft ? ("draft" as const) : state,
    checksText:
      state === "open" && checkList.length > 0 ? describePullRequestChecks(checkList) : null,
    // Errors reach the client as text, so any failed detail read reads as signed out.
    signInRequired: reference !== null && detail === null && detailQuery.error !== null,
    checksState,
    checkStatus:
      checksState === "none"
        ? null
        : checksState === "failing"
          ? ("failure" as const)
          : checksState === "pending"
            ? ("pending" as const)
            : ("success" as const),
  };
}
