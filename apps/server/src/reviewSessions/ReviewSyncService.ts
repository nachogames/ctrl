import {
  ReviewSessionError,
  reviewRole,
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

import type { ProviderChangeRequestReviewRound } from "@t3tools/source-control-core/server/PullRequestProvider";

import * as ReviewSessions from "../persistence/ReviewSessions.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ReviewSessionChanges from "./ReviewSessionChanges.ts";
import {
  itemGithubState,
  planReviewSync,
  rawReviewItems,
  repairUnknownLocalSources,
  reviewReopenReason,
  shouldSyncReview,
  viewerPendingReview,
  type ReviewSyncMark,
} from "./reviewSync.ts";

const SWEEP_MINUTES = 2;
const REOPEN_WINDOW_DAYS = 30;

export class ReviewSyncService extends Context.Service<
  ReviewSyncService,
  {
    /** Reads the pull request's reviews and files what changed. True when anything did. */
    readonly syncSession: (
      sessionId: ReviewSessionId,
    ) => Effect.Effect<boolean, ReviewSessionError>;
    /**
     * Syncs every live review, and recently finished ones GitHub may bring back, every two
     * minutes, reading in full only when GitHub moved.
     */
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

  const currentRoundState = (session: ReviewSession) =>
    repo
      .listRounds(session.id)
      .pipe(
        Effect.map(
          (rounds) => rounds.find((round) => round.round === session.round)?.state ?? "collecting",
        ),
      );

  /**
   * Brings a finished review back when GitHub moved past where it ended. Reviewing someone
   * else's pull request, it returns to its posted round so Re-review is offered; on your own,
   * a new round opens on the new head. Never while another review of the pull request is live.
   */
  const reopen = Effect.fn("ReviewSyncService.reopen")(function* (
    session: ReviewSession,
    read: ProviderChangeRequestReviewRound,
  ) {
    if (reviewReopenReason(session, read) === null) return null;
    const live = yield* repo.findLiveSession({
      key: session.pullRequest,
      projectId: session.projectId,
      groupId: session.groupId,
    });
    if (Option.isSome(live)) return null;
    const at = DateTime.formatIso(yield* DateTime.now);
    const roundState = yield* currentRoundState(session);
    const nextRound = reviewRole(session) === "author" && roundState === "applied";
    const next: ReviewSession = nextRound
      ? {
          ...session,
          phase: "self-review",
          round: session.round + 1,
          headSha: read.headSha ?? session.headSha,
          updatedAt: at,
        }
      : { ...session, phase: "self-review", updatedAt: at };
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* repo.updateSession(next);
        if (!nextRound) return;
        yield* repo.upsertRound(session.id, {
          round: next.round,
          headSha: next.headSha,
          state: "collecting",
          appliedSha: null,
          createdAt: at,
          updatedAt: at,
        });
        yield* repo.markItemsStale(session.id);
      }),
    );
    yield* changes.publish(session.id);
    return next;
  });

  const syncSession: ReviewSyncService["Service"]["syncSession"] = (sessionId) =>
    lockFor(sessionId)
      .withPermits(1)(
        Effect.gen(function* () {
          const found = yield* repo.getSession(sessionId);
          if (Option.isNone(found)) return false;
          // A merged or closed pull request ends its review. When GitHub cannot say, nothing
          // changes.
          const state = yield* pullRequests.summary(refOf(found.value)).pipe(
            Effect.map((summary) => summary.state),
            Effect.orElseSucceed(() => null),
          );
          if (state !== null && state !== "open") {
            if (found.value.phase === "done") return false;
            yield* repo.updateSession({
              ...found.value,
              phase: "done",
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            });
            yield* changes.publish(sessionId);
            return true;
          }
          const read = yield* pullRequests.reviewRound(refOf(found.value));
          if (read === null) return false;
          let session = found.value;
          if (session.phase === "done") {
            const reopened = yield* reopen(session, read);
            if (reopened === null) {
              // Once the request you finished under is gone, asking you again brings it back.
              if (session.viewerRequested !== true || viewerPendingReview(session, read))
                return false;
              yield* repo.updateSession({ ...session, viewerRequested: false });
              return false;
            }
            session = reopened;
          }
          const roundState = yield* currentRoundState(session);
          const sources = yield* repo.listSources(session.id);
          const commentsBySource = new Map(
            yield* Effect.forEach(sources, (source) =>
              repo
                .listSourceComments(session.id, source.id)
                .pipe(Effect.map((comments) => [source.id, comments] as const)),
            ),
          );
          const plan = planReviewSync({
            sessionId: session.id,
            sessionRound: session.round,
            roundState,
            existing: sources,
            commentsBySource,
            read,
            now: DateTime.formatIso(yield* DateTime.now),
          });
          const rawSources = [
            ...new Map([
              ...sources.map(
                (source) =>
                  [source.id, { source, comments: commentsBySource.get(source.id) ?? [] }] as const,
              ),
              ...plan.upserts.map((entry) => [entry.source.id, entry] as const),
            ]).values(),
          ];
          const existingItems = yield* repo.listItems(session.id);
          const rawOptions = { sessionId: session.id, viewerLogin: read.viewerLogin };
          const missingRaw =
            roundState === "collecting"
              ? rawReviewItems(session, existingItems, rawSources, rawOptions)
              : [];
          // Who wrote it and who reads it; a read that cannot tell keeps what was known.
          const people = (current: ReviewSession) => ({
            authorLogin: read.authorLogin ?? current.authorLogin ?? null,
            viewerLogin: read.viewerLogin ?? current.viewerLogin ?? null,
            viewerRequested: plan.viewerRequested,
          });
          const peopleChanged = (current: ReviewSession) => {
            const next = people(current);
            return (
              next.authorLogin !== (current.authorLogin ?? null) ||
              next.viewerLogin !== (current.viewerLogin ?? null) ||
              next.viewerRequested !== (current.viewerRequested ?? false)
            );
          };
          const headChanged = read.headSha !== null && session.headSha !== read.headSha;
          const githubStates = existingItems.flatMap((item) => {
            const next = itemGithubState(item.githubThreadIds, plan.threads);
            return next !== null && next !== item.githubState
              ? [{ number: item.number, next }]
              : [];
          });
          if (
            plan.upserts.length === 0 &&
            plan.removals.length === 0 &&
            githubStates.length === 0 &&
            !headChanged &&
            missingRaw.length === 0 &&
            !peopleChanged(session) &&
            repairUnknownLocalSources(existingItems).length === 0
          ) {
            return false;
          }
          // Allocate raw points inside the transaction, against the latest user/agent writes.
          // Existing points retain their decisions, annotations and replies.
          const written = yield* sql.withTransaction(
            Effect.gen(function* () {
              // The round may have moved on while GitHub was read: the plan would file new
              // reviews in a closed round. Skip; the sync the advance runs files them.
              const latest = yield* repo.getSession(session.id);
              if (
                Option.isNone(latest) ||
                latest.value.phase === "done" ||
                latest.value.round !== session.round ||
                (yield* currentRoundState(latest.value)) !== roundState
              ) {
                return false;
              }
              for (const { source, comments } of plan.upserts) {
                yield* repo.upsertSource(session.id, source, comments);
              }
              if (headChanged && session.headSha !== null) {
                yield* repo.markItemsStale(session.id);
                if (roundState === "collecting") {
                  const reverify = new Set(
                    existingItems
                      .filter(
                        (item) =>
                          item.lastSeenRound === session.round &&
                          (itemGithubState(item.githubThreadIds, plan.threads) ??
                            item.githubState) !== "resolved",
                      )
                      .flatMap((item) => item.sourceIds),
                  );
                  for (const source of yield* repo.listSources(session.id)) {
                    if (
                      source.round === session.round &&
                      source.state === "done" &&
                      !source.failed &&
                      reverify.has(source.id)
                    ) {
                      yield* repo.resetSourcesTriage(session.id, [source.id]);
                    }
                  }
                }
              }
              const items =
                roundState === "collecting"
                  ? rawReviewItems(
                      latest.value,
                      yield* repo.listItems(session.id),
                      rawSources,
                      rawOptions,
                    )
                  : [];
              for (const item of items) {
                yield* repo.upsertItem(session.id, {
                  ...item,
                  githubState: itemGithubState(item.githubThreadIds, plan.threads),
                });
              }
              if (items.length > 0 || headChanged || peopleChanged(latest.value))
                yield* repo.updateSession({
                  ...latest.value,
                  ...people(latest.value),
                  nextNumber: Math.max(
                    latest.value.nextNumber,
                    ...items.map((item) => item.number + 1),
                  ),
                  headSha: read.headSha ?? latest.value.headSha,
                  updatedAt: DateTime.formatIso(yield* DateTime.now),
                });
              // Refresh untouched raw text after a GitHub edit, while preserving triage and decisions.
              for (const { source, comments } of plan.upserts) {
                for (const before of commentsBySource.get(source.id) ?? []) {
                  const after = comments?.find((comment) => comment.key === before.key);
                  if (!after || after.body === before.body || !after.body.trim()) continue;
                  const number = yield* repo.findItemNumberByKeys(session.id, [before.key]);
                  if (Option.isNone(number)) continue;
                  const found = yield* repo.getItem(session.id, number.value);
                  if (Option.isNone(found)) continue;
                  const item = found.value;
                  if (item.problem !== before.body || item.impact !== "" || item.solution !== "")
                    continue;
                  const summary = after.body.trim().split("\n")[0]!.slice(0, 180);
                  yield* repo.upsertItem(session.id, {
                    ...item,
                    summary,
                    shortName: summary.slice(0, 60),
                    problem: after.body,
                    excerpt: after.diffHunk,
                    path: after.path,
                    line: after.line,
                    viewed: false,
                    updatedAt: source.updatedAt,
                  });
                }
              }
              for (const sourceId of plan.removals) yield* repo.deleteSource(session.id, sourceId);
              for (const item of repairUnknownLocalSources(yield* repo.listItems(session.id))) {
                yield* repo.upsertItem(session.id, item);
              }
              for (const { number, next } of githubStates) {
                yield* repo.setItemGithubState(session.id, number, next);
              }
              return true;
            }),
          );
          if (!written) return false;
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
    const live = yield* repo.listLiveSessions().pipe(Effect.orElseSucceed(() => []));
    // Finished reviews stay watched for a while so GitHub can bring them back: the newest one
    // of each pull request that has no live review.
    const since = DateTime.formatIso(
      DateTime.subtract(yield* DateTime.now, { days: REOPEN_WINDOW_DAYS }),
    );
    const finished = yield* repo.listFinishedSessions(since).pipe(Effect.orElseSucceed(() => []));
    const prKey = (session: ReviewSession) =>
      `${session.pullRequest.host}/${session.pullRequest.repository}#${session.pullRequest.number}`;
    const watched = new Set(live.map(prKey));
    const sessions = [...live];
    for (const session of finished) {
      if (watched.has(prKey(session))) continue;
      watched.add(prKey(session));
      sessions.push(session);
    }
    const ids = new Set(sessions.map((session) => session.id));
    for (const id of lastReads.keys()) if (!ids.has(id)) lastReads.delete(id);
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
    start: Effect.fn("ReviewSyncService.start")(() =>
      forkParked(
        sweep.pipe(
          // A defect in one sweep must not end the loop for the server's lifetime.
          Effect.catchCause((cause) => Effect.logWarning("review sync sweep failed", cause)),
          Effect.repeat(Schedule.spaced(`${SWEEP_MINUTES} minutes`)),
          Effect.asVoid,
        ),
      ),
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
