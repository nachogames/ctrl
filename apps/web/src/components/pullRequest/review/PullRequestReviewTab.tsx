import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  effectiveDecision,
  liveRoundItems,
  nextUnviewedNumber,
  reviewApplySummary,
} from "@t3tools/client-runtime/state/review-sessions";
import type {
  EnvironmentId,
  PullRequestRef,
  ReviewDecision,
  ReviewItem,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { useThreadProjection, useThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { pullRequestEnvironment } from "~/state/pullRequests";
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
import { ReviewRoundCard } from "./ReviewRoundCard";
import { useReviewCommand } from "./useReviewCommand";

const NO_MENTIONS: ReadonlyMap<number, number> = new Map();
const NO_ITEMS: ReadonlyArray<ReviewItem> = [];
const NO_LINES: ReadonlyArray<string> = [];

/** Standalone PRs use an existing linked group, never create a separate review workspace. */
export function PullRequestReviewTab({
  environmentId,
  threadRef,
  reference,
  fallback,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  reference: PullRequestRef;
  fallback: ReactNode;
}) {
  return threadRef === null ? (
    <LinkedPullRequestReview
      key={`${environmentId}:${reference.host}:${reference.repository}:${reference.number}`}
      environmentId={environmentId}
      reference={reference}
      fallback={fallback}
    />
  ) : (
    <GroupPullRequestReview
      environmentId={environmentId}
      threadRef={threadRef}
      reference={reference}
      fallback={fallback}
    />
  );
}

function LinkedPullRequestReview({
  environmentId,
  reference,
  fallback,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  fallback: ReactNode;
}) {
  const query = useEnvironmentQuery(
    pullRequestEnvironment.linkedThreads({ environmentId, input: reference }),
  );
  const shells = useThreadShells();
  const [selected, setSelected] = useState<string | null>(null);
  const groups = useMemo(() => {
    const shellsById = new Map(
      shells
        .filter((thread) => thread.environmentId === environmentId)
        .map((thread) => [thread.id, thread]),
    );
    const seen = new Set<string>();
    return (query.data?.threads ?? []).filter((thread) => {
      if (thread.archivedAt !== null) return false;
      const key = shellsById.get(thread.id)?.groupId ?? thread.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [environmentId, query.data, shells]);
  const chosen =
    groups.find((thread) => thread.id === selected) ?? (groups.length === 1 ? groups[0] : null);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {groups.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <span className="text-sm text-muted-foreground">Review group:</span>
          {groups.map((thread) => (
            <Button
              key={thread.id}
              size="sm"
              variant={chosen?.id === thread.id ? "secondary" : "outline"}
              onClick={() => setSelected(thread.id)}
            >
              {thread.title}
            </Button>
          ))}
        </div>
      ) : null}
      {chosen ? (
        <div className="min-h-0 flex-1">
          <GroupPullRequestReview
            key={chosen.id}
            environmentId={environmentId}
            threadRef={scopeThreadRef(environmentId, chosen.id)}
            reference={reference}
            fallback={fallback}
          />
        </div>
      ) : (
        fallback
      )}
    </div>
  );
}

/**
 * The Review tab: the pull request's review in this chat's group, as a stack of rounds.
 * The server owns every decision and viewed mark; this only renders and sends the user's acts.
 */
function GroupPullRequestReview({
  environmentId,
  threadRef,
  reference,
  fallback,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  reference: PullRequestRef;
  fallback: ReactNode;
}) {
  const query = useEnvironmentQuery(
    reviewSessionEnvironment.session({
      environmentId,
      input: {
        threadId: threadRef.threadId,
        repository: reference.repository,
        number: reference.number,
      },
    }),
  );
  const snapshot = query.data?.snapshot ?? null;
  const sessionId = snapshot?.session.id ?? null;
  const reviewThreadId = snapshot?.session.reviewThreadId ?? null;
  const reviewThreadKey =
    reviewThreadId === null ? null : scopedThreadKey(scopeThreadRef(environmentId, reviewThreadId));
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
  // Message counts come from the review chat's own history, loaded when the panel sits beside it.
  const projection = useThreadProjection(reviewThreadId === threadRef.threadId ? threadRef : null);
  const messages = projection?.projection.messages ?? null;
  const mentions = useMemo(
    () => (messages === null ? NO_MENTIONS : reviewPointMentionCounts(messages)),
    [messages],
  );
  // The current round's points, read by the row callbacks when they run so every row keeps the
  // same callbacks across subscription updates.
  const liveItems = useMemo(
    () =>
      snapshot === null || snapshot.session.phase === "done"
        ? NO_ITEMS
        : liveRoundItems(snapshot, snapshot.session.round),
    [snapshot],
  );
  const liveItemsRef = useRef(liveItems);
  useEffect(() => {
    liveItemsRef.current = liveItems;
  }, [liveItems]);

  const session = snapshot?.session ?? null;
  const applyKey = session === null ? null : `${session.id}:${session.round}`;
  const currentRoundState =
    session === null
      ? null
      : (snapshot?.rounds.find((round) => round.round === session.round)?.state ?? null);
  if (applySent !== null && (applySent !== applyKey || currentRoundState !== "collecting")) {
    setApplySent(null);
  }
  useEffect(() => {
    if (session === null || reviewThreadKey === null) return;
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
    if (!liveItems.some((item) => item.number === openNumber)) {
      useReviewPointFocusStore.getState().closePoint(reviewThreadKey);
    }
  }, [liveItems, openNumber, reviewThreadKey]);
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
    const item = liveItems.find((candidate) => candidate.number === requestedPoint);
    if (item !== undefined) focusPoint(item);
    useReviewPointFocusStore.getState().takeRequestedPoint(reviewThreadKey);
  }, [focusPoint, liveItems, requestedPoint, reviewThreadKey]);
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
      if (sessionId === null) return;
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
    (item: ReviewItem, decision: ReviewDecision) => {
      if (sessionId === null) return;
      void decide({ environmentId, input: { sessionId, number: item.number, decision } });
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

  if (snapshot === null || sessionId === null) {
    return fallback;
  }

  const startApply = async () => {
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
    const result = await request({
      environmentId,
      input: { sessionId, request: { _tag: "apply" } },
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
  return (
    <div className="flex h-full flex-col gap-2.5 overflow-y-auto p-3">
      {views.map((view) => {
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
            discussed={
              view.items.filter(
                (item) => (mentions.get(item.number) ?? 0) > 0 || item.sideThreadId !== null,
              ).length
            }
            footer={
              collecting ? (
                <ApplyRow
                  left={view.items.filter((item) => effectiveDecision(item) === null).length}

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
      })}
      <ReviewApplyDialog
        open={confirmingApply}
        onOpenChange={setConfirmingApply}

        pullRequestNumber={snapshot.session.pullRequest.number}
        lines={
          confirmingApply
            ? reviewApplyLines(
                reviewApplySummary(
                  liveItems.map((item) => ({
                    ...item,
                    decision: effectiveDecision(item) ?? "needs-call",
                  })),
                  snapshot.sources,
                  snapshot.session.round,
                ),
              )
            : NO_LINES
        }
        onApply={() => void startApply()}
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
}: {
  left: number;
  sending: boolean;
  disabled: boolean;
  onApply: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5 px-1 pt-1.5">
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">
        {sending
          ? "Starting the apply in the review chat…"
          : left === 0
            ? "Apply approves the displayed Fix/Decline choices, posts your review, replies and resolves."
            : `${left} need a Fix or Decline decision.`}
      </span>
      <Button size="sm" disabled={disabled || sending || left > 0} onClick={onApply}>
        Apply approved findings
      </Button>
    </div>
  );
}
