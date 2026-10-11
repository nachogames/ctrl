import type { EnvironmentThreadGroup } from "@t3tools/client-runtime/state/models";
import type { ThreadPullRequestLink } from "@t3tools/contracts";

import { useServerConfigs } from "~/state/entities";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { classifyPullRequestChecks } from "../pullRequest/pullRequestDetail.logic";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";

/**
 * The group's pull request as the Group panel and chat header show it: live
 * detail and checks where the environment can read them, else the link's
 * snapshot. `checkStatus` is set only for an open pull request with checks.
 */
export function useGroupPullRequestStatus(
  group: EnvironmentThreadGroup,
  link: ThreadPullRequestLink,
) {
  const capabilities = useServerConfigs().get(group.environmentId)?.environment.capabilities;
  const reference =
    capabilities?.pullRequests === true
      ? {
          projectId: group.projectId,
          host: link.host,
          repository: link.repository,
          number: link.number,
        }
      : null;
  const detail = useEnvironmentQuery(
    reference === null
      ? null
      : pullRequestEnvironment.detail({ environmentId: group.environmentId, input: reference }),
  ).data;
  const checks = useEnvironmentQuery(
    reference !== null && detail !== null && capabilities?.pullRequestChecks === true
      ? pullRequestEnvironment.checks({ environmentId: group.environmentId, input: reference })
      : null,
  ).data;
  const snapshot = link.snapshot;
  const state = detail?.state ?? snapshot?.state ?? null;
  const checksState =
    state === "open" ? classifyPullRequestChecks(checks?.checks ?? detail?.checks ?? []) : "none";
  return {
    title: detail?.title ?? snapshot?.title ?? null,
    presentation:
      state === null
        ? null
        : resolvePullRequestState({
            state,
            isDraft: detail?.isDraft ?? snapshot?.isDraft ?? false,
          }),
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
