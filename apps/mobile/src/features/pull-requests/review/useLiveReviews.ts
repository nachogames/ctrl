import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { reviewSessionEnvironment } from "../../../state/reviewSessions";

/** Live reviews by pull request: true when the round being worked waits on the user. */
export type LiveReviews = ReadonlyMap<string, boolean>;

export const liveReviewKey = (environmentId: EnvironmentId, repository: string, number: number) =>
  `${environmentId}\n${repository.toLowerCase()}\n${number}`;

export const liveReviewsAtom = (environmentId: EnvironmentId) =>
  reviewSessionEnvironment.listLive({ environmentId, input: {} });

const liveReviewsFamily = Atom.family((key: string) => {
  const environmentIds: readonly EnvironmentId[] = JSON.parse(key);
  return Atom.make((get): LiveReviews => {
    const live = new Map<string, boolean>();
    for (const environmentId of environmentIds) {
      const result = AsyncResult.getOrElse(get(liveReviewsAtom(environmentId)), () => null);
      for (const pullRequest of result?.pullRequests ?? []) {
        live.set(
          liveReviewKey(environmentId, pullRequest.repository, pullRequest.number),
          pullRequest.waiting,
        );
      }
    }
    return live;
  });
});

export function useLiveReviews(environmentIds: readonly EnvironmentId[]): LiveReviews {
  return useAtomValue(liveReviewsFamily(JSON.stringify([...new Set(environmentIds)].sort())));
}
