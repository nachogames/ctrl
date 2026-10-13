import { useAtomValue } from "@effect/atom-react";
import {
  reviewPointCounts,
  reviewRoundStatusLine,
  reviewTriageLabel,
} from "@t3tools/client-runtime/state/review-sessions";
import type {
  EnvironmentId,
  ReviewItem,
  ReviewSessionId,
  ServerProvider,
} from "@t3tools/contracts";
import { SparklesIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { reviewSessionEnvironment } from "~/state/reviewSessions";
import { Button } from "../../ui/button";
import { offersLocalReview, ranOnLabel, type ReviewRoundView } from "./pullRequestReview.logic";
import { ReviewLocalOfferRow, ReviewSourceRow } from "./ReviewSourceRow";
import { useReviewCommand } from "./useReviewCommand";

const SECTION_LABEL =
  "px-1 pt-1 text-2xs font-medium tracking-wider text-muted-foreground uppercase";

/** One round: the reviews that went in and the points that came out. */
export function ReviewRoundCard({
  view,
  sessionId,
  environmentId,
  providers,
  discussed,
  renderPoint,
  footer,
}: {
  view: ReviewRoundView;
  sessionId: ReviewSessionId;
  environmentId: EnvironmentId;
  providers: ReadonlyArray<ServerProvider>;
  /** Points the user talked about, here or in their own chat. */
  discussed: number;
  renderPoint: (item: ReviewItem, view: ReviewRoundView) => ReactNode;
  /** The Apply row (Task 11). */
  footer?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(!view.current);
  // Set while the request is on its way; the agent's triage turn then flips the reviews to triaged.
  const [sending, setSending] = useState<"triage" | "local" | null>(null);
  const canRequest = useAtomValue(reviewSessionEnvironment.request.permissionAtom(environmentId));
  const canRunLocal = useAtomValue(
    reviewSessionEnvironment.runLocalReview.permissionAtom(environmentId),
  );
  const request = useReviewCommand(reviewSessionEnvironment.request, "Could not start the triage");
  const runLocal = useReviewCommand(
    reviewSessionEnvironment.runLocalReview,
    "Could not start your review",
  );
  const collecting = view.current && view.round.state === "collecting";
  const untriaged = view.sources.filter((source) => source.state === "done" && !source.triaged);
  const triageLabel = collecting ? reviewTriageLabel(untriaged.length) : null;
  const offerLocal = offersLocalReview(view);
  // The offer row stands in for a local review that was never run.
  const sources = offerLocal
    ? view.sources.filter((source) => !(source.kind === "local" && source.state === "not-run"))
    : view.sources;
  const viewed = view.items.filter((item) => item.viewed).length;

  const send = async (kind: "triage" | "local") => {
    setSending(kind);
    if (kind === "triage") {
      await request({ environmentId, input: { sessionId, request: { _tag: "triage" } } });
    } else {
      await runLocal({ environmentId, input: { sessionId } });
    }
    setSending(null);
  };

  return (
    <section
      aria-label={`Round ${view.round.round}`}
      className="flex flex-col gap-2 rounded-xl border border-border/70 bg-background p-2.5 shadow-sm"
    >
      <header className="flex items-center gap-2.5 px-1">
        <h3 className="text-sm font-semibold">Round {view.round.round}</h3>
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {reviewRoundStatusLine({ round: view.round, sources: view.sources, items: view.items })}
        </p>
        {triageLabel === null ? null : (
          <Button
            size="xs"
            disabled={!canRequest || sending !== null}
            onClick={() => void send("triage")}
          >
            <SparklesIcon aria-hidden="true" />
            {triageLabel}
          </Button>
        )}
        {view.current ? null : (
          <Button
            size="xs"
            variant="outline"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? "Show" : "Hide"}
          </Button>
        )}
      </header>
      {collapsed ? null : (
        <>
          <p className={SECTION_LABEL}>Reviews in this round</p>
          <ul className="flex flex-col gap-0.5">
            {sources.map((source) => (
              <ReviewSourceRow
                key={source.id}
                source={source}
                environmentId={environmentId}
                sessionId={sessionId}
                ranOn={ranOnLabel(source.ranOn, providers)}
              />
            ))}
            {offerLocal ? (
              <ReviewLocalOfferRow
                disabled={!canRunLocal || sending !== null}
                onRun={() => void send("local")}
              />
            ) : null}
          </ul>
          {view.items.length === 0 ? null : (
            <>
              <div className="flex items-center gap-2.5 border-t border-border/60 px-1 pt-2">
                <p className={SECTION_LABEL}>Points</p>
                <span className="flex-1" />
                <span className="text-xs text-muted-foreground">
                  {reviewPointCounts({ total: view.items.length, viewed, discussed })}
                </span>
              </div>
              <ul className="flex flex-col gap-1.5">
                {view.items.map((item) => renderPoint(item, view))}
              </ul>
              {footer}
            </>
          )}
        </>
      )}
    </section>
  );
}
