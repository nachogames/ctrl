import type { ThreadPullRequestKey, ThreadPullRequestLink } from "@t3tools/contracts";
import {
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
} from "@t3tools/shared/threadPullRequests";

/** Another pull request in the same stack: one this builds on, or one stacked on it. */
export interface ReviewStackNeighbour {
  readonly number: number;
  readonly url: string;
  readonly headBranch: string | null;
  readonly baseBranch: string | null;
  readonly state: string | null;
  readonly relation: "base" | "stacked";
}

/**
 * The stack around one pull request, from the links chats in the project already carry.
 * The same pull request is linked from several chats, so each is kept once, at its newest
 * snapshot; otherwise its head branch looks reused and no chain is found.
 */
export function reviewStackNeighbours(
  links: ReadonlyArray<ThreadPullRequestLink>,
  key: ThreadPullRequestKey,
): ReadonlyArray<ReviewStackNeighbour> {
  const stamp = (link: ThreadPullRequestLink) => link.snapshot?.syncedAt ?? link.linkedAt;
  const newest = new Map<string, ThreadPullRequestLink>();
  for (const link of links) {
    const id = threadPullRequestKeyOf(link);
    const seen = newest.get(id);
    if (seen === undefined || stamp(link) > stamp(seen)) newest.set(id, link);
  }
  const target = threadPullRequestKeyOf(key);
  const chain = resolveThreadPullRequestChains([...newest.values()]).find((candidate) =>
    candidate.layers.some((layer) => threadPullRequestKeyOf(layer) === target),
  );
  if (chain === undefined) return [];
  const index = chain.layers.findIndex((layer) => threadPullRequestKeyOf(layer) === target);
  return chain.layers.flatMap((layer, position) =>
    position === index
      ? []
      : [
          {
            number: layer.number,
            url: layer.url,
            headBranch: layer.snapshot?.headBranch ?? null,
            baseBranch: layer.snapshot?.baseBranch ?? null,
            state: layer.snapshot?.state ?? null,
            relation: position < index ? ("base" as const) : ("stacked" as const),
          },
        ],
  );
}
