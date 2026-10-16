import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ReviewSessionId,
  ThreadGroupId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { PullRequestRef } from "./pullRequest.ts";
import { ThreadPullRequestKey } from "./threadPullRequest.ts";

/** Where a review is in the loop. The first slice runs `self-review` and ends at `done`. */
export const ReviewPhase = Schema.Literals([
  "self-review",
  "human-review",
  "awaiting-approval",
  "done",
]);
export type ReviewPhase = typeof ReviewPhase.Type;

/**
 * Who raised a point: Copilot, the local review, CI, a human reviewer by login, or `you` for a
 * review the viewer wrote on GitHub.
 */
export const ReviewItemSource = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(copilot|local-review|ci|you|human:[A-Za-z0-9][A-Za-z0-9-]*(\[bot\])?)$/),
);
export type ReviewItemSource = typeof ReviewItemSource.Type;

/** The user's decision. `needs-call` until the user decides or views Claude's suggestion. */
export const ReviewDecision = Schema.Literals(["needs-call", "fix", "decline"]);
export type ReviewDecision = typeof ReviewDecision.Type;

/** Claude's call on a point; the panel shows it until the user decides. */
export const ReviewSuggestedDecision = Schema.Literals(["fix", "decline"]);
export type ReviewSuggestedDecision = typeof ReviewSuggestedDecision.Type;

/** `working` while the apply turn is on this point. */
export const ReviewApplyState = Schema.Literals([
  "pending",
  "working",
  "fixed",
  "replied",
  "resolved",
]);
export type ReviewApplyState = typeof ReviewApplyState.Type;

/** `chat`: the agent quoted the user's latest message. `panel`: the user chose it in the Review tab. */
export const ReviewDecidedBy = Schema.Literals(["chat", "panel"]);
export type ReviewDecidedBy = typeof ReviewDecidedBy.Type;

/** Who last wrote a reply draft: the agent (from chat or triage) or the user in the panel. */
export const ReviewEditor = Schema.Literals(["agent", "panel"]);
export type ReviewEditor = typeof ReviewEditor.Type;

/** Where a point's GitHub threads stand, from the latest sync. */
export const ReviewGithubState = Schema.Literals(["open", "resolved", "outdated"]);
export type ReviewGithubState = typeof ReviewGithubState.Type;

export const ReviewRoundState = Schema.Literals(["collecting", "applying", "applied"]);
export type ReviewRoundState = typeof ReviewRoundState.Type;

export const ReviewSourceKind = Schema.Literals(["copilot", "human", "local"]);
export type ReviewSourceKind = typeof ReviewSourceKind.Type;

/**
 * `not-run`: requested, then withdrawn without a review. `pending`: the viewer's own review,
 * written on GitHub but not yet submitted.
 */
export const ReviewSourceState = Schema.Literals([
  "requested",
  "reviewing",
  "pending",
  "done",
  "not-run",
]);
export type ReviewSourceState = typeof ReviewSourceState.Type;

/** What a submitted GitHub review said overall. */
export const ReviewVerdict = Schema.Literals(["approved", "changes-requested", "commented"]);
export type ReviewVerdict = typeof ReviewVerdict.Type;

export const ReviewReplyStyle = Schema.Literals(["shorter", "friendlier", "mention-commit"]);
export type ReviewReplyStyle = typeof ReviewReplyStyle.Type;

