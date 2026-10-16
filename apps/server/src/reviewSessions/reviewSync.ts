import type {
  ReviewVerdict,
  ReviewGithubState,
  ReviewItem,
  ReviewSession,
  ReviewRoundState,
  ReviewSource,
  ReviewSourceComment,
} from "@t3tools/contracts";
import type { ProviderChangeRequestReviewRound } from "@t3tools/source-control-core/server/PullRequestProvider";

const COPILOT_LOGIN = /^(copilot|copilot-pull-request-reviewer)(\[bot\])?$/i;

/** Copilot reviews as `copilot-pull-request-reviewer` over GraphQL and `Copilot` over REST. */
export const isCopilotLogin = (login: string | null | undefined): boolean =>
  login !== null && login !== undefined && COPILOT_LOGIN.test(login);

/** The hidden marker Ctrl puts on every comment it writes for a review session. */
export const ctrlReviewMarker = (sessionId: string) => `ctrl-review:${sessionId}:`;

const VERDICTS: Record<string, ReviewVerdict> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  COMMENTED: "commented",
};

/** A reviewer asked in a round who has not reviewed yet. */
export const requestSourceId = (round: number, login: string) => `request:${round}:${login}`;

export interface ReviewSyncInput {
  /** The session the markers name; null for the pre-session history read. */
  readonly sessionId?: string | null;
  readonly sessionRound: number;
  readonly roundState: ReviewRoundState;
  /** Every source of the session, all rounds. */
  readonly existing: ReadonlyArray<ReviewSource>;
  readonly read: ProviderChangeRequestReviewRound;
  readonly now: string;
  readonly commentsBySource?: ReadonlyMap<string, ReadonlyArray<ReviewSourceComment>>;
}

export interface ReviewSyncPlan {
  readonly upserts: ReadonlyArray<{
    readonly source: ReviewSource;
    /** Null keeps the stored comments. */
    readonly comments: ReadonlyArray<ReviewSourceComment> | null;
  }>;
  readonly removals: ReadonlyArray<string>;
  readonly threads: ReadonlyMap<
    string,
    { readonly isResolved: boolean; readonly isOutdated: boolean }
  >;
  /** The viewer reviews someone else's pull request and is asked to review it (again). */
  readonly viewerRequested: boolean;
}

type Review = ProviderChangeRequestReviewRound["reviews"][number];

/** Exactly what one review said: its body, then each thread comment it wrote. */
function reviewComments(
  read: ProviderChangeRequestReviewRound,
  review: Review,
): ReadonlyArray<ReviewSourceComment> {
  const comments: Array<ReviewSourceComment> = [];
  if (review.body.trim().length > 0) {
    comments.push({
      key: `gh-review:${review.id}`,
      threadId: null,
      path: null,
      line: null,
      body: review.body,
      url: review.url,
      diffHunk: null,
    });
  }
  for (const thread of read.threads) {
    for (const comment of thread.comments) {
      if (comment.reviewId !== review.id) continue;
      comments.push({
        key: `gh:${thread.id}`,
        threadId: thread.id,
        path: thread.path,
        line: thread.line,
        body: comment.body,
        url: comment.url,
        diffHunk: comment.diffHunk,
      });
    }
  }
  return comments;
}

/**
 * What one GitHub read changes about a session's sources. Idempotent: a read that matches what
 * is stored plans nothing. New reviews and requests join the current round, except while it is
 * being applied; then they wait, and the first read after the round advances files them in the
 * next one. A known source keeps its round and triage mark. Reviews by the pull request's
 * author are retained unless they are Ctrl apply summaries or reply-only reviews.
 *
 * On someone else's pull request the viewer's own reviews always file into the current round,
 * even while it is held, and their pending review files as `pending`: it is the review this
 * round is building.
 */
