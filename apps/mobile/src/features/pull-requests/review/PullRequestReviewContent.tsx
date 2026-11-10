import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import {
  effectiveDecision,
  foldPostedReviews,
  liveRoundItems,
  nextUnviewedNumber,
  offersLocalReview,
  pointKindFor,
  reviewApplyLines,
  reviewApplySummary,
  reviewerApplyLines,
  reviewHistoryRounds,
  type ReviewHistoryRound,
  reviewProgress,
  reviewResolutionLabel,
  reviewRoundStatusLine,
  reviewRoundViews,
  type ReviewRoundView,
  reviewSourceStateLabel,
  reviewSourceTitle,
  suggestedReviewVerdict,
  triageButton,
} from "@t3tools/client-runtime/state/review-sessions";
import {
  EnvironmentId,
  isViewerSource,
  latestViewerReview,
  reReviewReason,
  reviewRole,
  type PullRequestDetail,
  type PullRequestReviewDecision,
  type ReviewDecision,
  type ReviewItem,
  type ReviewPendingChoice,
  type ReviewPostAs,
  type ReviewSessionSnapshot,
} from "@t3tools/contracts";
import { isOpenReviewPoint } from "@t3tools/shared/reviewPoints";
import { useRef, useState, type ReactNode } from "react";
import { Linking, Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import * as Dialog from "../../../components/ui/Dialog";
import { useEnvironmentQuery } from "../../../state/query";
import { reviewSessionEnvironment } from "../../../state/reviewSessions";
import { PullRequestCardGroup } from "../PullRequestControls";
import type { PullRequestParams } from "../usePullRequestDiff";
import { ReviewPointCard } from "./ReviewPointCard";
import { ReviewProgressCard } from "./ReviewProgressCard";
import { ReviewWritingStyleCard } from "./ReviewWritingStyleCard";
import { useReviewCommand } from "./useReviewCommand";

/**
 * The Review tab: the pull request's review session, live while the tab has been opened. The
 * server owns every decision; this renders it and sends the user's acts, as desktop does.
 */
export function PullRequestReviewContent({
  params,
  pr,
  visible,
}: {
  readonly params: PullRequestParams;
  readonly pr: PullRequestDetail | null;
  readonly visible: boolean;
}) {
  // The subscription starts the first time the tab shows, and stays while the screen does.
  const [opened, setOpened] = useState(visible);
  if (visible && !opened) setOpened(true);
  const environmentId = EnvironmentId.make(params.environmentId);
  const query = useEnvironmentQuery(
    opened
      ? reviewSessionEnvironment.session({
          environmentId,
          input: { repository: params.repository, number: params.number },
        })
      : null,
  );
  const snapshot = query.data?.snapshot ?? null;
  if (snapshot === null) {
    return (
      <Text className="py-6 text-sm text-foreground-muted">
        {query.error ??
          (query.data === null ? "Loading the review…" : "This pull request has no review yet.")}
      </Text>
    );
  }
  const summary = params.initialSummary;
  return (
    <ReviewSession
      key={snapshot.session.id}
      params={params}
      environmentId={environmentId}
      snapshot={snapshot}
      pr={pr}
      reviewDecision={summary?.reviewDecision}
      // A deep link opens with no summary, so its approval is not known here.
      approvalUnknown={summary === undefined}
    />
  );
}

function ReviewSession({
  params,
  environmentId,
  snapshot,
  pr,
  reviewDecision,
  approvalUnknown,
}: {
  readonly params: PullRequestParams;
  readonly environmentId: EnvironmentId;
  readonly snapshot: ReviewSessionSnapshot;
  readonly pr: PullRequestDetail | null;
  readonly reviewDecision: PullRequestReviewDecision | null | undefined;
  readonly approvalUnknown: boolean;
}) {
  const navigation = useNavigation();
  const { session } = snapshot;
  const sessionId = session.id;
  // Mobile has no chat beside the tab: the review's own chat takes every turn.
  const targetThreadId = session.reviewThreadId;
  const canView = useAtomValue(reviewSessionEnvironment.setViewed.permissionAtom(environmentId));
  const canDecide = useAtomValue(reviewSessionEnvironment.decide.permissionAtom(environmentId));
  const canRequest = useAtomValue(reviewSessionEnvironment.request.permissionAtom(environmentId));
  const canRunLocal = useAtomValue(
    reviewSessionEnvironment.runLocalReview.permissionAtom(environmentId),
  );
  const setViewed = useReviewCommand(
    reviewSessionEnvironment.setViewed,
    "Could not change the viewed mark",
  );
  const decide = useReviewCommand(reviewSessionEnvironment.decide, "Could not save the decision");
  const apply = useReviewCommand(reviewSessionEnvironment.request, "Could not apply");
  const triage = useReviewCommand(reviewSessionEnvironment.request, "Could not start the triage");
  const continueReview = useReviewCommand(
    reviewSessionEnvironment.request,
    "Could not continue the review",
  );
  const runLocal = useReviewCommand(
    reviewSessionEnvironment.runLocalReview,
    "Could not start your review",
  );
  const [openNumber, setOpenNumber] = useState<number | null>(null);
  // Only while the press's request is on its way; the server's pending request takes over.
  const [sendingTriage, setSendingTriage] = useState(false);
  const [startingLocal, setStartingLocal] = useState(false);
  // The round an Apply was sent for. The request only queues the agent's turn, so Apply stays
  // busy until the subscription shows the round has left collecting, or the server refuses.
  const [applySent, setApplySent] = useState<string | null>(null);
  const applyInFlight = useRef(false);

  const reviewer = reviewRole(session) === "reviewer";
  const viewerLogin = session.viewerLogin ?? null;
  const roundKey = `${sessionId}:${session.round}`;
  const currentRoundState =
    snapshot.rounds.find((round) => round.round === session.round)?.state ?? null;
  if (applySent !== null && (applySent !== roundKey || currentRoundState !== "collecting")) {
    setApplySent(null);
  }
  const liveItems = session.phase === "done" ? [] : liveRoundItems(snapshot, session.round);

  const views = reviewRoundViews(snapshot);
  const current = views.find((view) => view.current);
  const commits = reviewHistoryRounds(snapshot.sources, snapshot.items);
  // Settled: nothing open, nothing still reviewing, and no finished review waiting for triage.
  const settled = (group: ReviewHistoryRound) =>
    group.items.every((item) => !isOpenReviewPoint(item)) &&
    group.sources.every(
      (source) =>
        source.state !== "reviewing" &&
        source.state !== "requested" &&
        source.state !== "pending" &&
        !(source.kind === "local" && source.state === "done" && !source.triaged),
    );
  const latestCommit = current === undefined ? undefined : commits.at(-1);
  const openRounds =
    latestCommit === undefined
      ? []
      : commits.filter((group) => group === latestCommit || !settled(group));
  const earlier = commits.filter((group) => !openRounds.includes(group));

  const progress = reviewProgress({
    role: reviewer ? "reviewer" : "author",
    viewerLogin,
    authorLogin: session.authorLogin ?? null,
    sources: snapshot.sources,
    items: snapshot.items,
    checks: pr?.checks,
    reviewDecision,
    approvalUnknown,
    headSha: pr?.headSha ?? session.headSha,
    reReview: reReviewReason(session, snapshot.sources),
  });

  const onToggle = (item: ReviewItem) =>
    setOpenNumber((open) => (open === item.number ? null : item.number));
  const onDecide = (item: ReviewItem, decision: ReviewDecision, postAs?: ReviewPostAs) =>
    void decide({
      environmentId,
      input: { sessionId, number: item.number, decision, ...(postAs ? { postAs } : {}) },
    });
  const onViewed = (item: ReviewItem, viewed: boolean) =>
    void (async () => {
      const result = await setViewed({
        environmentId,
        input: { sessionId, number: item.number, viewed },
      });
      if (result._tag === "Failure" || !viewed) return;
      // Viewing the open point moves on to the next one not yet viewed.
      const items = liveItems.map((candidate) =>
        candidate.number === item.number ? { ...candidate, viewed: true } : candidate,
      );
      setOpenNumber((open) =>
        open === item.number ? nextUnviewedNumber(items, item.number) : open,
      );
    })();
  const onOpenFile = (item: ReviewItem) => {
    if (item.path === null) return;
    navigation.dispatch(
      StackActions.push("PullRequestFile", {
        ...params,
        path: item.path,
        ...(item.line === null
          ? {}
          : { focus: { side: "new" as const, start: item.line, end: item.line } }),
      }),
    );
  };

  const startTriage = async () => {
    if (sendingTriage) return;
    setSendingTriage(true);
    await triage({
      environmentId,
      input: { sessionId, targetThreadId, request: { _tag: "triage" } },
    });
    setSendingTriage(false);
  };
  const startLocal = async () => {
    setStartingLocal(true);
    await runLocal({ environmentId, input: { sessionId, targetThreadId } });
    setStartingLocal(false);
  };
  const startApply = async (pendingReview?: ReviewPendingChoice) => {
    // One request per round: a second press would be refused and read as a failed apply.
    if (currentRoundState !== "collecting" || applySent === roundKey || applyInFlight.current) {
      return;
    }
    const key = roundKey;
    applyInFlight.current = true;
    setApplySent(key);
    const result = await apply({
      environmentId,
      input: {
        sessionId,
        targetThreadId,
        request: { _tag: "apply", ...(pendingReview ? { pendingReview } : {}) },
      },
    });
    applyInFlight.current = false;
    if (result._tag === "Failure") setApplySent((sent) => (sent === key ? null : sent));
  };
  const confirmApply = () => {
    const decided = liveItems.map((item) => ({
      ...item,
      decision: effectiveDecision(item) ?? ("needs-call" as const),
    }));
    const lines = reviewer
      ? reviewerApplyLines(decided, session.round)
      : reviewApplyLines(reviewApplySummary(decided, snapshot.sources, session.round));
    // GitHub keeps one pending review per person; ask whether to add to it.
    const existingPending = reviewer
      ? snapshot.sources.find(
          (source) => source.state === "pending" && isViewerSource(source, viewerLogin),
        )
      : undefined;
    const message = [
      lines.map((line) => `• ${line}`).join("\n"),
      existingPending === undefined
        ? null
        : `You already have a pending review on GitHub with ${existingPending.commentCount} ${existingPending.commentCount === 1 ? "comment" : "comments"}. Add these to it, or start fresh, which deletes that draft first.`,
      reviewer
        ? "It runs in the review chat on your computer. You read and submit the review on GitHub."
        : "It runs in the review chat on your computer. If a check fails, nothing is pushed and the agent says so there.",
    ]
      .filter((part) => part !== null)
      .join("\n\n");
    const title = reviewer
      ? `Prepare your pending review on PR #${session.pullRequest.number}?`
      : `Apply approved findings to PR #${session.pullRequest.number}?`;
    Dialog.alert(
      title,
      message,
      existingPending === undefined
        ? [
            { text: "Cancel", style: "cancel" },
            { text: reviewer ? "Prepare review" : "Apply", onPress: () => void startApply() },
          ]
        : [
            { text: "Cancel", style: "cancel" },
            { text: "Start fresh", onPress: () => void startApply("replace") },
            { text: "Add to pending", onPress: () => void startApply("add") },
          ],
    );
  };

  return (
    <View className="w-full max-w-[760px] gap-4 self-center">
      <ReviewProgressCard progress={progress} />
      <ReviewWritingStyleCard environmentId={environmentId} sessionId={sessionId} view={current} />
      {current === undefined ? (
        <Text className="text-sm text-foreground-muted">
          This review is finished. Its rounds are below.
        </Text>
      ) : (
        <RoundSection
          view={current}
          openRounds={openRounds}
          reviewer={reviewer}
          viewerLogin={viewerLogin}
          triage={triageButton(current, snapshot.items, session.pendingRequest)}
          canRequest={canRequest}
          onTriage={() => void startTriage()}
          offerLocal={offersLocalReview(current)}
          localDisabled={!canRunLocal || startingLocal}
          onRunLocal={() => void startLocal()}
        >
          {[
            ...(current.history ?? []).filter((item) => item.stale && isOpenReviewPoint(item)),
            ...current.items,
          ].map((item) => (
            <ReviewPointCard
              key={item.number}
              item={item}
              roundState={current.round.state}
              open={openNumber === item.number}
              collecting={current.round.state === "collecting"}
              canView={canView}
              canDecide={canDecide}
              reviewerRound={reviewer ? session.round : null}
              onToggle={onToggle}
              onViewed={onViewed}
              onDecide={onDecide}
              onOpenFile={onOpenFile}
            />
          ))}
          {current.round.state === "collecting" && current.items.length > 0 ? (
            <ApplyRow
              left={
                current.items.filter(
                  (item) =>
                    effectiveDecision(item) === null &&
                    pointKindFor(item, session, reviewer) !== "context",
                ).length
              }
              reviewer={reviewer}
              sending={applySent === roundKey || session.pendingRequest?.tag === "apply"}
              disabled={!canRequest}
              onApply={confirmApply}
            />
          ) : null}
          {reviewer && current.round.state !== "collecting" ? (
            <ReviewerNextRound
              snapshot={snapshot}
              roundState={current.round.state}
              disabled={!canRequest}
              onReReview={() =>
                void continueReview({
                  environmentId,
                  input: { sessionId, targetThreadId, request: { _tag: "re-review" } },
                })
              }
            />
          ) : null}
        </RoundSection>
      )}
      {(current === undefined ? commits : earlier).length === 0 ? null : (
        <ReviewHistory
          groups={current === undefined ? commits : earlier}
          viewerLogin={viewerLogin}
        />
      )}
    </View>
  );
}

function RoundSection(props: {
  readonly view: ReviewRoundView;
  readonly openRounds: ReadonlyArray<ReviewHistoryRound>;
  readonly reviewer: boolean;
  readonly viewerLogin: string | null;
  readonly triage: ReturnType<typeof triageButton>;
  readonly canRequest: boolean;
  readonly onTriage: () => void;
  readonly offerLocal: boolean;
  readonly localDisabled: boolean;
  readonly onRunLocal: () => void;
  readonly children: ReactNode;
}) {
  const { view } = props;
  const sources = [
    ...view.sources,
    ...props.openRounds.flatMap((group) =>
      group.sources.filter((source) => !view.sources.some((own) => own.id === source.id)),
    ),
  ];
  const folded = foldPostedReviews(sources, props.viewerLogin);
  const shownSources = sources.filter(
    (source) =>
      !folded.hidden.has(source.id) &&
      !(props.offerLocal && source.kind === "local" && source.state === "not-run"),
  );
  const viewed = view.items.filter((item) => item.viewed).length;
  return (
    <View className="gap-3">
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <Text className="min-w-0 flex-1 text-base font-t3-semibold">
            Round {view.round.round}
            {view.round.headSha === null ? null : (
              <Text className="font-mono text-xs text-foreground-muted">
                {"  "}
                {view.round.headSha.slice(0, 7)}
              </Text>
            )}
          </Text>
          {props.triage === null ? null : (
            <Button
              size="compact"
              tone="primary"
              icon="sparkles"
              label={props.triage.label}
              loading={props.triage.busy}
              disabled={!props.canRequest || !props.triage.ready}
              onPress={props.onTriage}
            />
          )}
        </View>
        <Text className="text-xs text-foreground-muted">
          {props.triage?.busy
            ? "Triaging the reviews…"
            : reviewRoundStatusLine({
                round: view.round,
                sources: view.sources,
                items: view.items,
                reviewer: props.reviewer,
              })}
        </Text>
      </View>
      {shownSources.length === 0 && !props.offerLocal ? null : (
        <PullRequestCardGroup>
          {shownSources.map((source, index) => (
            <View
              key={source.id}
              className={`min-h-11 flex-row items-center gap-3 px-4 py-2 ${index < shownSources.length - 1 || props.offerLocal ? "border-b border-border-subtle" : ""}`}
            >
              <Text className="min-w-0 flex-1 text-sm font-t3-medium" numberOfLines={1}>
                {reviewSourceTitle(source, props.viewerLogin)}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {reviewSourceStateLabel(source)}
              </Text>
            </View>
          ))}
          {props.offerLocal ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: props.localDisabled }}
              disabled={props.localDisabled}
              onPress={props.onRunLocal}
              className="min-h-11 flex-row items-center gap-3 px-4 py-2 active:opacity-70"
            >
              <SymbolView name="play" size={16} tintColorClassName="accent-icon-muted" />
              <Text className="min-w-0 flex-1 text-sm font-t3-medium">Run your review</Text>
              <Text className="text-xs text-foreground-muted">On your computer</Text>
            </Pressable>
          ) : null}
        </PullRequestCardGroup>
      )}
      {view.items.length === 0 ? null : (
        <Text className="text-xs text-foreground-muted">
          {view.items.length} {view.items.length === 1 ? "finding" : "findings"} · {viewed} viewed
        </Text>
      )}
      <View className="gap-2">{props.children}</View>
    </View>
  );
}

