import {
  isActiveReviewItem,
  isMinePoint,
  isReviewOverview,
  isViewerSource,
  reviewerPointKind,
} from "@t3tools/contracts";
import type {
  ReviewerPointKind,
  ReviewVerdict,
  ReviewDecision,
  ReviewItem,
  ReviewRound,
  ReviewRoundState,
  ReviewSessionSnapshot,
  ReviewSource,
} from "@t3tools/contracts";

const DECISION_LABELS: Record<ReviewDecision, string> = {
  "needs-call": "Needs a call",
  fix: "Fix",
  decline: "Decline",
};

const quantity = (count: number, noun: string) => `${count} ${count === 1 ? noun : `${noun}s`}`;
const shortSha = (sha: string | null) => (sha === null ? "" : sha.slice(0, 7));

/** On someone else's pull request, what Fix and Decline mean for each kind of point. */
const REVIEWER_LABELS: Record<
  Exclude<ReviewerPointKind, "context">,
  Record<"fix" | "decline", string>
> = {
  finding: { fix: "Post", decline: "Skip" },
  overlap: { fix: "+1", decline: "Skip" },
  "follow-up": { fix: "Resolve", decline: "Keep open" },
};

/** `kind` is the point's reviewer kind on someone else's pull request; null on your own. */
export function reviewDecisionLabel(
  decision: ReviewDecision,
  kind: ReviewerPointKind | null = null,
): string {
  if (kind === null || kind === "context" || decision === "needs-call") {
    return DECISION_LABELS[decision];
  }
  return REVIEWER_LABELS[kind][decision];
}

/** A point's reviewer kind on someone else's pull request, or null on your own. */
export function pointKindFor(
  item: Pick<ReviewItem, "sources" | "round" | "githubThreadIds">,
  session: { readonly round: number } | null,
  reviewer: boolean,
): ReviewerPointKind | null {
  return reviewer && session !== null ? reviewerPointKind(item, session.round) : null;
}

const VERDICT_LABELS: Record<ReviewVerdict, string> = {
  approved: "Approved",
  "changes-requested": "Changes requested",
  commented: "Commented",
};

/** What a point's pill shows: the user's decision, else Claude's call. */
export function effectiveDecision(
  item: Pick<ReviewItem, "decision" | "suggestedDecision">,
): "fix" | "decline" | null {
  return item.decision === "needs-call" ? item.suggestedDecision : item.decision;
}

/**
 * `viewerLogin` names the person using Ctrl: their GitHub reviews read as theirs, and one Ctrl
 * posted from their local review reads as that review, posted.
 */
export function reviewSourceTitle(
  source: Pick<ReviewSource, "kind" | "author" | "posted">,
  viewerLogin: string | null = null,
): string {
  if (source.kind === "copilot") return "Copilot";
  if (source.kind === "local") return "Your review";
  if (isViewerSource(source, viewerLogin)) return source.posted ? "Your review · posted" : "You";
  return source.author ?? "A reviewer";
}

/** The short state at the end of a review's row. */
export function reviewSourceStateLabel(
  source: Pick<ReviewSource, "kind" | "state" | "commentCount" | "failed">,
): string {
  if (source.failed) return "Failed";
  switch (source.state) {
    case "pending":
      return "Pending";
    case "done":
      return quantity(source.commentCount, source.kind === "local" ? "finding" : "comment");
    case "reviewing":
      return source.kind === "local" ? "Running…" : "Reviewing…";
    case "requested":
      return "Requested";
    case "not-run":
      return "Not run";
  }
}

