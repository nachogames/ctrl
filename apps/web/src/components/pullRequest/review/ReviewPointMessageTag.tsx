import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "~/rightPanelStore";
import { InlineButton } from "../../ui/button";
import { useReviewPointFocusStore } from "./reviewPointFocusStore";

/**
 * The point a sent message was about, above its bubble. When this window knows the review
 * chat's pull request, it opens that point in the Review tab.
 */
export function ReviewPointMessageTag({
  threadRef,
  tag,
}: {
  threadRef: ScopedThreadRef | null;
  tag: { readonly number: number; readonly label: string };
}) {
  const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
  const target = useReviewPointFocusStore((state) =>
    threadKey === null ? undefined : state.reviewChats[threadKey],
  );
  const label = (
    <>
      <span className="font-mono">#{tag.number}</span> {tag.label}
    </>
  );
  if (threadRef === null || threadKey === null || target === undefined) {
    return (
      <p className="me-1 text-2xs text-muted-foreground" data-review-point-tag={tag.number}>
        {label}
      </p>
    );
  }
  return (
    <p className="me-1 text-2xs" data-review-point-tag={tag.number}>
      <InlineButton
        tone="muted"
        aria-label={`Open #${tag.number} in the Review tab`}
        onClick={() => {
          const store = useReviewPointFocusStore.getState();
          store.openPoint(threadKey, { number: tag.number, label: tag.label });
          store.requestOpen(threadKey, tag.number);
          useRightPanelStore.getState().openPullRequest(threadRef, {
            environmentId: target.environmentId,
            projectId: target.projectId,
            host: target.host,
            repository: target.repository,
            number: target.number,
            url: target.url,
          });
        }}
      >
        {label}
      </InlineButton>
    </p>
  );
}