/** Unresolved decisions block Apply; reading progress does not. */
function ApplyRow(props: {
  readonly left: number;
  readonly reviewer: boolean;
  readonly sending: boolean;
  readonly disabled: boolean;
  readonly onApply: () => void;
}) {
  return (
    <View className="gap-2 pt-2">
      <Text className="text-xs text-foreground-muted">
        {props.sending
          ? "Starting the apply in the review chat…"
          : props.left > 0
            ? `${props.left} ${props.left === 1 ? "needs" : "need"} a decision.`
            : props.reviewer
              ? "Puts your approved comments, +1s and follow-ups into a pending review on GitHub. You submit it there."
              : "Fixes what you chose, posts your review, replies and resolves, from the review chat on your computer."}
      </Text>
      <Button
        tone="primary"
        fullWidth
        icon="play"
        label={props.reviewer ? "Prepare pending review" : "Apply round"}
        loading={props.sending}
        disabled={props.disabled || props.left > 0}
        onPress={props.onApply}
      />
    </View>
  );
}

const VERDICT_TEXT = {
  approved: "Approved",
  "changes-requested": "Changes requested",
  commented: "Commented",
} as const;

/** After a reviewer round is posted: where your review stands, and Re-review for the next round. */
function ReviewerNextRound(props: {
  readonly snapshot: ReviewSessionSnapshot;
  readonly roundState: "applying" | "applied";
  readonly disabled: boolean;
  readonly onReReview: () => void;
}) {
  const { session, sources } = props.snapshot;
  const pending = sources.find(
    (source) => source.state === "pending" && isViewerSource(source, session.viewerLogin),
  );
  const submitted = latestViewerReview(session, sources);
  const reason = reReviewReason(session, sources);
  const verdict =
    suggestedReviewVerdict(liveRoundItems(props.snapshot, session.round), session.round) ===
    "approve"
      ? "Approve"
      : "Request changes";
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
        ? `Your pending review is on GitHub. Read it there and submit: ${verdict} suggested.`
        : props.roundState === "applying"
          ? `Preparing your pending review… then submit it on GitHub: ${verdict} suggested.`
          : `Nothing was posted this round. Submit your verdict on GitHub: ${verdict} suggested.`;
  return (
    <View className="gap-2 pt-2">
      <Text className="text-xs text-foreground-muted">{line}</Text>
      <View className="flex-row gap-2">
        <Button
          size="compact"
          icon="arrow.up.right"
          label="Open on GitHub"
          onPress={() => void Linking.openURL(pending?.url ?? session.url)}
        />
        <Button
          size="compact"
          tone="primary"
          icon="arrow.clockwise"
          label="Next round"
          accessibilityHint="Re-review the new code"
          disabled={props.disabled || props.roundState !== "applied" || reason === null}
          onPress={props.onReReview}
        />
      </View>
    </View>
  );
}

