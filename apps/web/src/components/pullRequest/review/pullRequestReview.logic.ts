import type {
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
