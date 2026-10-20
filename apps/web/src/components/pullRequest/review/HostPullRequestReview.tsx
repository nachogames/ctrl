import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  reviewHistoryRounds,
  reviewResolutionLabel,
} from "@t3tools/client-runtime/state/review-sessions";
import type {
  EnvironmentId,
  PullRequestDetailView,
  PullRequestRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { useEnvironmentQuery } from "~/state/query";
import { reviewSessionEnvironment } from "~/state/reviewSessions";
import { Button } from "../../ui/button";
import { ReviewHistoryGroup } from "./ReviewRoundCard";
import { ReviewLocalOfferRow, ReviewSourceRow } from "./ReviewSourceRow";
import { useReviewCommand } from "./useReviewCommand";

/** Uses the same GitHub normalization and round rows as chat reviews, without creating a chat. */
export function HostPullRequestReview({
  detail,
  reference,
  environmentId,
  active,
  onStarted,
}: {
  detail: PullRequestDetailView;
  reference: PullRequestRef;
  environmentId: EnvironmentId;
  active: boolean;
  onStarted: (thread: ScopedThreadRef) => void;
}) {
  const query = useEnvironmentQuery(
    reviewSessionEnvironment.host({ environmentId, input: reference }),
  );
  const canStart = useAtomValue(
    reviewSessionEnvironment.startFromPullRequest.permissionAtom(environmentId),
  );
  const start = useReviewCommand(
    reviewSessionEnvironment.startFromPullRequest,
    "Could not start your review",
  );
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => query.refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [active, query.refresh]);
  const run = async () => {
    if (starting) return;
    setStarting(true);
    const result = await start({ environmentId, input: reference });
    setStarting(false);
    if (result._tag === "Success") onStarted(scopeThreadRef(environmentId, result.value.threadId));
  };
  const data = query.data;
  return (
    <div className="h-full overflow-auto p-3">
      <section
        aria-label="Review workspace"
        className="flex flex-col gap-2 rounded-xl border border-border/70 bg-background p-2.5 shadow-sm"
      >
        <h3 className="px-1 text-sm font-semibold">Review workspace</h3>
        {data === null ? (
          <div className="px-1 text-sm text-muted-foreground">
            {query.error ? (
              <>
                <p>Could not load reviews.</p>
                <Button size="sm" variant="outline" onClick={query.refresh}>
                  Retry
                </Button>
              </>
            ) : (
              "Loading reviews…"
            )}
          </div>
        ) : (
          <>
            {reviewHistoryRounds(data.sources, data.items).map((group) => (
              <ReviewHistoryGroup key={group.number} group={group}>
                <ul>
                  {group.sources.map((source) => (
                    <ReviewSourceRow
                      key={source.id}
                      source={source}
                      environmentId={environmentId}
                      sessionId={null}
                      ranOn={null}
                      comments={data.comments[source.id] ?? []}
                      viewerLogin={data.viewerLogin ?? null}
                      resolution={
                        source.state === "done"
                          ? reviewResolutionLabel(
                              group.items.filter((item) => item.sourceIds.includes(source.id)),
                              [source],
                            )
                          : undefined
                      }
                    />
                  ))}
                </ul>
              </ReviewHistoryGroup>
            ))}
            {data.sources.length === 0 ? (
              <p className="px-1 text-sm text-muted-foreground">No reviews requested yet.</p>
            ) : null}
          </>
        )}
        <ul>
          <ReviewLocalOfferRow
            disabled={!canStart || starting || detail.state !== "open"}
            onRun={() => void run()}
          />
        </ul>
        <p className="px-1 text-xs text-muted-foreground">
          {starting
            ? "Preparing the review chat and isolated checkout…"
            : "Run your review creates a review chat and starts an independent review."}
        </p>
      </section>
    </div>
  );
}
