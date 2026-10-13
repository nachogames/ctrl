import { useAtomValue } from "@effect/atom-react";
import {
  reviewPointCounts,
  reviewRoundStatusLine,
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
import {
  offersLocalReview,
  ranOnLabel,
  type ReviewRoundView,
  triageButton,
} from "./pullRequestReview.logic";
import { ReviewLocalOfferRow, ReviewSourceRow } from "./ReviewSourceRow";
import { useReviewCommand } from "./useReviewCommand";

const NO_SOURCE_IDS: ReadonlyArray<string> = [];

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
  // The reviews a Triage click covered. The request only queues the agent's turn; the triage
  // runs until the agent marks each of them triaged. Keyed so a new round or session drops it.
  const [triage, setTriage] = useState<{
    readonly key: string;
    readonly ids: ReadonlyArray<string>;
  } | null>(null);
  const [startingLocal, setStartingLocal] = useState(false);
  const canRequest = useAtomValue(reviewSessionEnvironment.request.permissionAtom(environmentId));
  const canRunLocal = useAtomValue(
    reviewSessionEnvironment.runLocalReview.permissionAtom(environmentId),
  );
  const request = useReviewCommand(reviewSessionEnvironment.request, "Could not start the triage");
  const runLocal = useReviewCommand(
    reviewSessionEnvironment.runLocalReview,
    "Could not start your review",
  );
  const triageKey = `${sessionId}:${view.round.round}`;
  const triageButtonState = triageButton(
    view,
    triage?.key === triageKey ? triage.ids : NO_SOURCE_IDS,
  );
  const offerLocal = offersLocalReview(view);
  // The offer row stands in for a local review that was never run.
  const sources = offerLocal
    ? view.sources.filter((source) => !(source.kind === "local" && source.state === "not-run"))
    : view.sources;
  const viewed = view.items.filter((item) => item.viewed).length;

  const startTriage = async () => {
    const record = {
      key: triageKey,
      ids: view.sources
        .filter((source) => source.state === "done" && !source.triaged)
        .map((source) => source.id),
    };
    setTriage(record);
    const result = await request({
      environmentId,
      input: { sessionId, request: { _tag: "triage" } },
    });
    if (result._tag === "Failure") {
      setTriage((current) => (current === record ? null : current));
    }
  };
  const startLocal = async () => {
    setStartingLocal(true);
    await runLocal({ environmentId, input: { sessionId } });
    setStartingLocal(false);
  };

  return (
    <section
      aria-label={`Round ${view.round.round}`}
      className="flex flex-col gap-2 rounded-xl border border-border/70 bg-background p-2.5 shadow-sm"
    >
      <header className="flex items-center gap-2.5 px-1">
        <h3 className="text-sm font-semibold">Round {view.round.round}</h3>
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {triageButtonState?.busy
            ? "Triaging the reviews…"
            : reviewRoundStatusLine({
                round: view.round,
                sources: view.sources,
                items: view.items,
              })}
        </p>
        {triageButtonState === null ? null : (
          <Button
            size="xs"
            disabled={!canRequest || !triageButtonState.ready}
            onClick={() => void startTriage()}
          >
            <SparklesIcon aria-hidden="true" />
            {triageButtonState.label}
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
                disabled={!canRunLocal || startingLocal}
                onRun={() => void startLocal()}
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