/** The second line of a review's row. `ranOnLabel` is the provider and model a local run used. */
export function reviewSourceDetail(
  source: Pick<
    ReviewSource,
    "kind" | "state" | "commentCount" | "commitSha" | "failed" | "verdict"
  >,
  ranOnLabel: string | null,
): string {
  if (source.failed) return `Could not review ${shortSha(source.commitSha)}`;
  if (source.kind === "local") {
    if (source.state === "reviewing") return "Running in its own chat";
    const ran = ranOnLabel === null ? "Ran in its own chat" : `Ran on ${ranOnLabel}`;
    return `${ran} · ${shortSha(source.commitSha)} · ${quantity(source.commentCount, "finding")}`;
  }
  if (source.state === "pending") {
    return `Pending on GitHub · ${quantity(source.commentCount, "comment")} · open the pull request to submit`;
  }
  if (source.state === "done") {
    const verdict =
      source.verdict == null || source.verdict === "commented"
        ? ""
        : ` · ${VERDICT_LABELS[source.verdict]}`;
    return `Reviewed ${shortSha(source.commitSha)} · ${quantity(source.commentCount, "comment")} on GitHub${verdict}`;
  }
  if (source.state === "not-run") return "Was asked, then the request was withdrawn";
  return "Requested on GitHub";
}

/** Live status of a point while its round applies, and what was done once it has. */
export function reviewApplyBadges(
  item: Pick<ReviewItem, "decision" | "applyState" | "githubThreadIds">,
  roundState: ReviewRoundState,
): ReadonlyArray<string> {
  if (roundState === "collecting") return [];
  const fix = item.decision === "fix";
  const threads = item.githubThreadIds.length > 0;
  switch (item.applyState) {
    case "pending":
      return roundState === "applied"
        ? [item.decision === "decline" ? "Declined" : "Not applied"]
        : ["Waiting"];
    case "working":
      return [fix ? "Fixing…" : "Replying…"];
    case "fixed":
      return ["Fixed"];
    case "replied":
      return [...(fix ? ["Fixed"] : []), ...(threads ? ["Replied"] : fix ? [] : ["Declined"])];
    case "resolved":
      return [...(fix ? ["Fixed"] : []), "Replied", "Resolved"];
  }
}

const joinNames = (names: ReadonlyArray<string>) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

const sentenceName = (source: Pick<ReviewSource, "kind" | "author" | "posted">) =>
  source.kind === "local" ? "your review" : reviewSourceTitle(source);

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The line beside a round's title. */
export function reviewRoundStatusLine(input: {
  readonly round: ReviewRound;
  readonly sources: ReadonlyArray<ReviewSource>;
  readonly items: ReadonlyArray<Pick<ReviewItem, "number" | "applyState">>;
  /** Reviewing someone else's pull request: an applied round is a pending review, not a push. */
  readonly reviewer?: boolean;
}): string {
  const { round, items } = input;
  const sources = input.sources.filter((source) => source.round === round.round);
  if (round.state === "applied" && input.reviewer === true) {
    const posted = items.filter((item) => item.applyState === "replied").length;
    const resolved = items.filter((item) => item.applyState === "resolved").length;
    return `Posted to your pending review · ${quantity(posted, "comment")} · ${resolved} resolved`;
  }
  if (round.state === "applied") {
    const replies = items.filter(
      (item) => item.applyState === "replied" || item.applyState === "resolved",
    ).length;
    const resolved = items.filter((item) => item.applyState === "resolved").length;
    return `Applied · pushed ${shortSha(round.appliedSha)} · ${replies} ${replies === 1 ? "reply" : "replies"} · ${resolved} resolved`;
  }
  if (round.state === "applying") {
    const working = items.find((item) => item.applyState === "working");
    return working === undefined ? "Applying…" : `Applying: working on #${working.number}…`;
  }
  const ready = sources.filter((source) => source.state === "done" && !source.triaged);
  const waiting = sources.filter(
    (source) => source.state === "reviewing" || source.state === "requested",
  );
  if (ready.length > 0) {
    const inLine = `${capitalized(joinNames([...new Set(ready.map(sentenceName))]))} ${new Set(ready.map(sentenceName)).size === 1 ? "is" : "are"} in.`;
    return waiting.length > 0
      ? `${inLine} Waiting for ${joinNames(waiting.map(sentenceName))}…`
      : `${inLine} Ready to triage.`;
  }
  const triaged = sources.filter((source) => source.triaged);
  if (triaged.length > 0) return `Triaged ${joinNames(triaged.map(sentenceName))}`;
  return waiting.length > 0 || sources.length === 0 ? "Waiting for reviews" : "No reviews yet";
}

