import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { liveRoundItems, nextUnviewedNumber } from "@t3tools/client-runtime/state/review-sessions";
import type {
  EnvironmentId,
  PullRequestRef,
  ReviewDecision,
  ReviewItem,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { useThreadProjection } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { reviewSessionEnvironment } from "~/state/reviewSessions";
import { EMPTY_SERVER_PROVIDERS, environmentServerConfigsAtom } from "~/state/server";
import { toastManager } from "../../ui/toast";
import { reviewPointMentionCounts, reviewRoundViews } from "./pullRequestReview.logic";
import { useReviewPointFocusStore } from "./reviewPointFocusStore";
import { ReviewPointRow } from "./ReviewPointRow";
import { ReviewRoundCard } from "./ReviewRoundCard";
import { useReviewCommand } from "./useReviewCommand";

const NO_MENTIONS: ReadonlyMap<number, number> = new Map();
const NO_ITEMS: ReadonlyArray<ReviewItem> = [];

/**
 * The Review tab: the pull request's review in this chat's group, as a stack of rounds.
 * The server owns every decision and viewed mark; this only renders and sends the user's acts.
 */
export function PullRequestReviewTab({
  environmentId,
  threadRef,
  reference,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  reference: PullRequestRef;
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
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {query.error !== null
          ? "The review could not be loaded."
          : query.isSuccess
            ? "No review of this pull request in this group yet. Ask the agent in one of the group's chats to review it."
            : "Loading the review…"}
      </div>
    );
  }

  const views = reviewRoundViews(snapshot);
  return (
    <div className="flex h-full flex-col gap-2.5 overflow-y-auto p-3">
      {views.map((view) => {
        const collecting = view.current && view.round.state === "collecting";
        return (
          <ReviewRoundCard
            key={view.round.round}
            view={view}
            sessionId={sessionId}
            environmentId={environmentId}
            providers={providers}
            discussed={
              view.items.filter(
                (item) => (mentions.get(item.number) ?? 0) > 0 || item.sideThreadId !== null,
              ).length
            }
            renderPoint={(item) => (
              <ReviewPointRow
                key={item.number}
                item={item}
                environmentId={environmentId}
                sessionId={sessionId}
                roundState={view.round.state}
                open={view.current && openNumber === item.number}
                openable={view.current}
                collecting={collecting}
                canView={canView}
                canDecide={canDecide}
                talked={mentions.get(item.number) ?? 0}
                onOpenChange={onOpenChange}
                onViewed={onViewed}
                onDecide={onDecide}
                onOpenLink={onOpenLink}
              />
            )}
          />
        );
      })}
    </div>
  );
}
