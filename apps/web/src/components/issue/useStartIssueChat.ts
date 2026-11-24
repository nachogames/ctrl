import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { msg } from "gt-react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { m } from "~/i18n/messages";
import { useRightPanelStore, type IssueSurfaceTarget } from "~/rightPanelStore";

/**
 * Opens a new chat in the issue's project with the message in its composer and the issue beside
 * it, so the agent's model and mode are still picked before the first send.
 */
export function useStartIssueChat() {
  const newThread = useNewThreadHandler();
  return async (environmentId: EnvironmentId, issue: IssueSurfaceTarget, text: string) => {
    const opened = await newThread(
      scopeProjectRef(environmentId, issue.projectId as ProjectId),
    ).catch(() => null);
    if (opened === null) throw new Error(m(msg("Could not open a chat in this project.")));
    const store = useComposerDraftStore.getState();
    const existing = store.getComposerDraft(opened.draftId)?.prompt.trim() ?? "";
    store.setPrompt(opened.draftId, existing.length > 0 ? `${existing}\n\n${text}` : text);
    useRightPanelStore
      .getState()
      .openIssue(scopeThreadRef(environmentId, opened.threadId), { ...issue, environmentId });
  };
}
