import { isMinePoint, isReviewOverview, isViewerSource } from "@t3tools/contracts";
import { isOpenReviewPoint } from "@t3tools/shared/reviewPoints";
import type {
  PullRequestCheck,
  PullRequestReviewDecision,
  ReviewItem,
  ReviewRole,
  ReviewSource,
} from "@t3tools/contracts";

import { reviewHistoryRounds } from "./reviewSessionPresentation.ts";

export type ReviewGateTone = "done" | "waiting" | "blocked" | "neutral";

export interface ReviewGate {
  readonly label: string;
  readonly value: string;
  readonly tone: ReviewGateTone;
}

/** One reviewed commit: how many issues it raised first, and how many of those are still open. */
export interface ReviewProgressRound {
  readonly number: number;
  readonly commitSha: string | null;
  readonly found: number;
  readonly open: number;
}

export interface ReviewProgress {
  readonly goal: "approve" | "merge";
  readonly headline: string;
  readonly detail: string;
  readonly gates: ReadonlyArray<ReviewGate>;
  readonly rounds: ReadonlyArray<ReviewProgressRound>;
  /** Whether the issues found per round are shrinking, steady, or growing again. */
  readonly trend: string | null;
}

export interface ReviewProgressInput {
  readonly role: ReviewRole;
  readonly viewerLogin: string | null;
  readonly authorLogin: string | null;
  readonly sources: ReadonlyArray<ReviewSource>;
  readonly items: ReadonlyArray<ReviewItem>;
  /** Present once the pull request detail has loaded. */
  readonly checks?: ReadonlyArray<PullRequestCheck> | undefined;
  readonly reviewDecision?: PullRequestReviewDecision | null | undefined;
  readonly headSha?: string | null | undefined;
  /** Why Re-review is offered on someone else's pull request, when it is. */
  readonly reReview?: "requested" | "head-moved" | null | undefined;
}

const SOURCE_NAMES: Record<string, string> = {
  copilot: "Copilot",
  ci: "CI",
  you: "you",
  "local-review": "your self-review",
};

const quantity = (count: number, noun: string) => `${count} ${count === 1 ? noun : `${noun}s`}`;
const isOpen = isOpenReviewPoint;
const time = (source: ReviewSource) => source.submittedAt ?? source.updatedAt;

function checksGate(checks: ReadonlyArray<PullRequestCheck> | undefined): ReviewGate | null {
  if (checks === undefined) return null;
  const counted = checks.filter(
    (check) => check.status !== "skipped" && check.status !== "neutral",
  );
  if (counted.length === 0) return { label: "CI", value: "No checks", tone: "neutral" };
  const failing = counted.filter(
    (check) =>
      check.status === "failure" ||
      check.status === "cancelled" ||
      check.status === "action-required",
  ).length;
  if (failing > 0) return { label: "CI", value: `${failing} failing`, tone: "blocked" };
  if (counted.some((check) => check.status === "pending"))
    return { label: "CI", value: "Running", tone: "waiting" };
  return { label: "CI", value: "Passing", tone: "done" };
}

function trendOf(rounds: ReadonlyArray<ReviewProgressRound>): string | null {
  if (rounds.length < 2) return null;
  const first = rounds[0]!.found;
  const last = rounds.at(-1)!;
  const earlier = rounds.slice(0, -1);
  const peak = Math.max(...earlier.map((round) => round.found));
  if (last.found === 0) return `Round ${last.number} found nothing new.`;
  if (last.found > peak && rounds.length > 2)
    return `Round ${last.number} found more than any round before it.`;
  if (first > 0 && last.found < first)
    return `Settling down: ${first} in round 1, ${last.found} in round ${last.number}.`;
  return null;
}

/**
 * How close a pull request is to its goal: approval when reviewing someone else's, merging when
 * it is yours. Every number comes from GitHub's threads and reviews, never from Ctrl decisions.
 */