/** One live review per pull request per group; its review chat owns the list. */
export const ReviewSession = Schema.Struct({
  id: ReviewSessionId,
  projectId: ProjectId,
  pullRequest: ThreadPullRequestKey,
  url: TrimmedNonEmptyString,
  groupId: ThreadGroupId,
  reviewThreadId: ThreadId,
  phase: ReviewPhase,
  round: PositiveInt,
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  nextNumber: PositiveInt,
  /** The pull request's author and the account Ctrl reads GitHub as; see `reviewRole`. */
  authorLogin: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  viewerLogin: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  /** The viewer is asked to review again (a re-request after their review). */
  viewerRequested: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ReviewSession = typeof ReviewSession.Type;

export type ReviewRole = "author" | "reviewer";

const sameLogin = (a: string | null | undefined, b: string | null | undefined) =>
  a != null && b != null && a.toLowerCase() === b.toLowerCase();

/**
 * `author` when the viewer wrote the pull request (Ctrl fixes, pushes and resolves);
 * `reviewer` when someone else did (Ctrl prepares a pending review). Author until both
 * logins are known.
 */
export const reviewRole = (
  session: Pick<ReviewSession, "authorLogin" | "viewerLogin">,
): ReviewRole =>
  session.authorLogin != null &&
  session.viewerLogin != null &&
  !sameLogin(session.authorLogin, session.viewerLogin)
    ? "reviewer"
    : "author";

/** A GitHub review the viewer wrote. Local reviews are always the viewer's too. */
export const isViewerSource = (
  source: Pick<ReviewSource, "kind" | "author">,
  viewerLogin: string | null | undefined,
): boolean => source.kind === "human" && sameLogin(source.author, viewerLogin);

/** A round: the reviews that went in on `headSha` and the points that came out. */
export const ReviewRound = Schema.Struct({
  round: PositiveInt,
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  state: ReviewRoundState,
  /** The commit the apply pushed; set when the round is applied. */
  appliedSha: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ReviewRound = typeof ReviewRound.Type;

/** The provider instance and model a local review ran on, shown as "ran on …". */
export const ReviewRanOn = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});
export type ReviewRanOn = typeof ReviewRanOn.Type;

/**
 * One review that went into a round: a GitHub review (id is its node id), a pending
 * request (`request:<round>:<login>`), or a local review run (`local:<uuid>`).
 */
export const ReviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  round: PositiveInt,
  submittedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  failed: Schema.optional(Schema.Boolean),
  kind: ReviewSourceKind,
  state: ReviewSourceState,
  author: Schema.NullOr(TrimmedNonEmptyString),
  isBot: Schema.Boolean,
  commitSha: Schema.NullOr(TrimmedNonEmptyString),
  commentCount: NonNegativeInt,
  /** Covered by a triage; new untriaged finished sources light the Triage button. */
  triaged: Schema.Boolean,
  /** The chat a local review runs in. */
  threadId: Schema.NullOr(ThreadId),
  ranOn: Schema.NullOr(ReviewRanOn),
  url: Schema.NullOr(TrimmedNonEmptyString),
  /** A submitted GitHub review's overall verdict. */
  verdict: Schema.optional(Schema.NullOr(ReviewVerdict)),
  /** The viewer's review was posted by Ctrl from this review's points (carries its markers). */
  posted: Schema.optional(Schema.Boolean),
  updatedAt: IsoDateTime,
});
export type ReviewSource = typeof ReviewSource.Type;

/**
 * Exactly what a review said. `key` is the finding key points use:
 * `gh:<thread node id>`, `gh-review:<review node id>` for a review's body, or
 * `local:<path>:<slug>` for a local finding.
 */
export const ReviewSourceComment = Schema.Struct({
  key: TrimmedNonEmptyString,
  threadId: Schema.NullOr(TrimmedNonEmptyString),
  path: Schema.NullOr(TrimmedNonEmptyString),
  line: Schema.NullOr(PositiveInt),
  body: Schema.String,
  url: Schema.NullOr(TrimmedNonEmptyString),
  diffHunk: Schema.NullOr(Schema.String),
});
export type ReviewSourceComment = typeof ReviewSourceComment.Type;

/** Another pull request in the stack already fixes this point. */
export const ReviewAlreadyFixedIn = Schema.Struct({
  number: PositiveInt,
  url: TrimmedNonEmptyString,
});
export type ReviewAlreadyFixedIn = typeof ReviewAlreadyFixedIn.Type;

/**
 * One numbered point. `round` is where it was first raised, `lastSeenRound` the latest
 * round that raised it; the panel lists it under `lastSeenRound`.
 */