export function planReviewSync(input: ReviewSyncInput): ReviewSyncPlan {
  const { read, sessionRound, now } = input;
  const author = read.authorLogin?.toLowerCase() ?? null;
  const viewer = read.viewerLogin?.toLowerCase() ?? null;
  const asReviewer = viewer !== null && author !== null && viewer !== author;
  const marker = input.sessionId == null ? null : ctrlReviewMarker(input.sessionId);
  const known = new Map(input.existing.map((source) => [source.id, source]));
  const holding = input.roundState !== "collecting";
  const upserts: Array<ReviewSyncPlan["upserts"][number]> = [];
  const removals: Array<string> = [];
  // Rounds each login has a filed review in, to retire their requests.
  const reviewedRounds = new Map<string, Array<number>>();
  // Logins whose review landed while the round was held. It files after the round advances; until
  // then their request must not read as withdrawn.
  const heldReviewers = new Set<string>();
  const noteReview = (login: string | null, round: number) => {
    if (login === null) return;
    const key = login.toLowerCase();
    reviewedRounds.set(key, [...(reviewedRounds.get(key) ?? []), round]);
  };

  for (const review of read.reviews) {
    const login = review.author?.login ?? null;
    if (
      login !== null &&
      login.toLowerCase() === author &&
      (/^Self-review, round \d+\b/.test(review.body.trim()) ||
        (review.body.trim() === "" &&
          !read.threads.some((thread) => thread.comments[0]?.reviewId === review.id)))
    )
      continue;
    const mine = asReviewer && login !== null && login.toLowerCase() === viewer;
    const pending = review.state === "PENDING";
    if (pending && !mine) continue;
    const stored = known.get(review.id);
    if (stored === undefined && holding && !mine) {
      if (login !== null) heldReviewers.add(login.toLowerCase());
      continue;
    }
    const round = stored?.round ?? sessionRound;
    if (!pending) noteReview(login, round);
    const comments = reviewComments(read, review);
    const state = pending ? "pending" : "done";
    const verdict = pending ? null : (VERDICTS[review.state] ?? null);
    const posted =
      mine && marker !== null && comments.some((comment) => comment.body.includes(marker));
    const failed =
      isCopilotLogin(login) &&
      /Copilot encountered an error and was unable to review/i.test(review.body);
    const reviewThreads = read.threads.filter(
      (thread) => thread.comments[0]?.reviewId === review.id,
    );
    // What Ctrl posted from its own points needs no triage.
    const triaged =
      stored?.triaged === true ||
      failed ||
      posted ||
      (isCopilotLogin(login) &&
        reviewThreads.length > 0 &&
        reviewThreads.every((thread) => thread.isResolved));
    if (
      stored !== undefined &&
      stored.state === state &&
      (stored.verdict ?? null) === verdict &&
      (stored.posted ?? false) === posted &&
      stored.submittedAt === review.submittedAt &&
      stored.failed === failed &&
      stored.triaged === triaged &&
      stored.commentCount === comments.length &&
      stored.commitSha === review.commitSha &&
      (input.commentsBySource === undefined ||
        JSON.stringify(input.commentsBySource.get(review.id)) === JSON.stringify(comments))
    ) {
      continue;
    }
    upserts.push({
      source: {
        id: review.id,
        submittedAt: review.submittedAt,
        failed,
        round,
        kind: isCopilotLogin(login) ? "copilot" : "human",
        state,
        author: login,
        isBot: review.author?.isBot === true,
        commitSha: review.commitSha,
        commentCount: comments.length,
        triaged,
        threadId: null,
        ranOn: null,
        url: review.url,
        verdict,
        posted,
        updatedAt: now,
      },
      comments,
    });
  }

  const pending = new Set<string>();
  let viewerRequested = false;
  for (const reviewer of read.pendingReviewers) {
    const key = reviewer.login.toLowerCase();
    if (key === author) continue;
    // Your own request is the Re-review signal, not a reviewer to wait for.
    if (asReviewer && key === viewer) {
      viewerRequested = true;
      continue;
    }
    pending.add(key);
    if (holding || (reviewedRounds.get(key) ?? []).some((round) => round >= sessionRound)) continue;
    const id = requestSourceId(sessionRound, reviewer.login);
    const state = isCopilotLogin(reviewer.login) ? "reviewing" : "requested";
    if (known.get(id)?.state === state) continue;
    upserts.push({
      source: {
        id,
        round: sessionRound,
        kind: isCopilotLogin(reviewer.login) ? "copilot" : "human",
        state,
        author: reviewer.login,
        isBot: reviewer.isBot === true,
        commitSha: null,
        commentCount: 0,
        triaged: false,
        threadId: null,
        ranOn: null,
        url: null,
        updatedAt: now,
      },
      comments: [],
    });
  }

  // A pending review you deleted on GitHub is gone; one you submitted came back as done above.
  const onGitHub = new Set(read.reviews.map((review) => review.id));
  for (const source of input.existing) {
    if (source.state === "pending" && !onGitHub.has(source.id)) removals.push(source.id);
  }

  for (const source of input.existing) {
    if (!source.id.startsWith("request:") || source.author === null) continue;
    const key = source.author.toLowerCase();
    // The review it was waiting for has landed in its round or a later one.
    if ((reviewedRounds.get(key) ?? []).some((round) => round >= source.round)) {
      removals.push(source.id);
      continue;
    }
    if (!pending.has(key) && !heldReviewers.has(key) && source.state !== "not-run") {
      upserts.push({ source: { ...source, state: "not-run", updatedAt: now }, comments: null });
    }
  }

  return {
    upserts,
    removals,
    viewerRequested,
    threads: new Map(
      read.threads.map((thread) => [
        thread.id,
        { isResolved: thread.isResolved, isOutdated: thread.isOutdated },
      ]),
    ),
  };
}

