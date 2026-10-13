import type {
  ReviewGithubState,
  ReviewRoundState,
  ReviewSource,
  ReviewSourceComment,
} from "@t3tools/contracts";
import type { ProviderChangeRequestReviewRound } from "@t3tools/source-control-core/server/PullRequestProvider";

const COPILOT_LOGIN = /^(copilot|copilot-pull-request-reviewer)(\[bot\])?$/i;

/** Copilot reviews as `copilot-pull-request-reviewer` over GraphQL and `Copilot` over REST. */
export const isCopilotLogin = (login: string | null | undefined): boolean =>
  login !== null && login !== undefined && COPILOT_LOGIN.test(login);

/** A reviewer asked in a round who has not reviewed yet. */
export const requestSourceId = (round: number, login: string) => `request:${round}:${login}`;

export interface ReviewSyncInput {
  readonly sessionRound: number;
  readonly roundState: ReviewRoundState;
  /** Every source of the session, all rounds. */
  readonly existing: ReadonlyArray<ReviewSource>;
  readonly read: ProviderChangeRequestReviewRound;
  readonly now: string;
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
 * author are what Ctrl posted (the self-review and thread replies) and are never sources.
 */
export function planReviewSync(input: ReviewSyncInput): ReviewSyncPlan {
  const { read, sessionRound, now } = input;
  const author = read.authorLogin?.toLowerCase() ?? null;
  const known = new Map(input.existing.map((source) => [source.id, source]));
  const holding = input.roundState !== "collecting";
  const upserts: Array<ReviewSyncPlan["upserts"][number]> = [];
  const removals: Array<string> = [];
  // Rounds each login has a filed review in, to retire their requests.
  const reviewedRounds = new Map<string, Array<number>>();
  const noteReview = (login: string | null, round: number) => {
    if (login === null) return;
    const key = login.toLowerCase();
    reviewedRounds.set(key, [...(reviewedRounds.get(key) ?? []), round]);
  };

  for (const review of read.reviews) {
    const login = review.author?.login ?? null;
    if (login !== null && login.toLowerCase() === author) continue;
    if (review.state === "PENDING") continue;
    const stored = known.get(review.id);
    if (stored === undefined && holding) continue;
    const round = stored?.round ?? sessionRound;
    noteReview(login, round);
    const comments = reviewComments(read, review);
    if (
      stored !== undefined &&
      stored.state === "done" &&
      stored.commentCount === comments.length &&
      stored.commitSha === review.commitSha
    ) {
      continue;
    }
    upserts.push({
      source: {
        id: review.id,
        round,
        kind: isCopilotLogin(login) ? "copilot" : "human",
        state: "done",
        author: login,
        isBot: review.author?.isBot === true,
        commitSha: review.commitSha,
        commentCount: comments.length,
        triaged: stored?.triaged ?? false,
        threadId: null,
        ranOn: null,
        url: review.url,
        updatedAt: now,
      },
      comments,
    });
  }

  const pending = new Set<string>();
  for (const reviewer of read.pendingReviewers) {
    const key = reviewer.login.toLowerCase();
    if (key === author) continue;
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

  for (const source of input.existing) {
    if (!source.id.startsWith("request:") || source.author === null) continue;
    const key = source.author.toLowerCase();
    // The review it was waiting for has landed in its round or a later one.
    if ((reviewedRounds.get(key) ?? []).some((round) => round >= source.round)) {
      removals.push(source.id);
      continue;
    }
    if (!pending.has(key) && source.state !== "not-run") {
      upserts.push({ source: { ...source, state: "not-run", updatedAt: now }, comments: null });
    }
  }

  return {
    upserts,
    removals,
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
