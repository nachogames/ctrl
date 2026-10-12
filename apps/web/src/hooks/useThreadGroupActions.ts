import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadGroupKey } from "@t3tools/client-runtime/state/entities";
import type {
  EnvironmentThreadGroup,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  ThreadGroupId,
  type ThreadGroupUpdatePayload,
  type ThreadId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import {
  groupWithTarget,
  type MoveToGroupCandidate,
  moveWithWorkspaceConfirm,
  workspaceMismatchConfirmMessage,
  workspacesDiffer,
} from "../components/moveToGroupMenu.logic";
import { sidebarActivityMs } from "../components/Sidebar.logic";
import {
  THREAD_HANDOFF_BUSY_HINT,
  THREAD_HANDOFF_PROMPT,
} from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { useRightPanelStore } from "../rightPanelStore";
import {
  readEnvironmentSupportsSettlement,
  readEnvironmentSupportsThreadGroups,
  readThreadShell,
} from "../state/entities";
import { readEnvironmentScope } from "../state/session";
import { readThreadGroup, readThreadGroups, threadGroupCommands } from "../state/threadGroups";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { newMessageId, newThreadGroupId } from "../lib/utils";
import { buildThreadRouteParams } from "../threadRoutes";
import { showThreadUndoNotice } from "./showThreadUndoNotice";
import { applyThreadGroupSettlement } from "./threadGroupSettlement";
import * as ThreadUndo from "./threadUndo";
import { useNewThreadHandler } from "./useHandleNewThread";

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

function toastCommandFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    failureToast(title, squashAtomCommandFailure(result));
  }
}

/**
 * Every menu hides group actions on a server without chat groups; this catches
 * the entry points that cannot (keybindings, stale views) before anything is sent.
 */
function groupsUnavailable(environmentId: EnvironmentThreadShell["environmentId"]): boolean {
  if (readEnvironmentSupportsThreadGroups(environmentId)) return false;
  toastManager.add({
    type: "error",
    title: "Chat groups unavailable",
    description: "This environment's server does not support chat groups. Update it first.",
  });
  return true;
}

/** The group's live chats, in group order. */
function readGroupMembers(group: EnvironmentThreadGroup): EnvironmentThreadShell[] {
  return group.threadIds.flatMap((threadId) => {
    const thread = readThreadShell(scopeThreadRef(group.environmentId, threadId));
    return thread !== null && thread.archivedAt === null ? [thread] : [];
  });
}

/**
 * The groups a chat can move to: its project's groups on its environment,
 * with their newest member activity. Null for a subagent, which belongs to its
 * parent thread rather than a group.
 */
export function readMoveToGroupState(thread: EnvironmentThreadShell): {
  readonly groups: ReadonlyArray<MoveToGroupCandidate>;
  readonly currentGroupId: EnvironmentThreadGroup["id"] | null;
} | null {
  if (thread.lineage.relationshipToParent === "subagent") return null;
  if (!readEnvironmentSupportsThreadGroups(thread.environmentId)) return null;
  const groups = readThreadGroups().filter(
    (group) => group.environmentId === thread.environmentId && group.projectId === thread.projectId,
  );
  return {
    groups: groups.map((group) => ({
      id: group.id,
      title: group.title,
      visible: group.visible,
      activityMs: Math.max(
        Number.NEGATIVE_INFINITY,
        ...readGroupMembers(group).map(sidebarActivityMs),
      ),
    })),
    currentGroupId:
      thread.groupId !== null && groups.some((group) => group.id === thread.groupId)
        ? thread.groupId
        : null,
  };
}

/** Subagents belong to their parent thread, so the server never hands one off. */
export function offersHandOff(thread: Pick<EnvironmentThreadShell, "lineage">): boolean {
  return thread.lineage.relationshipToParent !== "subagent";
}

/** A chat may hand off only between turns; the prompt must not queue behind live work. */
export function canHandOffThread(thread: Pick<EnvironmentThreadShell, "runtime">): boolean {
  return threadRuntimeCanArchive(thread.runtime);
}

/** Asks before a chat moves into a group's workspace; says so when no dialog is available. */
async function confirmWorkspaceSwitch(
  thread: Pick<EnvironmentThreadShell, "title">,
  group: Pick<EnvironmentThreadGroup, "title" | "branch" | "worktreePath">,
): Promise<boolean> {
  const api = readLocalApi();
  if (!api) {
    toastManager.add({
      type: "error",
      title: "Chat not moved",
      description: "Moving it needs a confirmation this window cannot show.",
    });
    return false;
  }
  const confirmed = await settlePromise(() =>
    api.dialogs.confirm(workspaceMismatchConfirmMessage({ chatTitle: thread.title, group })),
  );
  return confirmed._tag === "Success" && confirmed.value;
}

