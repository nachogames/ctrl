import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadGroup } from "@t3tools/client-runtime/state/models";
import type { ThreadId, ThreadPullRequestLink } from "@t3tools/contracts";
import { ChevronDownIcon, GitBranchIcon, LayersIcon, MessageSquarePlusIcon } from "lucide-react";
import { useMemo } from "react";

import { useThreadGroupActions } from "~/hooks/useThreadGroupActions";
import { cn } from "~/lib/utils";
import { type GroupPanelSection, useRightPanelStore } from "~/rightPanelStore";
import { useThreadShellsForProjectRefs } from "~/state/entities";

import { useGroupPullRequestStatus } from "../group/useGroupPullRequestStatus";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { PullRequestCheckStatusIcon } from "../pullRequest/pullRequestPresentation";
import { Badge } from "../ui/badge";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { groupChatCountLabel } from "./ChatHeaderGroup.logic";

/**
 * The group's unarchived chats in group order, plus `keepThreadId` even when
 * archived (the open chat stays listed and checked). Reads only the group
 * project's shells, so unrelated threads do not re-render the header.
 */
function useGroupMembers(group: EnvironmentThreadGroup, keepThreadId: ThreadId | null = null) {
  const projectRefs = useMemo(
    () => [{ environmentId: group.environmentId, projectId: group.projectId }],
    [group.environmentId, group.projectId],
  );
  const shells = useThreadShellsForProjectRefs(projectRefs);
  return useMemo(() => {
    const byId = new Map(
      shells
        .filter((shell) => shell.environmentId === group.environmentId)
        .map((shell) => [shell.id, shell] as const),
    );
    return group.threadIds.flatMap((threadId) => {
      const member = byId.get(threadId);
      return member !== undefined && (member.archivedAt === null || member.id === keepThreadId)
        ? [member]
        : [];
    });
  }, [group.environmentId, group.threadIds, keepThreadId, shells]);
}

function openGroupSurface(
  group: EnvironmentThreadGroup,
  threadId: ThreadId,
  section: GroupPanelSection | null,
) {
  useRightPanelStore
    .getState()
    .openGroup(scopeThreadRef(group.environmentId, threadId), { section });
}

/**
 * The `[stack] Group ▾ /` breadcrumb segment between the project and the chat
 * title. Its menu switches between the group's chats and opens the Group surface.
 */
export function ChatHeaderGroupItem(props: {
  group: EnvironmentThreadGroup;
  activeThreadId: ThreadId;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const { group } = props;
  return (
    <>
      <WorkspaceBreadcrumbItem>
        <Menu>
          <MenuTrigger
            aria-label={`Group: ${group.title}`}
            render={
              <button
                type="button"
                className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:text-foreground"
              />
            }
          >
            <LayersIcon aria-hidden className="size-3.5 shrink-0" />
            <WorkspaceBreadcrumbText className="max-w-40">{group.title}</WorkspaceBreadcrumbText>
            <ChevronDownIcon aria-hidden className="size-3.5 shrink-0" />
          </MenuTrigger>
          <MenuPopup align="start">
            <ChatHeaderGroupMenuItems {...props} />
          </MenuPopup>
        </Menu>
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbSeparator>
    </>
  );
}

// Mounted only while the menu is open, so chat titles are read on demand.
function ChatHeaderGroupMenuItems(props: {
  group: EnvironmentThreadGroup;
  activeThreadId: ThreadId;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const { group, activeThreadId, onOpenThread } = props;
  const members = useGroupMembers(group, activeThreadId);
  const { newChatInGroup } = useThreadGroupActions();
  return (
    <>
      <MenuRadioGroup
        value={activeThreadId}
        onValueChange={(next) => {
          const member = members.find((candidate) => candidate.id === next);
          if (member !== undefined && member.id !== activeThreadId) onOpenThread(member.id);
        }}
      >
        {members.map((member) => (
          <MenuRadioItem key={member.id} value={member.id} closeOnClick>
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{member.title}</span>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      <MenuSeparator />
      <MenuItem onClick={() => void newChatInGroup(group)}>
        <MessageSquarePlusIcon aria-hidden />
        New chat in group
      </MenuItem>
      <MenuItem onClick={() => openGroupSurface(group, activeThreadId, null)}>
        <LayersIcon aria-hidden />
        Open group panel
      </MenuItem>
    </>
  );
}

/**
 * Branch, pull request and chat-count chips after the breadcrumb; each opens
 * the Group surface at its section. ChatHeader measures this item and, while
 * `visible` is false, keeps it laid out out of flow and invisible so its
 * natural width stays measurable.
 */
export function ChatHeaderGroupChips(props: {
  group: EnvironmentThreadGroup;
  activeThreadId: ThreadId;
  visible: boolean;
}) {
  const { group, activeThreadId, visible } = props;
  const members = useGroupMembers(group);
  const open = (section: GroupPanelSection) => openGroupSurface(group, activeThreadId, section);
  return (
    <li
      data-header-group-chips
      aria-hidden={visible ? undefined : true}
      className={cn(
        "flex w-max shrink-0 items-center gap-1.5",
        !visible && "pointer-events-none invisible absolute",
      )}
    >
      {group.branch !== null ? (
        <Badge
          variant="outline"
          render={
            <button
              type="button"
              aria-label={`Branch ${group.branch}, open group workspace`}
              onClick={() => open("workspace")}
            />
          }
        >
          <GitBranchIcon aria-hidden />
          <span className="min-w-0 max-w-40 truncate">{group.branch}</span>
        </Badge>
      ) : null}
      {group.pullRequest !== null ? (
        <GroupPullRequestChip
          group={group}
          link={group.pullRequest}
          onOpen={() => open("workspace")}
        />
      ) : null}
      <Badge
        variant="outline"
        render={
          <button
            type="button"
            aria-label={`${groupChatCountLabel(members.length)}, open group chats`}
            onClick={() => open("chats")}
          />
        }
      >
        {groupChatCountLabel(members.length)}
      </Badge>
    </li>
  );
}

function GroupPullRequestChip(props: {
  group: EnvironmentThreadGroup;
  link: ThreadPullRequestLink;
  onOpen: () => void;
}) {
  const { presentation, checksState, checkStatus } = useGroupPullRequestStatus(
    props.group,
    props.link,
  );
  const Icon = presentation?.Icon ?? PullRequestGlyph.pullRequest;
  return (
    <Badge
      variant="outline"
      render={
        <button
          type="button"
          aria-label={`Pull request #${props.link.number}${
            checksState === "none" ? "" : `, checks ${checksState}`
          }, open group workspace`}
          onClick={props.onOpen}
        />
      }
    >
      <Icon aria-hidden className={presentation?.toneClassName} />
      <span className="tabular-nums">#{props.link.number}</span>
      {checkStatus !== null ? <PullRequestCheckStatusIcon status={checkStatus} /> : null}
    </Badge>
  );
}