export const ReviewItem = Schema.Struct({
  number: PositiveInt,
  round: PositiveInt,
  lastSeenRound: PositiveInt,
  sourceKeys: Schema.Array(TrimmedNonEmptyString),
  sources: Schema.Array(ReviewItemSource),
  /** The review rows whose comments carry one of `sourceKeys`. */
  sourceIds: Schema.Array(TrimmedNonEmptyString),
  githubThreadIds: Schema.Array(TrimmedNonEmptyString),
  githubState: Schema.NullOr(ReviewGithubState),
  path: Schema.NullOr(TrimmedNonEmptyString),
  line: Schema.NullOr(PositiveInt),
  summary: TrimmedNonEmptyString,
  /** A few words for the composer chip and the message tag. */
  shortName: TrimmedNonEmptyString,
  /** What's wrong, in plain words. */
  problem: Schema.String,
  /** Why it matters. */
  impact: Schema.String,
  /** What the fix does. */
  solution: Schema.String,
  /** Why we'd skip it. */
  skipReason: Schema.String,
  /** A few unified-diff lines the point is about. */
  excerpt: Schema.NullOr(Schema.String),
  /** Claude's one-line call. Never a decision. */
  recommendation: Schema.NullOr(Schema.String),
  suggestedDecision: Schema.NullOr(ReviewSuggestedDecision),
  alreadyFixedIn: Schema.NullOr(ReviewAlreadyFixedIn),
  decision: ReviewDecision,
  decidedBy: Schema.NullOr(ReviewDecidedBy),
  reason: Schema.NullOr(Schema.String),
  conclusion: Schema.NullOr(Schema.String),
  draftReply: Schema.NullOr(Schema.String),
  /** Counts every write, so the panel can mark a draft that changed while it was open. */
  draftReplyRevision: NonNegativeInt,
  draftReplyBy: Schema.NullOr(ReviewEditor),
  applyState: ReviewApplyState,
  /** Not raised again since the round moved on. */
  stale: Schema.Boolean,
  viewed: Schema.Boolean,
  sideThreadId: Schema.NullOr(ThreadId),
  updatedAt: IsoDateTime,
});
export type ReviewItem = typeof ReviewItem.Type;

export const ReviewSessionSnapshot = Schema.Struct({
  session: ReviewSession,
  rounds: Schema.Array(ReviewRound),
  sources: Schema.Array(ReviewSource),
  items: Schema.Array(ReviewItem),
});
export type ReviewSessionSnapshot = typeof ReviewSessionSnapshot.Type;

/** The review of one pull request in the group of `threadId`. */
export const ReviewSessionSubscribeInput = Schema.Struct({
  threadId: ThreadId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type ReviewSessionSubscribeInput = typeof ReviewSessionSubscribeInput.Type;

/** The latest review of that pull request in the group, or null when there is none. */
export const ReviewSessionSubscribeResult = Schema.Struct({
  snapshot: Schema.NullOr(ReviewSessionSnapshot),
});
export type ReviewSessionSubscribeResult = typeof ReviewSessionSubscribeResult.Type;

export const ReviewSourceReadInput = Schema.Struct({
  sessionId: ReviewSessionId,
  sourceId: TrimmedNonEmptyString,
});
export type ReviewSourceReadInput = typeof ReviewSourceReadInput.Type;

export const ReviewSourceReadResult = Schema.Struct({
  comments: Schema.Array(ReviewSourceComment),
});
export type ReviewSourceReadResult = typeof ReviewSourceReadResult.Type;

const PointFields = { sessionId: ReviewSessionId, number: PositiveInt } as const;

/** A decision from the Review tab. The user made it there, so it needs no quote. */
export const ReviewItemsDecideInput = Schema.Struct({
  ...PointFields,
  decision: ReviewDecision,
  reason: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2000))),
});
export type ReviewItemsDecideInput = typeof ReviewItemsDecideInput.Type;

export const ReviewItemSetViewedInput = Schema.Struct({ ...PointFields, viewed: Schema.Boolean });
export type ReviewItemSetViewedInput = typeof ReviewItemSetViewedInput.Type;

export const ReviewItemEditReplyInput = Schema.Struct({
  ...PointFields,
  draftReply: Schema.String.check(Schema.isMaxLength(20_000)),
});
export type ReviewItemEditReplyInput = typeof ReviewItemEditReplyInput.Type;

export const ReviewItemResult = Schema.Struct({ item: ReviewItem });
export type ReviewItemResult = typeof ReviewItemResult.Type;

/** What a panel button asks the review chat's agent to do. */
export const ReviewTurnRequest = Schema.Union([
  Schema.TaggedStruct("triage", {}),
  Schema.TaggedStruct("apply", {}),
  /** Reviewer flow: open the next round, check your threads, and review the new head. */
  Schema.TaggedStruct("re-review", {}),
  /** Reviewer flow: you approved; finish the review. */
  Schema.TaggedStruct("finish", {}),
  Schema.TaggedStruct("rewrite-reply", { number: PositiveInt, style: ReviewReplyStyle }),
]);
export type ReviewTurnRequest = typeof ReviewTurnRequest.Type;

export const ReviewRequestInput = Schema.Struct({
  sessionId: ReviewSessionId,
  targetThreadId: Schema.optional(ThreadId),
  request: ReviewTurnRequest,
});
export type ReviewRequestInput = typeof ReviewRequestInput.Type;

