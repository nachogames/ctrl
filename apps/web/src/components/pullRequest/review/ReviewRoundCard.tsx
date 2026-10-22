import { useAtomValue } from "@effect/atom-react";
import { isOpenReviewPoint } from "@t3tools/shared/reviewPoints";
import {
  type ReviewHistoryRound,
  reviewFindingTitle,
  reviewPointCounts,
  reviewResolutionLabel,
  reviewRoundStatusLine,
} from "@t3tools/client-runtime/state/review-sessions";
import type {
  EnvironmentId,
  ReviewItem,
  ReviewSessionId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { ChevronRightIcon, SparklesIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { reviewSessionEnvironment } from "~/state/reviewSessions";
import ChatMarkdown from "../../ChatMarkdown";
import { Button } from "../../ui/button";
import {
  foldPostedReviews,
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
  targetThreadId,
  environmentId,
  providers,
  discussed,
  renderPoint,
  footer,
  actions,
  viewerLogin = null,
  reviewer = false,
  openRounds,
}: {
  view: ReviewRoundView;
  sessionId: ReviewSessionId;
  targetThreadId: ThreadId;
  environmentId: EnvironmentId;
  providers: ReadonlyArray<ServerProvider>;
  /** Points the user talked about, here or in their own chat. */
  discussed: number;
  renderPoint: (item: ReviewItem, view: ReviewRoundView) => ReactNode;
  /** The Apply row (Task 11). */
  footer?: ReactNode;
  /** Shown whether or not the round has points: the reviewer's submit and Re-review row. */
  actions?: ReactNode;
  /** Who uses Ctrl, so their own GitHub reviews read as theirs. */
  viewerLogin?: string | null;
  /** Reviewing someone else's pull request. */
  reviewer?: boolean;
  /** The current card's reviewed commits: the latest, and earlier ones with anything open. */
  openRounds?: ReadonlyArray<ReviewHistoryRound> | undefined;
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
  // Open points from an earlier commit wait here with the rest until a recheck brings them back.
  const recheck = view.current
    ? (view.history ?? []).filter((item) => item.stale && isOpenReviewPoint(item))
    : [];
  const folded = foldPostedReviews(view.sources, viewerLogin);
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
      input: { sessionId, targetThreadId, request: { _tag: "triage" } },
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
      aria-label="Review workspace"
      className="flex flex-col gap-2 rounded-xl border border-border/70 bg-background p-2.5 shadow-sm"
    >
      <header className="flex items-center gap-2.5 px-1">
        <h3 className="text-sm font-semibold">
          {view.current ? "Review workspace" : "Applied work"}
        </h3>
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {triageButtonState?.busy
            ? "Triaging the reviews…"
            : reviewRoundStatusLine({
                round: view.round,
                sources: view.sources,
                items: view.items,
                reviewer,
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
          {view.current
            ? (openRounds ?? []).map((group) => (
                <section
                  key={group.number}
                  aria-label={`Review round ${group.number}`}
                  className="flex flex-col gap-0.5 border-t border-border/60 pt-2 first:border-t-0 first:pt-0"
                >
                  <h4 className="flex items-center gap-2 px-1 text-xs">
                    <span className="font-semibold">Round {group.number}</span>
                    {group.commitSha === null ? null : (
                      <span className="font-mono text-muted-foreground">
                        {group.commitSha.slice(0, 7)}
                      </span>
                    )}
                    <span className="ml-auto text-muted-foreground">
                      {reviewResolutionLabel(group.items, group.sources)}
                    </span>
                  </h4>
                  <ul className="flex flex-col gap-0.5">
                    {group.sources
                      .filter(
                        (source) =>
                          !folded.hidden.has(source.id) &&
                          !(offerLocal && source.kind === "local" && source.state === "not-run"),
                      )
                      .map((source) => (
                        <ReviewSourceRow
                          key={source.id}
                          source={source}
                          environmentId={environmentId}
                          sessionId={sessionId}
                          ranOn={ranOnLabel(source.ranOn, providers)}
                          viewerLogin={viewerLogin}
                          posted={folded.postedFor.get(source.id)}
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
                </section>
              ))
            : view.reviewHistory?.map((group) => (
                <ReviewHistoryGroup key={group.number} group={group}>
                  <ul className="flex flex-col gap-0.5">
                    {group.sources
                      .filter(
                        (source) =>
                          source.round === view.round.round &&
                          !folded.hidden.has(source.id) &&
                          !(offerLocal && source.kind === "local" && source.state === "not-run"),
                      )
                      .map((source) => (
                        <ReviewSourceRow
                          key={source.id}
                          source={source}
                          environmentId={environmentId}
                          sessionId={sessionId}
                          ranOn={ranOnLabel(source.ranOn, providers)}
                          viewerLogin={viewerLogin}
                          posted={folded.postedFor.get(source.id)}
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
          <ul>
            {offerLocal ? (
              <ReviewLocalOfferRow
                disabled={!canRunLocal || startingLocal}
                onRun={() => void startLocal()}
              />
            ) : null}
          </ul>
          {view.items.length === 0 && recheck.length === 0 ? null : (
            <>
              <div className="flex items-center gap-2.5 border-t border-border/60 px-1 pt-2">
                <p className={SECTION_LABEL}>Open points</p>
                <span className="flex-1" />
                <span className="text-xs text-muted-foreground">
                  {recheck.length > 0 ? `${recheck.length} from an earlier commit · ` : ""}
                  {reviewPointCounts({ total: view.items.length, viewed, discussed })}
                </span>
              </div>
              <ul className="flex flex-col gap-1.5">
                {recheck.map((item) => renderPoint(item, view))}
                {view.items.map((item) => renderPoint(item, view))}
              </ul>
              {footer}
            </>
          )}
          {actions}
        </>
      )}
    </section>
  );
}

/** Historical bodies are rendered only when opened, even in sessions with hundreds of findings. */
function ReviewHistoryItem({
  item,
  environmentId,
}: {
  item: ReviewItem;
  environmentId: EnvironmentId;
}) {
  // Open from an earlier commit: whether the new code touched it, until a recheck.
  const recheck = item.stale && isOpenReviewPoint(item);
  const [open, setOpen] = useState(false);
  return (
    <li>
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer text-xs">
          #{item.number} · {reviewFindingTitle(item.summary)} ·{" "}
          <span className="text-muted-foreground">
            {item.githubState === "outdated"
              ? "code changed"
              : recheck
                ? "not touched"
                : item.githubState === "resolved"
                  ? "resolved"
                  : item.githubState === "open"
                    ? "open"
                    : "not posted"}
          </span>
        </summary>
        {open ? (
          <div className="pt-2">
            {item.path ? (
              <p>
                {item.path}
                {item.line === null ? "" : `:${item.line}`}
              </p>
            ) : null}
            <ChatMarkdown
              text={item.problem}
              cwd={undefined}
              environmentId={environmentId}
              parseRawHtml
            />
            {item.conclusion ? (
              <ChatMarkdown
                text={item.conclusion}
                cwd={undefined}
                environmentId={environmentId}
                parseRawHtml
              />
            ) : null}
          </div>
        ) : null}
      </details>
    </li>
  );
}

/** Follow resolution updates until the reader explicitly chooses to expand or collapse. */
export function ReviewHistoryGroup({
  group,
  children,
}: {
  group: ReviewHistoryRound;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const fullyResolved =
    group.items.length > 0 &&
    group.items.every((item) => item.githubState === "resolved") &&
    !group.sources.some(
      (source) =>
        source.state === "reviewing" ||
        source.state === "requested" ||
        (source.kind === "local" &&
          source.state === "done" &&
          !source.failed &&
          !source.triaged &&
          source.commentCount > 0),
    );
  const open = expanded ?? !fullyResolved;
  return (
    <section
      aria-label={`Review round ${group.number}`}
      className="flex flex-col gap-1 border-t border-border/60 pt-2"
    >
      <h4>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setExpanded(!open)}
          className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-start text-xs hover:bg-accent/50"
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={open ? "size-3 shrink-0 rotate-90" : "size-3 shrink-0"}
          />
          <span className="font-semibold">
            Review round {group.number}
            {group.commitSha === null ? null : (
              <span className="font-mono font-normal text-muted-foreground">
                {" "}
                · {group.commitSha.slice(0, 7)}
              </span>
            )}
          </span>
          <span className="ml-auto">
            {group.sources.every((source) => source.failed)
              ? "Failed · no review produced"
              : reviewResolutionLabel(group.items, group.sources)}
          </span>
        </button>
      </h4>
      {open ? children : null}
    </section>
  );
}

/** Earlier reviewed commits, newest first: who reviewed each, and what came of its points. */
export function ReviewCommitHistory({
  groups,
  environmentId,
  sessionId,
  providers,
  viewerLogin,
}: {
  groups: ReadonlyArray<ReviewHistoryRound>;
  environmentId: EnvironmentId;
  sessionId: ReviewSessionId | null;
  providers: ReadonlyArray<ServerProvider>;
  viewerLogin: string | null;
}) {
  return (
    <>
      {groups.toReversed().map((group) => {
        const folded = foldPostedReviews(group.sources, viewerLogin);
        return (
          <ReviewHistoryGroup key={group.number} group={group}>
            <ul className="flex flex-col gap-0.5">
              {group.sources
                .filter((source) => !folded.hidden.has(source.id))
                .map((source) => (
                  <ReviewSourceRow
                    key={source.id}
                    source={source}
                    environmentId={environmentId}
                    sessionId={sessionId}
                    ranOn={ranOnLabel(source.ranOn, providers)}
                    viewerLogin={viewerLogin}
                    posted={folded.postedFor.get(source.id)}
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
            {group.items.length === 0 ? null : (
              <ul className="flex flex-col gap-1 px-1 pb-1">
                {group.items.map((item) => (
                  <ReviewHistoryItem key={item.number} item={item} environmentId={environmentId} />
                ))}
              </ul>
            )}
          </ReviewHistoryGroup>
        );
      })}
    </>
  );
}
