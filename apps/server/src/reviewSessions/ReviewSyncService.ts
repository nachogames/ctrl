import {
  ReviewSessionError,
  type PullRequestRef,
  type ReviewSession,
  type ReviewSessionId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ReviewSessions from "../persistence/ReviewSessions.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ReviewSessionChanges from "./ReviewSessionChanges.ts";
import {
  itemGithubState,
  planReviewSync,
  shouldSyncReview,
  type ReviewSyncMark,
} from "./reviewSync.ts";

const SWEEP_MINUTES = 2;

export class ReviewSyncService extends Context.Service<
  ReviewSyncService,
  {
    /** Reads the pull request's reviews and files what changed. True when anything did. */
    readonly syncSession: (
      sessionId: ReviewSessionId,
    ) => Effect.Effect<boolean, ReviewSessionError>;
    /** Syncs every live review every two minutes, reading in full only when GitHub moved. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/reviewSessions/ReviewSyncService") {}

const refOf = (session: ReviewSession): PullRequestRef => ({
  projectId: session.projectId,
  host: session.pullRequest.host,
  repository: session.pullRequest.repository,
  number: session.pullRequest.number,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* ReviewSessions.ReviewSessionRepository;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const changes = yield* ReviewSessionChanges.ReviewSessionChanges;
  const lastReads = new Map<ReviewSessionId, ReviewSyncMark>();
  // One sync at a time per review, so a plan is never applied over a newer one.
  const locks = new Map<ReviewSessionId, Semaphore.Semaphore>();
  const lockFor = (sessionId: ReviewSessionId) => {
    const existing = locks.get(sessionId);
    if (existing !== undefined) return existing;
    const created = Semaphore.makeUnsafe(1);
    locks.set(sessionId, created);
    return created;
  };

  const syncSession: ReviewSyncService["Service"]["syncSession"] = (sessionId) =>
    lockFor(sessionId)
      .withPermits(1)(
        Effect.gen(function* () {
          const found = yield* repo.getSession(sessionId);
          if (Option.isNone(found) || found.value.phase === "done") return false;
          const session = found.value;
          const read = yield* pullRequests.reviewRound(refOf(session));
          if (read === null) return false;
          const rounds = yield* repo.listRounds(session.id);
          const plan = planReviewSync({
            sessionRound: session.round,
            roundState:
              rounds.find((round) => round.round === session.round)?.state ?? "collecting",
            existing: yield* repo.listSources(session.id),
            read,
            now: DateTime.formatIso(yield* DateTime.now),
          });
          const githubStates = (yield* repo.listItems(session.id)).flatMap((item) => {
            const next = itemGithubState(item.githubThreadIds, plan.threads);
            return next !== null && next !== item.githubState
              ? [{ number: item.number, next }]
              : [];
          });
          if (
            plan.upserts.length === 0 &&
            plan.removals.length === 0 &&
            githubStates.length === 0
          ) {
            return false;
          }
          // Sync writes only sources, their comments and each point's GitHub state. It never
          // rewrites a point, so it cannot overwrite what the user or the review service decided.
          yield* sql.withTransaction(
            Effect.gen(function* () {
              for (const { source, comments } of plan.upserts) {
                yield* repo.upsertSource(session.id, source, comments);
              }
              for (const sourceId of plan.removals) yield* repo.deleteSource(session.id, sourceId);
              for (const { number, next } of githubStates) {
                yield* repo.setItemGithubState(session.id, number, next);
              }
            }),
          );
          yield* changes.publish(session.id);
          return true;
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ReviewSessionError({
              message: "The review could not be synced from GitHub.",
              sessionId,
              cause,
            }),
        ),
      );

  const sweep = Effect.gen(function* () {
    const sessions = yield* repo.listLiveSessions().pipe(Effect.orElseSucceed(() => []));
    const live = new Set(sessions.map((session) => session.id));
    for (const id of lastReads.keys()) if (!live.has(id)) lastReads.delete(id);
    for (const session of sessions) {
      const nowMs = yield* Clock.currentTimeMillis;
      const fingerprint = yield* pullRequests.watchFingerprint(refOf(session)).pipe(
        Effect.map((value) => (value === null ? null : `${value.status} ${value.remarks}`)),
        Effect.orElseSucceed(() => null),
      );
      const sources = yield* repo.listSources(session.id).pipe(Effect.orElseSucceed(() => []));
      const next = {
        fingerprint,
        round: session.round,
        waiting: sources.some(
          (source) =>
            source.round === session.round &&
            source.kind !== "local" &&
            (source.state === "requested" || source.state === "reviewing"),
        ),
      };
      if (!shouldSyncReview(lastReads.get(session.id), next, nowMs)) continue;
      yield* syncSession(session.id).pipe(
        Effect.tap(() => Effect.sync(() => lastReads.set(session.id, { ...next, readAt: nowMs }))),
        Effect.catch((error) =>
          Effect.logWarning("review sync failed", { sessionId: session.id, cause: error.cause }),
        ),
      );
    }
  });

  return ReviewSyncService.of({
    syncSession,
    start: () =>
      forkParked(
        sweep.pipe(Effect.repeat(Schedule.spaced(`${SWEEP_MINUTES} minutes`)), Effect.asVoid),
      ),
  });
});

export const layer = Layer.effect(ReviewSyncService, make);

/** Starts the loop for the server's lifetime. */
export const layerStart = Layer.effectDiscard(
  Effect.gen(function* () {
    const sync = yield* ReviewSyncService;
    yield* sync.start();
  }),
);