/**
 * Group lifecycle and management, shared by the sidebar (group rows and
 * grouped chat rows) and the chat header menu. Each action reports its own
 * failure with the server's message.
 */
export function useThreadGroupActions() {
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();
  const updateGroup = useOrchestrationCommand(threadGroupCommands.update, {
    reportFailure: false,
  });
  const deleteGroup = useOrchestrationCommand(threadGroupCommands.delete, {
    reportFailure: false,
  });
  const createGroup = useOrchestrationCommand(threadGroupCommands.create, {
    reportFailure: false,
  });
  const moveThreadCommand = useOrchestrationCommand(threadGroupCommands.moveThread, {
    reportFailure: false,
  });
  const recreateWorktreeCommand = useOrchestrationCommand(threadGroupCommands.recreateWorktree, {
    reportFailure: false,
  });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  // Raw commands: a group settle shows one group-level Undo, not one per chat.
  const settleThreadCommand = useOrchestrationCommand(threadEnvironment.settle, {
    reportFailure: false,
  });
  const unsettleThreadCommand = useOrchestrationCommand(threadEnvironment.unsettle, {
    reportFailure: false,
  });

  const patchGroup = useCallback(
    async (group: EnvironmentThreadGroup, patch: ThreadGroupUpdatePayload, failure: string) => {
      const result = await updateGroup({
        environmentId: group.environmentId,
        input: { groupId: group.id, patch },
      });
      if (result._tag === "Success") return true;
      if (!isAtomCommandInterrupted(result))
        failureToast(failure, squashAtomCommandFailure(result));
      return false;
    },
    [updateGroup],
  );

  /** Settle or un-settle the group and its members, with one Undo that reverses both. */
  const setGroupSettled = useCallback(
    async (group: EnvironmentThreadGroup, settled: boolean) => {
      const claim = ThreadUndo.begin(
        "group-settle",
        threadGroupKey({ environmentId: group.environmentId, groupId: group.id }),
      );
      const outcome = await applyThreadGroupSettlement({
        settled,
        now: new Date().toISOString(),
        previousSettledAt: group.settledAt,
        members: readGroupMembers(group),
        settleMembers: readEnvironmentSupportsSettlement(group.environmentId),
        patchSettledAt: (settledAt) =>
          updateGroup({
            environmentId: group.environmentId,
            input: { groupId: group.id, patch: { settledAt } },
          }),
        setMemberSettled: (threadId, memberSettled) =>
          memberSettled
            ? settleThreadCommand({ environmentId: group.environmentId, input: { threadId } })
            : unsettleThreadCommand({
                environmentId: group.environmentId,
                input: { threadId, reason: "user" },
              }),
      });
      if (outcome.kind === "group-failed") {
        claim.finish();
        if (!isAtomCommandInterrupted(outcome.result)) {
          failureToast(
            settled ? "Failed to settle group" : "Failed to un-settle group",
            squashAtomCommandFailure(outcome.result),
          );
        }
        return;
      }
      const { memberFailure } = outcome;
      if (memberFailure !== null) {
        failureToast(
          settled
            ? "Some chats in the group did not settle"
            : "Some chats in the group did not un-settle",
          squashAtomCommandFailure(memberFailure),
        );
      }
      showThreadUndoNotice({
        action: settled ? "Settled" : "Un-settled",
        subject: "group",
        claim,
        undo: outcome.undo,
        failureTitle: settled ? "Failed to undo settle" : "Failed to undo un-settle",
      });
    },
    [settleThreadCommand, unsettleThreadCommand, updateGroup],
  );

  /**
   * Opens a draft on the group's branch and worktree that joins the group on
   * its first send. Every entry point goes through here, so the operate check
   * lives here too.
   */
  const newChatInGroup = useCallback(
    async (group: EnvironmentThreadGroup) => {
      if (groupsUnavailable(group.environmentId)) return;
      if (!readEnvironmentScope(group.environmentId, AuthOrchestrationOperateScope)) {
        toastManager.add({
          type: "error",
          title: "Chat unavailable",
          description: "This connection cannot start chats in this group.",
        });
        return;
      }
      const result = await settlePromise(() =>
        handleNewThread(scopeProjectRef(group.environmentId, group.projectId), {
          branch: group.branch,
          worktreePath: group.worktreePath,
          envMode: group.worktreePath ? "worktree" : "local",
          startFromOrigin: false,
          groupId: group.id,
        }),
      );
      if (result._tag === "Failure") {
        failureToast("Could not create chat", squashAtomCommandFailure(result));
      }
    },
    [handleNewThread],
  );

  /**
   * Moves a chat into `group`. A chat in another workspace asks first, then
   * switches to the group's branch and worktree; declining leaves it in place.
   */
  const moveThreadIntoGroup = useCallback(
    async (
      thread: EnvironmentThreadShell,
      group: Pick<EnvironmentThreadGroup, "id" | "title" | "branch" | "worktreePath">,
    ) => {
      if (groupsUnavailable(thread.environmentId)) return false;
      const outcome = await moveWithWorkspaceConfirm({
        move: (adoptGroupWorkspace) =>
          moveThreadCommand({
            environmentId: thread.environmentId,
            input: {
              threadId: thread.id,
              groupId: group.id,
              ...(adoptGroupWorkspace ? { adoptGroupWorkspace } : {}),
            },
          }),
        failureOf: (result) =>
          result._tag === "Failure" ? squashAtomCommandFailure(result) : undefined,
        confirm: () => confirmWorkspaceSwitch(thread, group),
      });
      if (outcome.kind === "failed") toastCommandFailure("Failed to move chat", outcome.result);
      return outcome.kind === "moved";
    },
    [moveThreadCommand],
  );

  /** Creates a group from `threads`; the first supplies its workspace. */
  const createGroupWith = useCallback(
    async (
      threads: ReadonlyArray<EnvironmentThreadShell>,
      ids: { readonly groupId: ThreadGroupId; readonly commandId?: CommandId } = {
        groupId: newThreadGroupId(),
      },
    ) => {
      const first = threads[0];
      if (first === undefined || groupsUnavailable(first.environmentId)) return null;
      const result = await createGroup({
        environmentId: first.environmentId,
        input: {
          ...(ids.commandId === undefined ? {} : { commandId: ids.commandId }),
          groupId: ids.groupId,
          projectId: first.projectId,
          threadIds: threads.map((thread) => thread.id),
        },
      });
      if (result._tag === "Success") return result.value.group;
      if (!isAtomCommandInterrupted(result)) {
        failureToast("Failed to create group", squashAtomCommandFailure(result));
      }
      return null;
    },
    [createGroup],
  );

  return useMemo(
    () => ({
      newChatInGroup,
      moveThreadIntoGroup,
      /** "Move to group… › <group>": the group must still exist when the menu closes. */
      moveThreadToGroupId: async (thread: EnvironmentThreadShell, groupId: string) => {
        const group = readThreadGroup({
          environmentId: thread.environmentId,
          groupId: ThreadGroupId.make(groupId),
        });
        if (group === null || group.projectId !== thread.projectId) {
          toastManager.add({ type: "warning", title: "That group no longer exists" });
          return;
        }
        await moveThreadIntoGroup(thread, group);
      },
      /**
       * Drag onto a lone chat: group the target first (it keeps its
       * workspace), then move the dragged chat in.
       */
      groupThreadWith: async (target: EnvironmentThreadShell, moved: EnvironmentThreadShell) => {
        if (groupsUnavailable(target.environmentId)) return;
        const groupId = newThreadGroupId();
        const createCommandId = CommandId.make(`thread-group-create:${groupId}`);
        await groupWithTarget({
          needsWorkspaceSwitch: workspacesDiffer(moved, target),
          // The group takes the target's workspace and, before a rename, its branch as title.
          confirm: () =>
            confirmWorkspaceSwitch(moved, {
              title: `“${target.title}”`,
              branch: target.branch,
              worktreePath: target.worktreePath,
            }),
          create: () => createGroupWith([target], { groupId, commandId: createCommandId }),
          move: async (group, adoptGroupWorkspace) => {
            const result = await moveThreadCommand({
              environmentId: moved.environmentId,
              input: {
                threadId: moved.id,
                groupId: group.id,
                ...(adoptGroupWorkspace ? { adoptGroupWorkspace } : {}),
              },
            });
            toastCommandFailure("Failed to move chat", result);
            return result._tag === "Success";
          },
          deleteGroup: async (group) => {
            const result = await deleteGroup({
              environmentId: target.environmentId,
              input: { groupId: group.id, commandId: CommandId.make(`${createCommandId}:undo`) },
            });
            toastCommandFailure("Failed to remove the new group", result);
            return result._tag === "Success";
          },
        });
      },
      removeThreadFromGroup: async (thread: EnvironmentThreadShell) => {
        const result = await moveThreadCommand({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, groupId: null },
        });
        toastCommandFailure("Failed to remove chat from group", result);
      },
      /**
       * Asks the chat's own agent to write the handoff summary: the fixed
       * prompt goes through the normal send path and the agent calls
       * `t3_group_handoff`, which creates the group when needed.
       */
      handOffThread: async (thread: EnvironmentThreadShell) => {
        // Without groups the agent has no t3_group_handoff, so the prompt would waste a turn.
        if (groupsUnavailable(thread.environmentId)) return;
        if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
          toastManager.add({
            type: "error",
            title: "Handoff unavailable",
            description: "This connection cannot send messages to this chat.",
          });
          return;
        }
        if (!offersHandOff(thread)) return;
        if (!canHandOffThread(thread)) {
          toastManager.add({ type: "info", title: `${THREAD_HANDOFF_BUSY_HINT}, then hand off` });
          return;
        }
        const result = await startTurn({
          environmentId: thread.environmentId,
          input: {
            threadId: thread.id,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: THREAD_HANDOFF_PROMPT,
              attachments: [],
            },
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            // A turn that started meanwhile is not steered: the prompt waits for it.
            dispatchMode: "queue",
          },
        });
        toastCommandFailure("Could not hand off", result);
      },
      recreateWorktree: async (group: Pick<EnvironmentThreadGroup, "environmentId" | "id">) => {
        const result = await recreateWorktreeCommand({
          environmentId: group.environmentId,
          input: { groupId: group.id },
        });
        toastCommandFailure("Failed to recreate worktree", result);
      },
      pinGroup: (group: EnvironmentThreadGroup) =>
        patchGroup(group, { pinnedAt: new Date().toISOString() }, "Failed to pin group"),
      unpinGroup: (group: EnvironmentThreadGroup) =>
        patchGroup(group, { pinnedAt: null }, "Failed to unpin group"),
      snoozeGroup: (group: EnvironmentThreadGroup, snoozedUntil: string) =>
        patchGroup(group, { snoozedUntil }, "Failed to snooze group"),
      unsnoozeGroup: (group: EnvironmentThreadGroup) =>
        patchGroup(group, { snoozedUntil: null }, "Failed to wake group"),
      settleGroup: (group: EnvironmentThreadGroup) => setGroupSettled(group, true),
      unsettleGroup: (group: EnvironmentThreadGroup) => setGroupSettled(group, false),
      renameGroup: async (group: EnvironmentThreadGroup, title: string) => {
        const trimmed = title.trim();
        if (trimmed.length === 0) {
          toastManager.add({ type: "warning", title: "Group title cannot be empty" });
          return;
        }
        if (trimmed === group.title) return;
        await patchGroup(group, { title: trimmed }, "Failed to rename group");
      },
      ungroup: async (group: EnvironmentThreadGroup) => {
        const api = readLocalApi();
        if (!api) return;
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(`Ungroup “${group.title}”? Its chats stay where they are.`, {
            variant: "destructive",
          }),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
        const result = await deleteGroup({
          environmentId: group.environmentId,
          input: { groupId: group.id },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          failureToast("Failed to ungroup", squashAtomCommandFailure(result));
        }
      },
      /**
       * Opens the Group surface beside one of the group's chats: `threadId`
       * when given (callers pass the open chat when it is a member), else the
       * most recently active member, navigating there first.
       */
      openGroupPanel: (group: EnvironmentThreadGroup, threadId?: ThreadId) => {
        const target =
          threadId ??
          readGroupMembers(group).toSorted(
            (left, right) => sidebarActivityMs(right) - sidebarActivityMs(left),
          )[0]?.id;
        if (target === undefined) return;
        const ref = scopeThreadRef(group.environmentId, target);
        useRightPanelStore.getState().openGroup(ref);
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(ref),
        });
      },
    }),
    [
      createGroupWith,
      deleteGroup,
      moveThreadCommand,
      moveThreadIntoGroup,
      newChatInGroup,
      patchGroup,
      recreateWorktreeCommand,
      router,
      setGroupSettled,
      startTurn,
    ],
  );
}