/** A point's GitHub state from its threads: resolved, outdated, or still open. */
export function itemGithubState(
  threadIds: ReadonlyArray<string>,
  threads: ReviewSyncPlan["threads"],
): ReviewGithubState | null {
  const known = threadIds.flatMap((id) => {
    const thread = threads.get(id);
    return thread === undefined ? [] : [thread];
  });
  if (known.length === 0) return null;
  if (known.every((thread) => thread.isResolved)) return "resolved";
  if (known.every((thread) => thread.isResolved || thread.isOutdated)) return "outdated";
  return "open";
}

export interface ReviewSyncMark {
  readonly fingerprint: string | null;
  readonly round: number;
  /** A reviewer of the current round is still asked or reviewing. */
  readonly waiting: boolean;
  readonly readAt: number;
}

const QUIET_REREAD_MS = 10 * 60_000;

/**
 * Whether the loop reads a review in full: GitHub's watch fingerprint moved, the round moved,
 * someone is still reviewing (a re-request does not move the fingerprint), or it has been quiet
 * for ten minutes.
 */
export function shouldSyncReview(
  previous: ReviewSyncMark | undefined,
  next: Omit<ReviewSyncMark, "readAt">,
  nowMs: number,
): boolean {
  if (previous === undefined) return true;
  if (next.round !== previous.round) return true;
  if (next.fingerprint === null || next.fingerprint !== previous.fingerprint) return true;
  if (next.waiting) return true;
  return nowMs - previous.readAt >= QUIET_REREAD_MS;
}

/** Raw feedback is useful before optional AI triage; identity is the GitHub thread/review key. */
export function rawReviewItems(
  session: Pick<ReviewSession, "round" | "nextNumber">,
  existing: ReadonlyArray<ReviewItem>,
  sources: ReviewSyncPlan["upserts"],
  /**
   * `sessionId`: comments carrying its marker are Ctrl's own posts of existing points and are
   * skipped. `viewerLogin`: the viewer's own GitHub comments are raised by `you`.
   */
  options: { readonly sessionId?: string | null; readonly viewerLogin?: string | null } = {},
): ReadonlyArray<ReviewItem> {
  const marker = options.sessionId == null ? null : ctrlReviewMarker(options.sessionId);
  const viewer = options.viewerLogin?.toLowerCase() ?? null;
  const nextNumber = Math.max(session.nextNumber, ...existing.map((item) => item.number + 1));
  const keys = new Set(existing.flatMap((item) => item.sourceKeys));
  const items: Array<ReviewItem> = [];
  for (const { source, comments } of sources) {
    if (source.state !== "done" || source.round !== session.round) continue;
    for (const comment of comments ?? []) {
      if (keys.has(comment.key) || !comment.body.trim()) continue;
      if (source.kind === "copilot" && comment.key.startsWith("gh-review:")) continue;
      if (marker !== null && comment.body.includes(marker)) continue;
      keys.add(comment.key);
      const summary = comment.body.trim().split("\n")[0]!.slice(0, 180);
      const login = source.author ?? "unknown";
      items.push({
        number: nextNumber + items.length,
        round: session.round,
        lastSeenRound: session.round,
        sourceKeys: [comment.key],
        sourceIds: [source.id],
        sources: [
          source.kind === "copilot"
            ? "copilot"
            : viewer !== null && login.toLowerCase() === viewer
              ? "you"
              : `human:${login}`,
        ],
        githubThreadIds: comment.threadId === null ? [] : [comment.threadId],
        githubState: null,
        path: comment.path,
        line: comment.line,
        summary,
        shortName: summary.slice(0, 60),
        problem: comment.body,
        impact: "",
        solution: "",
        skipReason: "",
        excerpt: comment.diffHunk,
        recommendation: null,
        suggestedDecision: null,
        alreadyFixedIn: null,
        decision: "needs-call",
        decidedBy: null,
        reason: null,
        conclusion: null,
        draftReply: null,
        draftReplyRevision: 0,
        draftReplyBy: null,
        applyState: "pending",
        stale: false,
        viewed: false,
        sideThreadId: null,
        updatedAt: source.updatedAt,
      });
    }
  }
  return items;
}