/** Earlier reviewed commits, newest first: who reviewed each, and what came of its points. */
function ReviewHistory(props: {
  readonly groups: ReadonlyArray<ReviewHistoryRound>;
  readonly viewerLogin: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <PullRequestCardGroup>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        className="min-h-11 flex-row items-center gap-3 px-4 py-2.5 active:opacity-70"
      >
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={13}
          tintColorClassName="accent-icon-muted"
        />
        <Text className="min-w-0 flex-1 text-sm font-t3-medium">
          History · {props.groups.length} {props.groups.length === 1 ? "round" : "rounds"}
        </Text>
      </Pressable>
      {open
        ? [...props.groups].reverse().map((group) => (
            <View key={group.number} className="gap-1 border-t border-border-subtle px-4 py-2.5">
              <View className="flex-row items-center gap-2">
                <Text className="text-xs font-t3-semibold">Round {group.number}</Text>
                {group.commitSha === null ? null : (
                  <Text className="font-mono text-2xs text-foreground-muted">
                    {group.commitSha.slice(0, 7)}
                  </Text>
                )}
                <Text className="min-w-0 flex-1 text-right text-2xs text-foreground-muted">
                  {group.sources.every((source) => source.failed)
                    ? "Failed · no review produced"
                    : reviewResolutionLabel(group.items, group.sources)}
                </Text>
              </View>
              <Text className="text-2xs text-foreground-muted" numberOfLines={2}>
                {group.sources
                  .map((source) => reviewSourceTitle(source, props.viewerLogin))
                  .join(", ")}
              </Text>
            </View>
          ))
        : null}
    </PullRequestCardGroup>
  );
}
