import type { ReviewItem } from "@t3tools/contracts";

/**
 * Whether a review point still needs something. A point with a GitHub thread is open until the
 * thread is resolved. One without a thread (an unposted finding) is open while undecided or
 * decided to fix or post and not yet applied; a skipped or declined one never gets a thread
 * and needs nothing more.
 */
export const isOpenReviewPoint = (
  item: Pick<ReviewItem, "githubState" | "decision" | "applyState">,
): boolean => {
  if (item.githubState !== null) return item.githubState !== "resolved";
  if (item.decision === "decline") return false;
  return item.applyState === "pending" || item.applyState === "working";
};
