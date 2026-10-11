import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadGroupKey } from "@t3tools/client-runtime/state/entities";
import type {
  EnvironmentThreadGroup,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ThreadGroupUpdatePayload, ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { sidebarActivityMs } from "../components/Sidebar.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { readEnvironmentSupportsSettlement, readThreadShell } from "../state/entities";
import { threadGroupCommands } from "../state/threadGroups";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { showThreadUndoNotice } from "./showThreadUndoNotice";
import { applyThreadGroupSettlement } from "./threadGroupSettlement";
import * as ThreadUndo from "./threadUndo";

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/** The group's live chats, in group order. */
function readGroupMembers(group: EnvironmentThreadGroup): EnvironmentThreadShell[] {
  return group.threadIds.flatMap((threadId) => {
    const thread = readThreadShell(scopeThreadRef(group.environmentId, threadId));
    return thread !== null && thread.archivedAt === null ? [thread] : [];
  });
}

/**
 * Group lifecycle and management, shared by the sidebar (group rows and
 * grouped chat rows) and the chat header menu. Each action reports its own
 * failure with the server's message.
 */
export function useThreadGroupActions() {
  const router = useRouter();
  const updateGroup = useOrchestrationCommand(threadGroupCommands.update, {
    reportFailure: false,
  });
  const deleteGroup = useOrchestrationCommand(threadGroupCommands.delete, {
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

  return useMemo(
    () => ({
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
       * Opens one of the group's chats: `threadId` when given, else the most
       * recently active member. The Group surface itself lands with the
       * right-panel Group task, which opens it here.
       */
      openGroupPanel: (group: EnvironmentThreadGroup, threadId?: ThreadId) => {
        const target =
          threadId ??
          readGroupMembers(group).toSorted(
            (left, right) => sidebarActivityMs(right) - sidebarActivityMs(left),
          )[0]?.id;
        if (target === undefined) return;
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(group.environmentId, target)),
        });
      },
    }),
    [deleteGroup, patchGroup, router, setGroupSettled],
  );
}
