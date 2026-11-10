import type { ReviewRanOn, ServerProvider } from "@t3tools/contracts";
import { parseReviewPointTag } from "@t3tools/shared/reviewPointTag";

import { getDisplayModelName } from "../../chat/providerIconUtils";

// Shared with mobile; the Review tab's components still import them from here.
export {
  draftUpdateLabel,
  foldPostedReviews,
  offersLocalReview,
  replyTarget,
  reviewApplyLines,
  reviewRoundViews,
  type ReviewRoundView,
  rewritePending,
  sameReviewItem,
  toggledDecision,
  triageButton,
  trimReviewExcerpt,
} from "@t3tools/client-runtime/state/review-sessions";

/** How many messages the user sent with each point attached. */
export function reviewPointMentionCounts(
  messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    readonly createdBy?: string;
    readonly senderThreadId?: string | undefined;
  }>,
): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  for (const message of messages) {
    if (
      message.role !== "user" ||
      (message.createdBy !== undefined && message.createdBy !== "user") ||
      message.senderThreadId !== undefined
    )
      continue;
    const tag = parseReviewPointTag(message.text);
    if (tag !== null) counts.set(tag.number, (counts.get(tag.number) ?? 0) + 1);
  }
  return counts;
}

/** "Claude Opus 5.5" for the model a local review ran on, or its slug when it is unknown here. */
export function ranOnLabel(
  ranOn: ReviewRanOn | null,
  providers: ReadonlyArray<ServerProvider>,
): string | null {
  if (ranOn === null) return null;
  const model = providers
    .find((provider) => provider.instanceId === ranOn.instanceId)
    ?.models.find((candidate) => candidate.slug === ranOn.model);
  return model === undefined ? ranOn.model : getDisplayModelName(model);
}