export const ReviewSessionInput = Schema.Struct({ sessionId: ReviewSessionId });
export type ReviewSessionInput = typeof ReviewSessionInput.Type;

export const ReviewSideChatInput = Schema.Struct(PointFields);
export type ReviewSideChatInput = typeof ReviewSideChatInput.Type;

/** A chat the review started or found: a side chat or the local review's chat. */
export const ReviewThreadResult = Schema.Struct({ threadId: ThreadId });
export type ReviewThreadResult = typeof ReviewThreadResult.Type;

export class ReviewSessionError extends Schema.TaggedError<ReviewSessionError>()(
  "ReviewSessionError",
  {
    message: Schema.String,
    sessionId: Schema.optional(ReviewSessionId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Older imports numbered Copilot overviews; retain their records but never treat them as work. */
export const isReviewOverview = (item: Pick<ReviewItem, "sources" | "sourceKeys">): boolean =>
  item.sources.includes("copilot") &&
  item.sourceKeys.length > 0 &&
  item.sourceKeys.every((key) => key.startsWith("gh-review:"));

export const isActiveReviewItem = (item: ReviewItem): boolean =>
  !item.stale && item.githubState !== "resolved" && !isReviewOverview(item);

/** Raised by the viewer: their local review, or a review they wrote on GitHub. */
export const isMinePoint = (item: Pick<ReviewItem, "sources">): boolean =>
  item.sources.some((source) => source === "local-review" || source === "you");

/**
 * What a point is to the viewer reviewing someone else's pull request:
 * - `context`: only others raised it; it needs nothing from you.
 * - `overlap`: you and someone else raised it; Post means a +1 on their thread.
 * - `follow-up`: yours from an earlier round with a thread; Post means resolve it.
 * - `finding`: yours alone; Post means a new comment.
 */
export type ReviewerPointKind = "context" | "overlap" | "follow-up" | "finding";

export const reviewerPointKind = (
  item: Pick<ReviewItem, "sources" | "round" | "githubThreadIds">,
  sessionRound: number,
): ReviewerPointKind => {
  if (!isMinePoint(item)) return "context";
  if (item.sources.some((source) => source !== "local-review" && source !== "you"))
    return "overlap";
  if (item.round < sessionRound && item.githubThreadIds.length > 0) return "follow-up";
  return "finding";
};

/** Your latest submitted GitHub review in the current round of someone else's pull request. */
export const latestViewerReview = (
  session: Pick<ReviewSession, "round" | "viewerLogin">,
  sources: ReadonlyArray<ReviewSource>,
): ReviewSource | null =>
  sources.reduce<ReviewSource | null>((latest, source) => {
    if (
      source.round !== session.round ||
      source.state !== "done" ||
      !isViewerSource(source, session.viewerLogin)
    )
      return latest;
    const time = (candidate: ReviewSource) => candidate.submittedAt ?? candidate.updatedAt;
    return latest === null || time(source) > time(latest) ? source : latest;
  }, null);

/**
 * Why Re-review may open the next round of someone else's pull request: you were asked to
 * review again, or the head moved past the commit you reviewed. Null until you have submitted
 * this round's review, while a pending review of yours is unsubmitted, and while neither happened.
 */
export const reReviewReason = (
  session: Pick<
    ReviewSession,
    "round" | "phase" | "headSha" | "authorLogin" | "viewerLogin" | "viewerRequested"
  >,
  sources: ReadonlyArray<ReviewSource>,
): "requested" | "head-moved" | null => {
  if (reviewRole(session) !== "reviewer" || session.phase === "done") return null;
  // GitHub keeps one pending review per person: the next round would only add to it.
  if (
    sources.some(
      (source) => source.state === "pending" && isViewerSource(source, session.viewerLogin),
    )
  )
    return null;
  const review = latestViewerReview(session, sources);
  if (review === null) return null;
  if (session.viewerRequested === true) return "requested";
  return session.headSha !== null &&
    review.commitSha !== null &&
    session.headSha !== review.commitSha
    ? "head-moved"
    : null;
};

/** Review history before the user has created a review chat. */
export const ReviewHostInput = PullRequestRef;
export type ReviewHostInput = typeof ReviewHostInput.Type;
export const ReviewHostResult = Schema.Struct({
  viewerLogin: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  sources: Schema.Array(ReviewSource),
  items: Schema.Array(ReviewItem),
  comments: Schema.Record(Schema.String, Schema.Array(ReviewSourceComment)),
});
export type ReviewHostResult = typeof ReviewHostResult.Type;