/** The Triage button covers every finished, untriaged review of the round. */
export function reviewTriageLabel(untriaged: number): string | null {
  if (untriaged === 0) return null;
  if (untriaged === 1) return "Triage";
  if (untriaged === 2) return "Triage both";
  return `Triage all ${untriaged}`;
}

export function reviewPointCounts(input: {
  readonly total: number;
  readonly viewed: number;
  readonly discussed: number;
}): string {
  return `${quantity(input.total, "point")} · ${input.viewed} viewed · ${input.discussed} discussed`;
}

/** After a point is viewed, the next unviewed one opens: later numbers first, then from the top. */
export function nextUnviewedNumber(
  items: ReadonlyArray<Pick<ReviewItem, "number" | "viewed">>,
  after: number,
): number | null {
  const unviewed = items.filter((item) => !item.viewed).map((item) => item.number);
  return unviewed.find((number) => number > after) ?? unviewed[0] ?? null;
}

/** The current round's points, as the panel lists them. */
export function liveRoundItems(
  snapshot: Pick<ReviewSessionSnapshot, "items">,
  round: number,
): ReadonlyArray<ReviewItem> {
  return snapshot.items.filter((item) => item.lastSeenRound === round && isActiveReviewItem(item));
}

/** What the Apply confirmation lists. Human threads get a reply but are never resolved. */
export function reviewApplySummary(
  items: ReadonlyArray<Pick<ReviewItem, "number" | "decision" | "githubThreadIds" | "sources">>,
  sources: ReadonlyArray<Pick<ReviewSource, "kind" | "round" | "commentCount">>,
  round: number,
): { fixes: ReadonlyArray<number>; replies: number; resolves: number; findings: number } {
  const threaded = items.filter((item) => item.githubThreadIds.length > 0);
  return {
    fixes: items.filter((item) => item.decision === "fix").map((item) => item.number),
    replies: threaded.length,
    resolves: threaded.filter((item) => !item.sources.some((name) => name.startsWith("human:")))
      .length,
    findings: sources
      .filter((source) => source.kind === "local" && source.round === round)
      .reduce((sum, source) => sum + source.commentCount, 0),
  };
}

/** Compact labels omit Markdown delimiters; the expanded body retains its formatting. */
export const reviewFindingTitle = (summary: string): string =>
  summary
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");

export interface ReviewHistoryRound {
  readonly number: number;
  readonly sources: ReadonlyArray<ReviewSource>;
  readonly items: ReadonlyArray<ReviewItem>;
}

/** Completed Copilot passes anchor history. Retries join the next pass; other reviewers
 * join the matching commit, or the most recent pass when no commit matches. */
export function reviewHistoryRounds(
  sources: ReadonlyArray<ReviewSource>,
  items: ReadonlyArray<ReviewItem>,
): ReadonlyArray<ReviewHistoryRound> {
  const time = (source: ReviewSource) => source.submittedAt ?? source.updatedAt;
  const ordered = [...sources].sort(
    (a, b) => time(a).localeCompare(time(b)) || a.id.localeCompare(b.id),
  );
  const anchors = ordered.filter(
    (source) => source.kind === "copilot" && source.state === "done" && !source.failed,
  );
  const groups: ReviewSource[][] = Array.from({ length: Math.max(1, anchors.length) }, () => []);
  for (const source of ordered) {
    let index = anchors.findIndex((anchor) => anchor.id === source.id);
    if (index < 0 && source.failed)
      index = anchors.findIndex((anchor) => time(anchor) >= time(source));
    if (index < 0 && !source.failed && source.commitSha !== null) {
      const matches = anchors
        .map((anchor, i) => ({ anchor, i }))
        .filter(({ anchor }) => anchor.commitSha === source.commitSha);
      const preceding = matches.filter(({ anchor }) => time(anchor) <= time(source));
      index = (preceding.at(-1) ?? matches[0])?.i ?? -1;
    }
    if (index < 0) index = anchors.findLastIndex((anchor) => time(anchor) <= time(source));
    groups[Math.max(0, index)]!.push(source);
  }
  return groups
    .map((group, index) => {
      const ids = new Set(group.map((source) => source.id));
      return {
        number: index + 1,
        sources: group,
        items: items.filter(
          (item) => !isReviewOverview(item) && item.sourceIds.some((id) => ids.has(id)),
        ),
      };
    })
    .filter((group) => group.sources.length > 0);
}

