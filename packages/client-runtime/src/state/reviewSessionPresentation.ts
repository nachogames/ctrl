import type {
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

export function reviewDecisionLabel(decision: ReviewDecision): string {
  return DECISION_LABELS[decision];
}

/** What a point's pill shows: the user's decision, else Claude's call. */
export function effectiveDecision(
  item: Pick<ReviewItem, "decision" | "suggestedDecision">,
): "fix" | "decline" | null {
  return item.decision === "needs-call" ? item.suggestedDecision : item.decision;
}

export function reviewSourceTitle(source: Pick<ReviewSource, "kind" | "author">): string {
  if (source.kind === "copilot") return "Copilot";
  if (source.kind === "local") return "Your review";
  return source.author ?? "A reviewer";
}

/** The short state at the end of a review's row. */
export function reviewSourceStateLabel(
  source: Pick<ReviewSource, "kind" | "state" | "commentCount">,
): string {
  switch (source.state) {
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
  source: Pick<ReviewSource, "kind" | "state" | "commentCount" | "commitSha">,
  ranOnLabel: string | null,
): string {
  if (source.kind === "local") {
    if (source.state === "reviewing") return "Running in its own chat";
    const ran = ranOnLabel === null ? "Ran in its own chat" : `Ran on ${ranOnLabel}`;
    return `${ran} · ${shortSha(source.commitSha)} · ${quantity(source.commentCount, "finding")}`;
  }
  if (source.state === "done") {
    return `Reviewed ${shortSha(source.commitSha)} · ${quantity(source.commentCount, "comment")} on GitHub`;
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
      return ["Waiting"];
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

const sentenceName = (source: Pick<ReviewSource, "kind" | "author">) =>
  source.kind === "local" ? "your review" : reviewSourceTitle(source);

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The line beside a round's title. */
export function reviewRoundStatusLine(input: {
  readonly round: ReviewRound;
  readonly sources: ReadonlyArray<ReviewSource>;
  readonly items: ReadonlyArray<Pick<ReviewItem, "number" | "applyState">>;
}): string {
  const { round, items } = input;
  const sources = input.sources.filter((source) => source.round === round.round);
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
    const inLine = `${capitalized(joinNames(ready.map(sentenceName)))} ${ready.length === 1 ? "is" : "are"} in.`;
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
  return snapshot.items.filter((item) => item.lastSeenRound === round && !item.stale);
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
