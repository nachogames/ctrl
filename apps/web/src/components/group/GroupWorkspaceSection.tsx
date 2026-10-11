import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadGroup } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { FolderIcon, GitBranchIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo } from "react";

import { useOpenInPreferredEditor } from "~/editorPreferences";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useProject, useServerConfigs } from "~/state/entities";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { primaryServerAvailableEditorsAtom } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { vcsEnvironment } from "~/state/vcs";

import { classifyPullRequestChecks } from "../pullRequest/pullRequestDetail.logic";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import {
  PullRequestCheckStatusIcon,
  resolvePullRequestState,
} from "../pullRequest/pullRequestPresentation";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { groupWorkspaceLabel } from "./GroupPanel.logic";

const ROW_CLASS =
  "flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-sm text-foreground";
const ROW_BUTTON_CLASS = cn(ROW_CLASS, "cursor-pointer hover:bg-accent/60 disabled:cursor-default");
const ICON_CLASS = "size-3.5 shrink-0 text-muted-foreground";

/** Branch with ahead count vs base, worktree path, and the group's pull request. */
export function GroupWorkspaceSection(props: {
  group: EnvironmentThreadGroup;
  threadRef: ScopedThreadRef;
}) {
  const { group } = props;
  const project = useProject(
    useMemo(
      () => ({ environmentId: group.environmentId, projectId: group.projectId }),
      [group.environmentId, group.projectId],
    ),
  );
  const cwd = group.worktreePath ?? project?.workspaceRoot ?? null;
  const status = useEnvironmentQuery(
    cwd === null
      ? null
      : vcsEnvironment.status({
          environmentId: group.environmentId,
          input: { cwd, includeRemote: false },
        }),
  );
  // A deleted worktree fails the status read (or no longer reads as a checkout).
  const missing =
    cwd !== null &&
    ((status.data === null && status.error !== null) || status.data?.isRepo === false);
  const branchLabel = groupWorkspaceLabel({
    branch: group.branch ?? status.data?.refName ?? null,
    baseRef: status.data?.branchChanges?.baseRef ?? null,
    aheadOfDefaultCount: status.data?.aheadOfDefaultCount ?? null,
  });

  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const canOpenEditor = useEnvironmentScope(group.environmentId, AuthOrchestrationOperateScope);
  const openInEditor = useOpenInPreferredEditor(group.environmentId, availableEditors);
  const openWorkspace = async () => {
    if (cwd === null) return;
    const result = await openInEditor(cwd);
    if (result._tag === "Success") return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to open the workspace",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };

  return (
    <div className="flex flex-col gap-0.5">
      {branchLabel !== null ? (
        <div className={ROW_CLASS}>
          <GitBranchIcon aria-hidden className={ICON_CLASS} />
          <span className="min-w-0 truncate">{branchLabel}</span>
        </div>
      ) : null}
      {cwd !== null ? (
        <button
          type="button"
          className={ROW_BUTTON_CLASS}
          disabled={missing || !canOpenEditor || availableEditors.length === 0}
          aria-label={`Open ${cwd} in editor`}
          onClick={() => void openWorkspace()}
        >
          <FolderIcon aria-hidden className={ICON_CLASS} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{cwd}</span>
        </button>
      ) : null}
      {missing ? (
        <div className={cn(ROW_CLASS, "text-warning-foreground")}>
          <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">Workspace missing</span>
        </div>
      ) : null}
      {group.pullRequest !== null ? (
        <GroupPullRequestRow group={group} link={group.pullRequest} threadRef={props.threadRef} />
      ) : null}
    </div>
  );
}

/** `#412 Title  open · checks ✓`; opens the Pull request surface beside the chat. */
function GroupPullRequestRow(props: {
  group: EnvironmentThreadGroup;
  link: ThreadPullRequestLink;
  threadRef: ScopedThreadRef;
}) {
  const { group, link } = props;
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
  const title = detail?.title ?? snapshot?.title ?? null;
  const state = detail?.state ?? snapshot?.state ?? null;
  const presentation =
    state === null
      ? null
      : resolvePullRequestState({
          state,
          isDraft: detail?.isDraft ?? snapshot?.isDraft ?? false,
        });
  const checksState =
    state === "open" ? classifyPullRequestChecks(checks?.checks ?? detail?.checks ?? []) : "none";
  const Icon = presentation?.Icon ?? PullRequestGlyph.pullRequest;

  return (
    <button
      type="button"
      className={ROW_BUTTON_CLASS}
      onClick={() =>
        useRightPanelStore.getState().openPullRequest(props.threadRef, {
          projectId: group.projectId,
          host: link.host,
          repository: link.repository,
          number: link.number,
          url: link.url,
        })
      }
    >
      <Icon aria-hidden className={ICON_CLASS} />
      <span className="shrink-0 tabular-nums">#{link.number}</span>
      {title !== null ? <span className="min-w-0 truncate">{title}</span> : null}
      {presentation !== null ? (
        <span
          className={cn(
            "ms-auto flex shrink-0 items-center gap-1 text-xs",
            presentation.toneClassName,
          )}
        >
          {presentation.label.toLowerCase()}
          {checksState !== "none" ? (
            <>
              <span aria-hidden>·</span>
              <span className="sr-only">checks {checksState}</span>
              <PullRequestCheckStatusIcon
                status={
                  checksState === "failing"
                    ? "failure"
                    : checksState === "pending"
                      ? "pending"
                      : "success"
                }
              />
            </>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}
