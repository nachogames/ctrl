import { reviewTriageLabel } from "@t3tools/client-runtime/state/review-sessions";
import type {
  ReviewDecision,
  ReviewItem,
  ReviewRanOn,
  ReviewRound,
  ReviewSessionSnapshot,
  ReviewSource,
  ServerProvider,
} from "@t3tools/contracts";
import { parseReviewPointTag } from "@t3tools/shared/reviewPointTag";

import { getDisplayModelName } from "../../chat/providerIconUtils";

export interface ReviewRoundView {
  readonly round: ReviewRound;
  /** The round the review is on now; older rounds start collapsed. */
  readonly current: boolean;
  readonly sources: ReadonlyArray<ReviewSource>;
  readonly items: ReadonlyArray<ReviewItem>;
}

/**
 * Rounds newest first. A point is listed under the latest round that raised it; the
 * current round shows only points raised again since it opened.
 */
export function reviewRoundViews(snapshot: ReviewSessionSnapshot): ReadonlyArray<ReviewRoundView> {
  const { session } = snapshot;
  return snapshot.rounds.map((round) => {
    const current = round.round === session.round && session.phase !== "done";
    return {
      round,
      current,
      sources: snapshot.sources.filter((source) => source.round === round.round),
      items: snapshot.items.filter(
        (item) => item.lastSeenRound === round.round && (!current || !item.stale),
      ),
    };
  });
}

/** How many messages the user sent with each point attached. */
export function reviewPointMentionCounts(
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    const tag = parseReviewPointTag(message.text);
    if (tag !== null) counts.set(tag.number, (counts.get(tag.number) ?? 0) + 1);
  }
  return counts;
}

/** "Claude Opus 5.5" for the model a local review ran on, or its slug when it is unknown here. */
export function ranOnLabel(
  ranOn: ReviewRanOn | null,
  providers: ReadonlyArray<ServerProvider>,
): string | null {
  if (ranOn === null) return null;
  const model = providers
    .find((provider) => provider.instanceId === ranOn.instanceId)
    ?.models.find((candidate) => candidate.slug === ranOn.model);
  return model === undefined ? ranOn.model : getDisplayModelName(model);
}

/** Whose thread a point's reply goes to, or null when it has no GitHub thread. */
export function replyTarget(item: Pick<ReviewItem, "githubThreadIds" | "sources">): string | null {
  if (item.githubThreadIds.length === 0) return null;
  const human = item.sources.find((name) => name.startsWith("human:"));
  if (human !== undefined) return human.slice("human:".length);
  return item.sources.includes("copilot") ? "Copilot" : "the thread";
}

/** "Run your review" is offered while the current round collects and has no local run. */
export function offersLocalReview(view: ReviewRoundView): boolean {
  return (
    view.current &&
    view.round.state === "collecting" &&
    !view.sources.some((source) => source.kind === "local" && source.state !== "not-run")
  );
}

/** Marks a draft the agent wrote after the reader opened the point. */
export function draftUpdateLabel(
  item: Pick<ReviewItem, "draftReplyRevision" | "draftReplyBy">,
  seenRevision: number,
): string | null {
  return item.draftReplyBy === "agent" && item.draftReplyRevision > seenRevision
    ? "Updated from chat"
    : null;
}

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every(
        (key) => (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key],
      )
    );
  }
  return false;
};

/**
 * Whether a point the subscription sent again is unchanged. Every review change re-sends the
 * whole snapshot as new objects, so rows compare by value to skip re-rendering the rest.
 */
export function sameReviewItem(a: ReviewItem, b: ReviewItem): boolean {
  if (a === b) return true;
  const keys = Object.keys(a) as Array<keyof ReviewItem>;
  return keys.length === Object.keys(b).length && keys.every((key) => sameValue(a[key], b[key]));
}

/**
 * A Triage the user sent is still running while any review it covered is untriaged. The request
 * resolves once the turn is queued; only the agent's import flips the reviews to triaged.
 */
export function triageInFlight(
  coveredIds: ReadonlyArray<string>,
  sources: ReadonlyArray<Pick<ReviewSource, "id" | "triaged">>,
): boolean {
  return coveredIds.some((id) => sources.some((source) => source.id === id && !source.triaged));
}

/**
 * The round header's Triage button: shown disabled until a review is in, busy while a triage
 * runs, ready for every finished untriaged review, and gone once they are all triaged.
 */
export function triageButton(
  view: ReviewRoundView,
  coveredIds: ReadonlyArray<string>,
): { readonly label: string; readonly busy: boolean; readonly ready: boolean } | null {
  if (!view.current || view.round.state !== "collecting") return null;
  if (triageInFlight(coveredIds, view.sources)) {
    return { label: "Triaging…", busy: true, ready: false };
  }
  const untriaged = view.sources.filter((source) => source.state === "done" && !source.triaged);
  const label = reviewTriageLabel(untriaged.length);
  if (label !== null) return { label, busy: false, ready: true };
  return view.sources.some((source) => source.state === "done")
    ? null
    : { label: "Triage", busy: false, ready: false };
}

/** A rewrite the user asked for is pending until the draft is written again. */
export function rewritePending(requestedAtRevision: number | null, revision: number): boolean {
  return requestedAtRevision !== null && revision === requestedAtRevision;
}

/**
 * What a click on the Fix/Decline toggle decides. The toggle shows Claude's call pressed while the
 * point needs a call, so clicking that pressed value makes it the user's decision; clicking the
 * user's own pressed decision hands the point back to Claude's call. Null sends nothing.
 */
export function toggledDecision(
  item: Pick<ReviewItem, "decision" | "suggestedDecision">,
  next: ReadonlyArray<string>,
): ReviewDecision | null {
  const value = next[0];
  if (value === "fix" || value === "decline") return value;
  if (item.decision !== "needs-call") return "needs-call";
  return item.suggestedDecision;
}
