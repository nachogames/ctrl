import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  effectiveDecision,
  liveRoundItems,
  nextUnviewedNumber,
  pointKindFor,
  reviewApplySummary,
  reviewerApplyLines,
  reviewHistoryRounds,
  reviewProgress,
  suggestedReviewVerdict,
} from "@t3tools/client-runtime/state/review-sessions";
import {
  isReviewOverview,
  latestViewerReview,
  reReviewReason,
  reviewRole,
  isViewerSource,
  type EnvironmentId,
  type PullRequestCheck,
  type PullRequestRef,
  type PullRequestReviewDecision,
  type ReviewDecision,
  type ReviewItem,
  type ReviewPendingChoice,
  type ReviewPostAs,
  type ReviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { useThreadProjection } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { reviewSessionEnvironment } from "~/state/reviewSessions";
import { EMPTY_SERVER_PROVIDERS, environmentServerConfigsAtom } from "~/state/server";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import {
  reviewApplyLines,
  reviewPointMentionCounts,
  reviewRoundViews,
} from "./pullRequestReview.logic";
import { ReviewApplyDialog } from "./ReviewApplyDialog";
import { ReviewPointMenu, ReviewSideChatBanner, useOpenReviewSideChat } from "./ReviewPointMenu";
import { useReviewPointFocusStore } from "./reviewPointFocusStore";
import { ReviewPointRow } from "./ReviewPointRow";
import { ReviewProgressCard } from "./ReviewProgressCard";
import { ReviewCommitHistory, ReviewRoundCard } from "./ReviewRoundCard";
import { useReviewCommand } from "./useReviewCommand";

const NO_MENTIONS: ReadonlyMap<number, number> = new Map();
const NO_ITEMS: ReadonlyArray<ReviewItem> = [];
const NO_LINES: ReadonlyArray<string> = [];

/** What the pull request page knows about it beyond the review: CI, approval, current head. */
export interface PullRequestReviewStatus {
  readonly checks?: ReadonlyArray<PullRequestCheck> | undefined;
  readonly reviewDecision?: PullRequestReviewDecision | null | undefined;
  readonly headSha?: string | null | undefined;
}

/**
 * The pull request's one review, whichever chat or group it lives in. Beside a chat, that chat
 * starts one when there is none; on its own, the tab shows GitHub's history until one starts.
 */
export function PullRequestReviewTab({
  environmentId,
  threadRef,
  reference,
  fallback,
  status,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  reference: PullRequestRef;
  fallback: ReactNode;
  status?: PullRequestReviewStatus | undefined;
}) {
  const query = useEnvironmentQuery(
    reviewSessionEnvironment.session({
      environmentId,
      input: {
        ...(threadRef === null ? {} : { threadId: threadRef.threadId }),
        repository: reference.repository,
        number: reference.number,
      },
    }),
  );
  const snapshot = query.data?.snapshot ?? null;
  if (snapshot === null) return fallback;
  const beside = threadRef ?? scopeThreadRef(environmentId, snapshot.session.reviewThreadId);
  return (
    <GroupPullRequestReview
      key={`${snapshot.session.id}:${scopedThreadKey(beside)}`}
      environmentId={environmentId}
      threadRef={beside}
      reference={reference}
      snapshot={snapshot}
      status={status}
    />
  );
}

/**
 * The Review tab: where the pull request stands, then the round being worked and its history.
 * The server owns every decision and viewed mark; this only renders and sends the user's acts.
 */
function GroupPullRequestReview({
  environmentId,
  threadRef,
  reference,
  snapshot,
  status,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  reference: PullRequestRef;
  snapshot: ReviewSessionSnapshot;
  status?: PullRequestReviewStatus | undefined;
}) {
  const sessionId = snapshot.session.id;
  // The open point belongs to the chat beside the panel, whichever chat in the group it is: the
  // composer chip and message tags read it under that chat's key.
  const reviewThreadKey: string | null = scopedThreadKey(threadRef);
  const providers = useAtomValue(
    environmentServerConfigsAtom,
    (configs) => configs.get(environmentId)?.providers ?? EMPTY_SERVER_PROVIDERS,
  );
  const canView = useAtomValue(reviewSessionEnvironment.setViewed.permissionAtom(environmentId));
  const canDecide = useAtomValue(reviewSessionEnvironment.decide.permissionAtom(environmentId));
  const setViewed = useReviewCommand(
    reviewSessionEnvironment.setViewed,
    "Could not change the viewed mark",
  );
  const decide = useReviewCommand(reviewSessionEnvironment.decide, "Could not save the decision");
  const canRequest = useAtomValue(reviewSessionEnvironment.request.permissionAtom(environmentId));
  const request = useReviewCommand(reviewSessionEnvironment.request, "Could not apply");
  const prepare = useReviewCommand(
    reviewSessionEnvironment.request,
    "Could not prepare your pending review",
  );
  const continueReview = useReviewCommand(
    reviewSessionEnvironment.request,
    "Could not continue the review",
  );
  const sideChat = useOpenReviewSideChat(environmentId);
  const [confirmingApply, setConfirmingApply] = useState(false);
  // The round an Apply was sent for. The request only moves the round to applying and queues the
  // agent's turn, so Apply stays busy until the subscription shows the round has left
  // collecting, or the server refuses.
  const [applySent, setApplySent] = useState<string | null>(null);
  const applyInFlightRef = useRef<string | null>(null);
  const openLink = useOpenLink(threadRef);
  const openNumber = useReviewPointFocusStore((state) =>
    reviewThreadKey === null ? null : (state.focus[reviewThreadKey]?.number ?? null),
  );
  // Message counts come from the history of the chat beside the panel.
  const projection = useThreadProjection(threadRef);
  const messages = projection?.projection.messages ?? null;
  const mentions = useMemo(
    () => (messages === null ? NO_MENTIONS : reviewPointMentionCounts(messages)),
    [messages],
  );
  // The current round's points, read by the row callbacks when they run so every row keeps the
  // same callbacks across subscription updates.
  const liveItems = useMemo(
    () =>
      snapshot.session.phase === "done"
        ? NO_ITEMS
        : liveRoundItems(snapshot, snapshot.session.round),
    [snapshot],
  );
  // Points the panel lists, open from an earlier commit included; they open like any other.
  const listedItems =
    snapshot.session.phase === "done"
      ? NO_ITEMS
      : snapshot.items.filter(
          (item) =>
            item.lastSeenRound === snapshot.session.round &&
            item.githubState !== "resolved" &&
            !isReviewOverview(item),
        );
  const liveItemsRef = useRef(liveItems);
  useEffect(() => {
    liveItemsRef.current = liveItems;
  }, [liveItems]);

  const session = snapshot.session;
  const applyKey: string | null = `${session.id}:${session.round}`;
  const currentRoundState =
    snapshot.rounds.find((round) => round.round === session.round)?.state ?? null;
  if (applySent !== null && (applySent !== applyKey || currentRoundState !== "collecting")) {
    setApplySent(null);
  }
  useEffect(() => {
    if (reviewThreadKey === null) return;
    useReviewPointFocusStore.getState().registerReviewChat(reviewThreadKey, {
      environmentId,
      projectId: reference.projectId,
      host: session.pullRequest.host,
      repository: session.pullRequest.repository,
      number: session.pullRequest.number,
      url: session.url,
    });
  }, [environmentId, reference.projectId, reviewThreadKey, session]);
  // A point is open only while this tab shows it: one that left the current round (applied,
  // moved on, gone stale) closes, and closing the panel takes the chip away too.
  useEffect(() => {
    if (reviewThreadKey === null || openNumber === null) return;
    if (!listedItems.some((item) => item.number === openNumber)) {
      useReviewPointFocusStore.getState().closePoint(reviewThreadKey);
    }
  }, [listedItems, openNumber, reviewThreadKey]);
  useEffect(() => {
    if (reviewThreadKey === null) return;
    return () => useReviewPointFocusStore.getState().closePoint(reviewThreadKey);
  }, [reviewThreadKey]);

  const focusPoint = useCallback(
    (item: ReviewItem | null) => {
      if (reviewThreadKey === null) return;
      const store = useReviewPointFocusStore.getState();
      if (item === null) store.closePoint(reviewThreadKey);
      else store.openPoint(reviewThreadKey, { number: item.number, label: item.shortName });
    },
    [reviewThreadKey],
  );
  // A message tag asked for a point: open it if this round lists it, and drop the ask either way.
  const requestedPoint = useReviewPointFocusStore((state) =>
    reviewThreadKey === null ? undefined : state.requestedPoints[reviewThreadKey],
  );
  useEffect(() => {
    if (reviewThreadKey === null || requestedPoint === undefined) return;
    const item = listedItems.find((candidate) => candidate.number === requestedPoint);
    if (item !== undefined) focusPoint(item);
    useReviewPointFocusStore.getState().takeRequestedPoint(reviewThreadKey);
  }, [focusPoint, listedItems, requestedPoint, reviewThreadKey]);
  // Apply may be sent again for this round once it is back to collecting (a failed send).
  useEffect(() => {
    if (currentRoundState !== "collecting") applyInFlightRef.current = null;
  }, [currentRoundState]);

  const onOpenChange = useCallback(
    (item: ReviewItem, open: boolean) => focusPoint(open ? item : null),
    [focusPoint],
  );
  const onViewed = useCallback(
    (item: ReviewItem, viewed: boolean) => {
      void (async () => {
        const result = await setViewed({
          environmentId,
          input: { sessionId, number: item.number, viewed },
        });
        if (result._tag === "Failure" || !viewed || reviewThreadKey === null) return;
        // Ticking Viewed on the open point, or with none open, moves on to the next one not
        // yet viewed. Ticking a closed row leaves another open point where it is.
        const open = useReviewPointFocusStore.getState().focus[reviewThreadKey]?.number ?? null;
        if (open !== null && open !== item.number) return;
        const items = liveItemsRef.current.map((candidate) =>
          candidate.number === item.number ? { ...candidate, viewed: true } : candidate,
        );
        const next = nextUnviewedNumber(items, item.number);
        focusPoint(items.find((candidate) => candidate.number === next) ?? null);
      })();
    },
    [environmentId, focusPoint, reviewThreadKey, sessionId, setViewed],
  );
  const onDecide = useCallback(
    (item: ReviewItem, decision: ReviewDecision, postAs?: ReviewPostAs) => {
      void decide({
        environmentId,
        input: { sessionId, number: item.number, decision, ...(postAs ? { postAs } : {}) },
      });
    },
    [decide, environmentId, sessionId],
  );
  const onOpenLink = useCallback(
    (url: string) => {
      void openLink(url).catch((error: unknown) => {
        console.error(error);
        toastManager.add({ type: "error", title: "Unable to open the pull request" });
      });
    },
    [openLink],
  );

  const reviewing = reviewRole(snapshot.session) === "reviewer";
  // GitHub keeps one pending review per person; the dialog asks whether to add to it.
  const existingPending = reviewing
    ? snapshot.sources.find(
        (source) =>
          source.state === "pending" && isViewerSource(source, snapshot.session.viewerLogin),
      )
    : undefined;
  const startApply = async (pendingReview?: ReviewPendingChoice) => {
    // One request per round: a second click (the dialog's Apply while it animates out) would
    // be refused and read as a failed apply.
    if (
      applyKey === null ||
      currentRoundState !== "collecting" ||
      applyInFlightRef.current === applyKey
    ) {
      return;
    }
    const key = applyKey;
    applyInFlightRef.current = key;
    setConfirmingApply(false);
    setApplySent(key);
    const result = await (reviewing ? prepare : request)({
      environmentId,
      input: {
        sessionId,
        targetThreadId: threadRef.threadId,
        request: { _tag: "apply", ...(pendingReview ? { pendingReview } : {}) },
      },
    });
    if (result._tag === "Failure") {
      if (applyInFlightRef.current === key) applyInFlightRef.current = null;
      setApplySent((current) => (current === key ? null : current));
      return;
    }
    // The point closes only once the apply has really started; a refusal leaves it open.
    focusPoint(null);
  };

  const views = reviewRoundViews(snapshot);
  const reviewer = reviewRole(snapshot.session) === "reviewer";
  const viewerLogin = snapshot.session.viewerLogin ?? null;
  const decidedItems = liveItems.map((item) => ({
    ...item,
    decision: effectiveDecision(item) ?? ("needs-call" as const),
  }));
  // History is every reviewed commit before the one the current card shows.
  const commits = reviewHistoryRounds(snapshot.sources, snapshot.items);
  // The workspace shows the latest reviewed commit and every earlier one with anything still
  // open; History keeps the rounds where everything is resolved.
  // Settled: nothing open, nothing still reviewing, and no finished review waiting for triage.
  // A round whose reviews found nothing is settled too.
  const settled = (group: (typeof commits)[number]) =>
    group.items.every((item) => item.githubState === "resolved") &&
    group.sources.every(
      (source) =>
        source.state !== "reviewing" &&
        source.state !== "requested" &&
        source.state !== "pending" &&
        !(source.kind === "local" && source.state === "done" && !source.triaged),
    );
  const latestCommit = views.some((view) => view.current) ? commits.at(-1) : undefined;
  const openRounds = commits.filter((group) => group === latestCommit || !settled(group));
  const earlier = commits.filter((group) => !openRounds.includes(group));
  const renderView = (view: (typeof views)[number]) => {
    const collecting = view.current && view.round.state === "collecting";
    return (
      <ReviewRoundCard
        // A round that stops being current collapses under the new one.
        key={`${view.round.round}:${view.current}`}
        view={view}
        sessionId={sessionId}
        targetThreadId={threadRef.threadId}
        environmentId={environmentId}
        providers={providers}
        viewerLogin={viewerLogin}
        reviewer={reviewer}
        openRounds={view.current ? openRounds : undefined}
        actions={
          reviewer && view.current && view.round.state !== "collecting" ? (
            <ReviewerSubmitRow
              snapshot={snapshot}
              roundState={view.round.state}
              disabled={!canRequest}
              onOpenLink={onOpenLink}
              onRequest={(tag) =>
                void continueReview({
                  environmentId,
                  input: {
                    sessionId,
                    targetThreadId: threadRef.threadId,
                    request: { _tag: tag },
                  },
                })
              }
            />
          ) : null
        }
        discussed={
          view.items.filter(
            (item) => (mentions.get(item.number) ?? 0) > 0 || item.sideThreadId !== null,
          ).length
        }
        footer={
          collecting ? (
            <ApplyRow
              left={
                view.items.filter(
                  (item) =>
                    effectiveDecision(item) === null &&
                    pointKindFor(item, snapshot.session, reviewer) !== "context",
                ).length
              }
              reviewer={reviewer}
              sending={applySent === applyKey}
              disabled={!canRequest}
              onApply={() => setConfirmingApply(true)}
            />
          ) : null
        }
        renderPoint={(item) => {
          const open = view.current && openNumber === item.number;
          const sideThreadId = item.sideThreadId;
          return (
            <ReviewPointRow
              key={item.number}
              item={item}
              environmentId={environmentId}
              sessionId={sessionId}
              roundState={view.round.state}
              open={open}
              openable={view.current}
              collecting={collecting}
              canView={canView}
              canDecide={canDecide}
              talked={mentions.get(item.number) ?? 0}
              reviewerRound={reviewer ? snapshot.session.round : null}
              onOpenChange={onOpenChange}
              onViewed={onViewed}
              onDecide={onDecide}
              onOpenLink={onOpenLink}
              // Only the open row gets these, so the closed rows stay memoised.
              menu={
                open ? (
                  <ReviewPointMenu
                    environmentId={environmentId}
                    disabled={!collecting || sideChat.opening}
                    onDiscuss={() => void sideChat.open(sessionId, item.number)}
                  />
                ) : undefined
              }
              banner={
                open && sideThreadId !== null ? (
                  <ReviewSideChatBanner
                    environmentId={environmentId}
                    threadId={sideThreadId}
                    onOpen={() => void sideChat.goToThread(sideThreadId)}
                  />
                ) : undefined
              }
            />
          );
        }}
      />
    );
  };
  const current = views.filter((view) => view.current);

  const progress = reviewProgress({
    role: reviewer ? "reviewer" : "author",
    viewerLogin,
    authorLogin: snapshot.session.authorLogin ?? null,
    sources: snapshot.sources,
    items: snapshot.items,
    checks: status?.checks,
    reviewDecision: status?.reviewDecision,
    headSha: status?.headSha ?? snapshot.session.headSha,
    reReview: reReviewReason(snapshot.session, snapshot.sources),
  });
  return (
    <div className="flex h-full flex-col gap-2.5 overflow-y-auto p-3">
      <ReviewProgressCard progress={progress} />
      {current.map(renderView)}
      {earlier.length === 0 ? null : (
        <details className="rounded-xl border border-border/70 px-3 py-2 text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            History · {earlier.length} resolved {earlier.length === 1 ? "round" : "rounds"}
          </summary>
          <div className="flex flex-col pt-1">
            <ReviewCommitHistory
              groups={earlier}
              environmentId={environmentId}
              sessionId={sessionId}
              providers={providers}
              viewerLogin={viewerLogin}
            />
          </div>
        </details>
      )}
      <ReviewApplyDialog
        open={confirmingApply}
        onOpenChange={setConfirmingApply}

        pullRequestNumber={snapshot.session.pullRequest.number}
        reviewer={reviewer}
        lines={
          !confirmingApply
            ? NO_LINES
            : reviewer
              ? reviewerApplyLines(decidedItems, snapshot.session.round)
              : reviewApplyLines(
                  reviewApplySummary(decidedItems, snapshot.sources, snapshot.session.round),
                )
        }
        onApply={(pendingReview) => void startApply(pendingReview)}
        existingPending={
          existingPending === undefined ? null : { comments: existingPending.commentCount }
        }
      />
    </div>
  );
}

/** The footer of the round being collected: unresolved decisions block Apply; reading progress does not. */
function ApplyRow({
  left,
  sending,
  disabled,
  onApply,
  reviewer,
}: {
  left: number;
  sending: boolean;
  disabled: boolean;
  onApply: () => void;
  reviewer: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 px-1 pt-1.5">
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">
        {sending
          ? "Starting the apply in the review chat…"
          : left > 0
            ? `${left} need a decision.`
            : reviewer
              ? "Puts your approved comments, +1s and follow-ups into a pending review on GitHub. You submit it there."
              : "Apply approves the displayed Fix/Decline choices, posts your review, replies and resolves."}
      </span>
      <Button size="sm" disabled={disabled || sending || left > 0} onClick={onApply}>
        {reviewer ? "Prepare pending review" : "Apply approved findings"}
      </Button>
    </div>
  );
}

const VERDICT_TEXT = {
  approved: "Approved",
  "changes-requested": "Changes requested",
  commented: "Commented",
} as const;

/**
 * After a reviewer round is posted: where your review stands on GitHub, the verdict to pick,
 * and the way on: Re-review once you are asked again or the author pushes.
 */
function ReviewerSubmitRow({
  snapshot,
  roundState,
  disabled,
  onOpenLink,
  onRequest,
}: {
  snapshot: ReviewSessionSnapshot;
  roundState: "applying" | "applied";
  disabled: boolean;
  onOpenLink: (url: string) => void;
  onRequest: (tag: "re-review") => void;
}) {
  const { session, sources } = snapshot;
  const pending = sources.find(
    (source) => source.state === "pending" && isViewerSource(source, session.viewerLogin),
  );
  const submitted = latestViewerReview(session, sources);
  const reason = reReviewReason(session, sources);
  const items = liveRoundItems(snapshot, session.round);
  const verdict =
    suggestedReviewVerdict(items, session.round) === "approve" ? "Approve" : "Request changes";
  const author = session.authorLogin ?? "The author";
  const line =
    submitted !== null
      ? `You submitted: ${submitted.verdict == null ? "a review" : VERDICT_TEXT[submitted.verdict]}. ${
          reason === "requested"
            ? `${author} asked for your review again.`
            : reason === "head-moved"
              ? "New commits since your review."
              : submitted.verdict === "approved"
                ? `Nothing left to do. This comes back if ${author} asks again or pushes.`
                : `Waiting for ${author} to push fixes and ask again.`
        }`
      : pending !== undefined
        ? `Your pending review is on GitHub. Read it there and submit: ${verdict} suggested.${
            pending.commitSha !== null &&
            session.headSha !== null &&
            pending.commitSha !== session.headSha
              ? " The pull request changed since you started it."
              : ""
          }`
        : roundState === "applying"
          ? `Preparing your pending review… then submit it on GitHub: ${verdict} suggested.`
          : `Nothing was posted this round. Submit your verdict on GitHub: ${verdict} suggested.`;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-1 pt-2">
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">{line}</span>
      <Button size="sm" variant="outline" onClick={() => onOpenLink(pending?.url ?? session.url)}>
        Open on GitHub
      </Button>
      <Button
        size="sm"
        disabled={disabled || roundState !== "applied" || reason === null}
        onClick={() => onRequest("re-review")}
      >
        Re-review
      </Button>
    </div>
  );
}
