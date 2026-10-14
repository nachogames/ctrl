import type { EnvironmentId, PullRequestDetailView } from "@t3tools/contracts";
import { Button } from "../../ui/button";
import { PullRequestMarkdown } from "../PullRequestMarkdown";

/** Host feedback is readable without creating a chat or starting an agent. */
export function HostPullRequestReview({
  detail,
  environmentId,
  loading,
  error,
  onRetry,
  onSetup,
}: {
  detail: PullRequestDetailView;
  environmentId: EnvironmentId;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onSetup: () => void;
}) {
  const reviews = detail.comments.filter((comment) => comment.kind === "review");
  const open = detail.reviewThreads.filter((thread) => !thread.isResolved);
  const resolved = detail.reviewThreads.filter((thread) => thread.isResolved);
  return (
    <div className="h-full overflow-auto p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-sm text-muted-foreground">
          Read reviews here without a chat. Link a chat for AI triage and discussion.
        </p>
        <Button size="sm" variant="outline" onClick={onSetup}>
          Set up shared review
        </Button>
      </div>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading reviews…</p>
      ) : error ? (
        <div className="space-y-2">
          <p className="text-sm">{error}</p>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {open.length} open · {resolved.length} resolved
          </p>
          {detail.reviewThreadsTruncated || detail.commentsTruncated ? (
            <p className="text-sm text-muted-foreground">
              Some feedback is not loaded. Open the pull request on its host for the full history.
            </p>
          ) : null}
          {reviews.length === 0 && detail.reviewThreads.length === 0 ? (
            <p className="text-sm text-muted-foreground">No reviews yet.</p>
          ) : null}
          {reviews.map((review) => (
            <details key={review.id} className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm font-medium">
                {review.author?.login ?? "Reviewer"} · {review.reviewState ?? "Review"} ·{" "}
                {review.createdAt.slice(0, 10)}
              </summary>
              <div className="pt-3">
                <PullRequestMarkdown
                  text={review.body}
                  cwd={detail.workspaceRoot}
                  environmentId={environmentId}
                />
              </div>
            </details>
          ))}
          {[...open, ...resolved].map((thread) => (
            <details key={thread.id} open={!thread.isResolved} className="rounded-md border p-3">
              <summary className="cursor-pointer break-all text-sm font-medium">
                {thread.path}
                {thread.line === null ? "" : `:${thread.line}`} ·{" "}
                {thread.isResolved ? "Resolved" : "Open"}
                {thread.isOutdated ? " · Outdated" : ""}
              </summary>
              {thread.comments.map((comment) => (
                <div key={comment.id} className="space-y-2 border-t mt-3 pt-3">
                  <p className="text-xs text-muted-foreground">
                    {comment.author?.login ?? "Reviewer"} · {comment.createdAt.slice(0, 10)}
                  </p>
                  <PullRequestMarkdown
                    text={comment.body}
                    cwd={detail.workspaceRoot}
                    environmentId={environmentId}
                  />
                </div>
              ))}
              {thread.nextCommentsCursor ? (
                <p className="pt-2 text-xs text-muted-foreground">
                  More replies are available on the pull request.
                </p>
              ) : null}
            </details>
          ))}
        </>
      )}
    </div>
  );
}
