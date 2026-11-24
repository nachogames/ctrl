import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { IssueTrackerKind, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { XIcon } from "lucide-react";
import type { PointerEvent } from "react";

import { useRightPanelStore } from "~/rightPanelStore";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";

import { ComposerBanner } from "../chat/ComposerBanner";
import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { IssueGlyph } from "./issuePresentation";
import { focusedIssueSurface, useIssueFocusStore } from "./issueFocus";

// Clicks on the chip keep the caret in the composer.
const keepComposerFocus = (event: PointerEvent) => event.preventDefault();

/**
 * The issue open in the chat's right panel, which the chat's next messages are about. × leaves
 * it open but sends messages about nothing; the dashed chip attaches it again.
 */
export function IssueFocusComposerChip({ threadRef }: { threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const threadKey = scopedThreadKey(threadRef);
  const surface = useRightPanelStore((state) => focusedIssueSurface(state.byThreadKey, threadRef));
  const detached = useIssueFocusStore(
    (state) => surface !== null && state.detached[threadKey] === surface.id,
  );
  const environmentId = threadRef.environmentId;
  const detail = useEnvironmentQuery(
    surface === null || (surface.environmentId ?? environmentId) !== environmentId
      ? null
      : issueEnvironment.detail({
          environmentId,
          input: {
            projectId: surface.projectId as ProjectId,
            tracker: surface.tracker as IssueTrackerKind,
            ...(surface.host ? { host: surface.host } : {}),
            scope: surface.scope,
            key: surface.key,
          },
        }),
  );
  if (surface === null) return null;
  const title = detail.data?.title;
  const name = surface.key;
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root data-issue-focus-chip={detached ? "detached" : "attached"}>
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <IssueGlyph.issue />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            {detached ? (
              <ContextChip
                kind="review-comment"
                state="unresolved"
                render={<button type="button" />}
                aria-label={gt("Talk about {issue} again", { issue: name })}
                onPointerDown={keepComposerFocus}
                onClick={() => useIssueFocusStore.getState().attach(threadKey)}
              >
                <ContextChipLabel>+ {name}</ContextChipLabel>
              </ContextChip>
            ) : (
              <ContextChip kind="review-comment">
                <ContextChipLabel>{name}</ContextChipLabel>
                <ContextChipAction
                  aria-label={gt("Stop talking about {issue}", { issue: name })}
                  onPointerDown={keepComposerFocus}
                  onClick={() => useIssueFocusStore.getState().detach(threadKey, surface.id)}
                >
                  <XIcon aria-hidden="true" />
                </ContextChipAction>
              </ContextChip>
            )}
            <span className="min-w-0 truncate text-muted-foreground">
              {detached ? (
                <T>Messages are about no issue</T>
              ) : title ? (
                title
              ) : (
                <T>Ask about this issue, or tell me what to change</T>
              )}
            </span>
          </ComposerBanner.Content>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