/** Resolution comes from GitHub, independently of decisions or whether Ctrl applied them. */
export function reviewResolutionLabel(
  items: ReadonlyArray<ReviewItem>,
  sources: ReadonlyArray<ReviewSource> = [],
): string {
  // Local submissions contain raw findings before triage creates normalized points.
  const awaitingTriage = sources
    .filter(
      (source) =>
        source.kind === "local" && source.state === "done" && !source.failed && !source.triaged,
    )
    .reduce((count, source) => count + source.commentCount, 0);
  if (awaitingTriage > 0) {
    const pending = `${quantity(awaitingTriage, "finding")} awaiting triage`;
    return items.length === 0 ? pending : `${reviewResolutionLabel(items)} · ${pending}`;
  }
  if (items.length === 0) return "No findings";
  const resolved = items.filter((item) => item.githubState === "resolved").length;
  return resolved === items.length
    ? `All resolved · ${resolved}/${items.length}`
    : `${items.length - resolved} open · ${resolved} resolved`;
}

/**
 * What to submit on GitHub after a reviewer round: request changes when anything was posted or
 * kept open, approve when every follow-up resolved and nothing new was posted.
 */
export function suggestedReviewVerdict(
  items: ReadonlyArray<Pick<ReviewItem, "decision" | "sources" | "round" | "githubThreadIds">>,
  sessionRound: number,
): "request-changes" | "approve" {
  const open = items.some((item) => {
    if (!isMinePoint(item)) return false;
    const kind = reviewerPointKind(item, sessionRound);
    return kind === "follow-up" ? item.decision === "decline" : item.decision === "fix";
  });
  return open ? "request-changes" : "approve";
}

/** The reviewer Apply confirmation: what goes into the pending review, and what never happens. */
export function reviewerApplyLines(
  items: ReadonlyArray<Pick<ReviewItem, "decision" | "sources" | "round" | "githubThreadIds">>,
  sessionRound: number,
): ReadonlyArray<string> {
  const count = { finding: 0, overlap: 0, resolve: 0, keepOpen: 0 };
  for (const item of items) {
    const kind = reviewerPointKind(item, sessionRound);
    if (kind === "context") continue;
    if (kind === "follow-up") {
      if (item.decision === "fix") count.resolve += 1;
      else if (item.decision === "decline") count.keepOpen += 1;
    } else if (item.decision === "fix") {
      count[kind] += 1;
    }
  }
  const lines: Array<string> = [];
  if (count.finding > 0) lines.push(`Post ${quantity(count.finding, "new comment")}.`);
  if (count.overlap > 0)
    lines.push(`Reply +1 on ${quantity(count.overlap, "thread")} someone else already raised.`);
  if (count.keepOpen > 0)
    lines.push(`Follow up on ${quantity(count.keepOpen, "thread")} of yours that still need work.`);
  if (count.resolve > 0)
    lines.push(`Resolve ${quantity(count.resolve, "thread")} of yours that are fixed.`);
  lines.push(
    "Everything goes into your pending review on GitHub. Nothing is submitted, and no code is changed.",
  );
  return lines;
}

/** The note on your local review's row once Ctrl posted it to GitHub. */
export function postedReviewNote(posted: Pick<ReviewSource, "state" | "verdict">): string {
  if (posted.state === "pending") return "Pending on GitHub";
  return posted.verdict == null || posted.verdict === "commented"
    ? "Posted to GitHub"
    : `Posted to GitHub · ${VERDICT_LABELS[posted.verdict]}`;
}