export function reviewProgress(input: ReviewProgressInput): ReviewProgress {
  // A finding skipped before it reached GitHub was never raised, so it is not counted.
  const items = input.items.filter(
    (item) =>
      !isReviewOverview(item) && !(item.githubState === null && item.decision === "decline"),
  );
  const history = reviewHistoryRounds(input.sources, items);
  const firstRound = new Map<number, number>();
  for (const round of history)
    for (const item of round.items)
      if (!firstRound.has(item.number)) firstRound.set(item.number, round.number);
  const rounds = history
    .filter((round) => round.commitSha !== null)
    .map((round) => {
      const found = items.filter((item) => firstRound.get(item.number) === round.number);
      return {
        number: round.number,
        commitSha: round.commitSha,
        found: found.length,
        open: found.filter(isOpen).length,
      };
    });
  const ci = checksGate(input.checks);
  const author = input.authorLogin ?? "The author";
  const running = input.sources.some(
    (source) => source.kind === "local" && source.state === "reviewing",
  );
  const untriaged = input.sources
    .filter(
      (source) =>
        source.kind === "local" && source.state === "done" && !source.failed && !source.triaged,
    )
    .reduce((count, source) => count + source.commentCount, 0);

  if (input.role === "reviewer") {
    const mine = items.filter(isMinePoint);
    const mineOpen = mine.filter(isOpen);
    const changed = mineOpen.filter((item) => item.githubState === "outdated").length;
    const others = items.filter((item) => !isMinePoint(item));
    const othersOpen = others.filter(isOpen).length;
    const lastReview = [...input.sources]
      .filter(
        (source) =>
          source.state === "done" &&
          (source.kind === "local" || isViewerSource(source, input.viewerLogin)),
      )
      .sort((a, b) => time(a).localeCompare(time(b)))
      .at(-1);
    const newCode =
      lastReview?.commitSha != null &&
      input.headSha != null &&
      lastReview.commitSha !== input.headSha;
    const approved = input.sources.some(
      (source) =>
        source.verdict === "approved" &&
        isViewerSource(source, input.viewerLogin) &&
        source.commitSha === input.headSha,
    );
    const pending = input.sources.some(
      (source) => source.state === "pending" && isViewerSource(source, input.viewerLogin),
    );
    const [headline, detail] = running
      ? ["Your review is running", "Its findings come here for triage when it finishes."]
      : untriaged > 0
        ? [
            `Triage ${quantity(untriaged, "finding")} from your review`,
            "Decide what to post before anything reaches GitHub.",
          ]
        : pending
          ? [
              "Submit your pending review on GitHub",
              "It stays invisible to the author until you submit it.",
            ]
          : approved
            ? [
                "You approved",
                `Nothing left to do. This comes back if ${author} asks again or pushes.`,
              ]
            : mineOpen.length > 0
              ? [
                  `${quantity(mineOpen.length, "issue")} left before you can approve`,
                  input.reReview === "requested"
                    ? `${author} asked you to look again${changed > 0 ? `, and changed the code under ${changed} of them` : ""}.`
                    : newCode
                      ? `New commits since your review${changed > 0 ? ` touch ${changed} of them` : ""}.`
                      : `Waiting for ${author} to push fixes.`,
                ]
              : mine.length > 0
                ? [
                    "Everything you raised is resolved",
                    newCode
                      ? "New commits since your review: check them, then approve."
                      : "Approve on GitHub when you are happy with it.",
                  ]
                : ["Nothing raised yet", "Run your review to get an independent first look."];
    return {
      goal: "approve",
      headline,
      detail,
      gates: [
        {
          label: "Your issues",
          value:
            mine.length === 0
              ? "None yet"
              : `${mine.length - mineOpen.length} of ${mine.length} resolved`,
          tone: mine.length === 0 ? "neutral" : mineOpen.length === 0 ? "done" : "waiting",
        },
        {
          label: "Others' issues",
          value:
            others.length === 0 ? "None" : othersOpen === 0 ? "All resolved" : `${othersOpen} open`,
          tone: othersOpen === 0 ? "done" : "waiting",
        },
        ...(ci === null ? [] : [ci]),
        {
          label: "Since your review",
          value:
            lastReview === undefined ? "Not reviewed yet" : newCode ? "New commits" : "No new code",
          tone: newCode ? "waiting" : "neutral",
        },
      ],
      rounds,
      trend: trendOf(rounds),
    };
  }

  const open = items.filter(isOpen);
  const openBy = [
    ...new Set(
      open.flatMap((item) =>
        item.sources.map((source) =>
          source.startsWith("human:")
            ? source.slice("human:".length)
            : (SOURCE_NAMES[source] ?? source),
        ),
      ),
    ),
  ];
  const needsApproval = input.reviewDecision !== "approved";
  const failing = ci?.tone === "blocked";
  const [headline, detail] = running
    ? ["Your self-review is running", "Its findings come here for triage when it finishes."]
    : untriaged > 0
      ? [
          `Triage ${quantity(untriaged, "finding")} from your self-review`,
          "Decide what to fix before anything reaches GitHub.",
        ]
      : open.length > 0
        ? [
            `${quantity(open.length, "comment")} to answer`,
            `From ${openBy.join(", ")}.${needsApproval ? " Then it needs an approval." : ""}`,
          ]
        : failing
          ? ["Fix the failing checks", "Every comment is resolved."]
          : needsApproval
            ? ["Waiting for an approval", "Every comment is resolved."]
            : ["Ready to merge", "Approved, every comment resolved."];
  return {
    goal: "merge",
    headline,
    detail,
    gates: [
      {
        label: "Open comments",
        value: open.length === 0 ? "None" : `${open.length} open`,
        tone: open.length === 0 ? "done" : "waiting",
      },
      {
        label: "Approval",
        value:
          input.reviewDecision === "approved"
            ? "Approved"
            : input.reviewDecision === "changes-requested"
              ? "Changes requested"
              : "Not yet",
        tone:
          input.reviewDecision === "approved"
            ? "done"
            : input.reviewDecision === "changes-requested"
              ? "blocked"
              : "waiting",
      },
      ...(ci === null ? [] : [ci]),
      {
        label: "Resolved so far",
        value: `${items.length - open.length} across ${quantity(rounds.length, "round")}`,
        tone: "neutral",
      },
    ],
    rounds,
    trend: trendOf(rounds),
  };
}
