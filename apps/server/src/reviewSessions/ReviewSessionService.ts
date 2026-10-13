import {
  ReviewSessionError,
  ReviewSessionId,
  type ProjectId,
  type ReviewAlreadyFixedIn,
  type ReviewApplyState,
  type ReviewDecision,
  type ReviewEditor,
  type ReviewItem,
  type ReviewItemSource,
  type ReviewRound,
  type ReviewSession,
  type ReviewSessionSnapshot,
  type ReviewSessionSubscribeInput,
  type ReviewSessionSubscribeResult,
  type ReviewSourceComment,
  type ReviewSuggestedDecision,
  type ThreadGroupId,
  type ThreadId,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import { parseReviewPointTag } from "@t3tools/shared/reviewPointTag";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ReviewSessions from "../persistence/ReviewSessions.ts";
import { checkDecisionQuote, decisionQuoteRefusalMessage } from "./decisionQuote.ts";
import { latestUserMessageText } from "./latestUserMessage.ts";
import * as ReviewSessionChanges from "./ReviewSessionChanges.ts";
import { reviewStackNeighbours, type ReviewStackNeighbour } from "./reviewStack.ts";
import * as ReviewSyncService from "./ReviewSyncService.ts";

export interface ReviewSessionOpenInput {
  readonly key: ThreadPullRequestKey;
  readonly url: string;
  readonly projectId: ProjectId;
  readonly groupId: ThreadGroupId;
  readonly reviewThreadId: ThreadId;
  readonly headSha: string | null;
}

/** One point from triage. Its keys find it again in later imports. */
export interface ReviewImportItem {
  readonly sourceKeys: ReadonlyArray<string>;
  readonly sources: ReadonlyArray<ReviewItemSource>;
  readonly githubThreadIds: ReadonlyArray<string>;
  readonly path: string | null;
  readonly line: number | null;
  readonly summary: string;
  readonly shortName: string;
  readonly problem: string;
  readonly impact: string;
  readonly solution: string;
  readonly skipReason: string;
  readonly excerpt: string | null;
  readonly recommendation: string | null;
  readonly suggestedDecision: ReviewSuggestedDecision | null;
  readonly alreadyFixedIn: ReviewAlreadyFixedIn | null;
  readonly draftReply: string | null;
}

export interface ReviewImportResult {
  readonly snapshot: ReviewSessionSnapshot;
  readonly created: ReadonlyArray<number>;
  readonly matched: ReadonlyArray<number>;
}

/** Fields the agent may rewrite. Undefined keeps a field; null clears a nullable one. */
export interface ReviewItemAnnotation {
  readonly summary?: string | undefined;
  readonly shortName?: string | undefined;
  readonly problem?: string | undefined;
  readonly impact?: string | undefined;
  readonly solution?: string | undefined;
  readonly skipReason?: string | undefined;
  readonly excerpt?: string | null | undefined;
  readonly recommendation?: string | null | undefined;
  readonly suggestedDecision?: ReviewSuggestedDecision | null | undefined;
  readonly alreadyFixedIn?: ReviewAlreadyFixedIn | null | undefined;
  readonly conclusion?: string | null | undefined;
  readonly draftReply?: string | null | undefined;
}

/** Who decided: the agent quoting the user's latest message in `threadId`, or the user in the panel. */
export type ReviewDecisionAuthority =
  | { readonly _tag: "chat"; readonly threadId: ThreadId; readonly quote: string }
  | { readonly _tag: "panel" };

/** What a chat may do: run the review, discuss one point, or submit its independent review. */
export type ReviewChatRole = "review" | "side" | "local";

export interface ReviewSessionAccess {
  readonly session: ReviewSession;
  readonly role: ReviewChatRole;
  /** The one point a side chat may act on. */
  readonly scopedToItem: number | null;
  /** The source row a local review chat fills. */
  readonly localSourceId: string | null;
}

/** What the agent reads each turn: the list, what each review said, the point in focus, the stack. */
export interface ReviewAgentView {
  readonly snapshot: ReviewSessionSnapshot;
  readonly comments: Readonly<Record<string, ReadonlyArray<ReviewSourceComment>>>;
  readonly focusedItem: number | null;
  readonly stack: ReadonlyArray<ReviewStackNeighbour>;
}

type PointInput = { readonly sessionId: ReviewSessionId; readonly number: number };

export class ReviewSessionService extends Context.Service<
  ReviewSessionService,
  {
    /** The live review of this pull request in this group, created when there is none. */
    readonly open: (
      input: ReviewSessionOpenInput,
    ) => Effect.Effect<
      { readonly snapshot: ReviewSessionSnapshot; readonly created: boolean },
      ReviewSessionError
    >;
    readonly read: (
      sessionId: ReviewSessionId,
    ) => Effect.Effect<ReviewSessionSnapshot, ReviewSessionError>;
    /** The pull request's review in the chat's group: now, then after every change to it. */
    readonly subscribe: (
      input: ReviewSessionSubscribeInput,
    ) => Stream.Stream<ReviewSessionSubscribeResult, ReviewSessionError>;
    readonly readSourceComments: (input: {
      readonly sessionId: ReviewSessionId;
      readonly sourceId: string;
    }) => Effect.Effect<ReadonlyArray<ReviewSourceComment>, ReviewSessionError>;
    /** The review a chat acts on, and in which role. */
    readonly resolveForThread: (input: {
      readonly threadId: ThreadId;
      readonly groupId: ThreadGroupId | null;
    }) => Effect.Effect<ReviewSessionAccess, ReviewSessionError>;
    readonly agentView: (input: {
      readonly sessionId: ReviewSessionId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<ReviewAgentView, ReviewSessionError>;
    /** Adds new points and merges known ones by key; marks the covered reviews triaged. */
    readonly importItems: (input: {
      readonly sessionId: ReviewSessionId;
      readonly sourceIds: ReadonlyArray<string>;
      readonly items: ReadonlyArray<ReviewImportItem>;
    }) => Effect.Effect<ReviewImportResult, ReviewSessionError>;
    readonly annotate: (
      input: PointInput & { readonly annotation: ReviewItemAnnotation },
    ) => Effect.Effect<ReviewItem, ReviewSessionError>;
    /** A changed decision resets the point to `pending` and unviewed. */
    readonly decide: (
      input: PointInput & {
        readonly decision: ReviewDecision;
        readonly reason?: string | undefined;
        readonly authority: ReviewDecisionAuthority;
      },
    ) => Effect.Effect<ReviewItem, ReviewSessionError>;
    /** The panel's Viewed box. Viewing a point that needs a call adopts Claude's suggestion. */
    readonly setViewed: (
      input: PointInput & { readonly viewed: boolean },
    ) => Effect.Effect<ReviewItem, ReviewSessionError>;
    /** The user's own edit of a reply draft. */
    readonly editReply: (
      input: PointInput & { readonly draftReply: string },
    ) => Effect.Effect<ReviewItem, ReviewSessionError>;
    /** The first result of a round's apply moves the round to `applying`; needs every point viewed. */
    readonly recordApply: (
      input: PointInput & {
        readonly applyState: ReviewApplyState;
        readonly conclusion?: string | undefined;
        readonly draftReply?: string | undefined;
      },
    ) => Effect.Effect<ReviewItem, ReviewSessionError>;
    /** Closes the round on the pushed `headSha` and opens the next, or finishes the review. */
    readonly advanceRound: (input: {
      readonly sessionId: ReviewSessionId;
      readonly headSha: string;
      readonly finish: boolean;
    }) => Effect.Effect<ReviewSessionSnapshot, ReviewSessionError>;
  }
>()("t3/reviewSessions/ReviewSessionService") {}

const fail = (message: string, sessionId?: ReviewSessionId) =>
  new ReviewSessionError({ message, ...(sessionId === undefined ? {} : { sessionId }) });

const isReviewSessionError = Schema.is(ReviewSessionError);

/** Storage failures keep their cause for logs but tell the agent only that saving failed. */
const keepReviewErrors =
  (sessionId?: ReviewSessionId) =>
  (error: unknown): ReviewSessionError =>
    isReviewSessionError(error)
      ? error
      : new ReviewSessionError({
          message: "The review list could not be read or saved.",
          ...(sessionId === undefined ? {} : { sessionId }),
          cause: error,
        });

const union = <A>(left: ReadonlyArray<A>, right: ReadonlyArray<A>): ReadonlyArray<A> => [
  ...new Set([...left, ...right]),
];

const now = Effect.map(DateTime.now, DateTime.formatIso);

/** A reply write: a new revision whenever the text changes, so the panel can mark it. */
const nextDraft = (item: ReviewItem, draftReply: string | null, by: ReviewEditor) =>
  draftReply === item.draftReply
    ? {}
    : { draftReply, draftReplyRevision: item.draftReplyRevision + 1, draftReplyBy: by };

/** The points the panel lists under the current round. */
const liveItems = (session: ReviewSession, items: ReadonlyArray<ReviewItem>) =>
  items.filter((item) => item.lastSeenRound === session.round && !item.stale);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* ReviewSessions.ReviewSessionRepository;
  const changes = yield* ReviewSessionChanges.ReviewSessionChanges;
  const sync = yield* ReviewSyncService.ReviewSyncService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const writeLock = yield* Semaphore.make(1);

  /** Read-modify-write under one lock and one transaction; subscribers hear of it after commit. */
  const write = <A, E, R>(sessionId: ReviewSessionId, effect: Effect.Effect<A, E, R>) =>
    writeLock
      .withPermits(1)(sql.withTransaction(effect))
      .pipe(Effect.tap(() => changes.publish(sessionId)));

  // Best-effort: GitHub being down must not block opening or advancing a review.
  const syncQuietly = (sessionId: ReviewSessionId) =>
    sync.syncSession(sessionId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("review sync failed", { sessionId, cause: error.cause }),
      ),
      Effect.asVoid,
    );

  const loadSession = (sessionId: ReviewSessionId) =>
    repo.getSession(sessionId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail(`Review ${sessionId} was not found.`, sessionId)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const loadItem = (sessionId: ReviewSessionId, number: number) =>
    repo.getItem(sessionId, number).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail(`#${number} is not in this review.`, sessionId)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const loadRound = (session: ReviewSession) =>
    repo.listRounds(session.id).pipe(
      Effect.flatMap((rounds) => {
        const round = rounds.find((candidate) => candidate.round === session.round);
        return round === undefined
          ? Effect.fail(fail(`Round ${session.round} is missing.`, session.id))
          : Effect.succeed(round);
      }),
    );

  const requireLive = (session: ReviewSession) =>
    session.phase === "done"
      ? Effect.fail(
          fail("This review is finished. Open a new one with review_session_open.", session.id),
        )
      : Effect.void;

  const requireCollecting = (session: ReviewSession, round: ReviewRound) =>
    round.state === "collecting"
      ? Effect.void
      : Effect.fail(
          fail(
            round.state === "applying"
              ? `Round ${round.round} is being applied. New points and changes go into the next round.`
              : `Round ${round.round} is applied.`,
            session.id,
          ),
        );

  const requireCurrent = (session: ReviewSession, item: ReviewItem) =>
    item.lastSeenRound === session.round && !item.stale
      ? Effect.void
      : Effect.fail(
          fail(
            `#${item.number} belongs to round ${item.lastSeenRound}, not the current round.`,
            session.id,
          ),
        );

  const applyGate = (session: ReviewSession, items: ReadonlyArray<ReviewItem>) => {
    const waiting = liveItems(session, items)
      .filter((item) => !item.viewed || item.decision === "needs-call")
      .map((item) => `#${item.number}`);
    return waiting.length === 0
      ? Effect.void
      : Effect.fail(
          fail(
            `View ${waiting.join(", ")} first: a round is applied only once every point in it is viewed.`,
            session.id,
          ),
        );
  };

  const snapshotOf = (session: ReviewSession) =>
    Effect.all([
      repo.listRounds(session.id),
      repo.listSources(session.id),
      repo.listItems(session.id),
    ]).pipe(
      Effect.map(([rounds, sources, items]): ReviewSessionSnapshot => ({
        session,
        rounds,
        sources,
        items,
      })),
    );

  /** Loads a live session and one of its points of the current, still-collecting round. */
  const loadEditable = (input: PointInput) =>
    Effect.gen(function* () {
      const session = yield* loadSession(input.sessionId);
      yield* requireLive(session);
      yield* requireCollecting(session, yield* loadRound(session));
      const item = yield* loadItem(session.id, input.number);
      yield* requireCurrent(session, item);
      return { session, item };
    });

  const open: ReviewSessionService["Service"]["open"] = (input) =>
    Effect.gen(function* () {
      const result = yield* writeLock.withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* repo.findLiveSession({
              key: input.key,
              groupId: input.groupId,
            });
            if (Option.isSome(existing)) return { session: existing.value, created: false };
            const at = yield* now;
            const session: ReviewSession = {
              id: ReviewSessionId.make(`review:${yield* crypto.randomUUIDv4}`),
              projectId: input.projectId,
              pullRequest: input.key,
              url: input.url,
              groupId: input.groupId,
              reviewThreadId: input.reviewThreadId,
              phase: "self-review",
              round: 1,
              headSha: input.headSha,
              nextNumber: 1,
              createdAt: at,
              updatedAt: at,
            };
            yield* repo.insertSession(session);
            yield* repo.upsertRound(session.id, {
              round: 1,
              headSha: input.headSha,
              state: "collecting",
              appliedSha: null,
              createdAt: at,
              updatedAt: at,
            });
            return { session, created: true };
          }),
        ),
      );
      yield* changes.publish(result.session.id);
      yield* syncQuietly(result.session.id);
      return { snapshot: yield* snapshotOf(result.session), created: result.created };
    }).pipe(Effect.mapError(keepReviewErrors()));

  const read: ReviewSessionService["Service"]["read"] = (sessionId) =>
    loadSession(sessionId).pipe(
      Effect.flatMap(snapshotOf),
      Effect.mapError(keepReviewErrors(sessionId)),
    );

  const subscribe: ReviewSessionService["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the first read so a change landing between the two is not lost.
        const feed = yield* changes.subscribe;
        const shell = yield* threads
          .getThreadShell(input.threadId)
          .pipe(Effect.orElseSucceed(() => null));
        const groupId = shell?.groupId ?? null;
        const lookup: Effect.Effect<ReviewSessionSubscribeResult, ReviewSessionError> =
          groupId === null
            ? Effect.succeed({ snapshot: null })
            : repo
                .findLatestSessionForPullRequest({
                  repository: input.repository,
                  number: input.number,
                  groupId,
                })
                .pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () =>
                        Effect.succeed<ReviewSessionSubscribeResult>({ snapshot: null }),
                      onSome: (session) =>
                        snapshotOf(session).pipe(Effect.map((snapshot) => ({ snapshot }))),
                    }),
                  ),
                  Effect.mapError(keepReviewErrors()),
                );
        const first = yield* lookup;
        // Re-read only for this review, or for any review while none is shown or it is done
        // (a new one for the same pull request may start).
        let shown = first.snapshot?.session ?? null;
        return Stream.concat(
          Stream.make(first),
          feed.pipe(
            Stream.filter(
              (sessionId) => shown === null || shown.phase === "done" || sessionId === shown.id,
            ),
            Stream.mapEffect(() => lookup),
            Stream.tap((result) =>
              Effect.sync(() => {
                shown = result.snapshot?.session ?? null;
              }),
            ),
          ),
        );
      }),
    );

  const readSourceComments: ReviewSessionService["Service"]["readSourceComments"] = (input) =>
    repo
      .listSourceComments(input.sessionId, input.sourceId)
      .pipe(Effect.mapError(keepReviewErrors(input.sessionId)));

  const resolveForThread: ReviewSessionService["Service"]["resolveForThread"] = (input) =>
    Effect.gen(function* () {
      const local = yield* repo.findLocalSourceByThread(input.threadId);
      if (Option.isSome(local)) {
        return {
          session: yield* loadSession(local.value.sessionId),
          role: "local" as const,
          scopedToItem: null,
          localSourceId: local.value.sourceId,
        };
      }
      const side = yield* repo.findSideChatItem(input.threadId);
      if (Option.isSome(side)) {
        return {
          session: yield* loadSession(side.value.sessionId),
          role: "side" as const,
          scopedToItem: side.value.number,
          localSourceId: null,
        };
      }
      const asReview = (session: ReviewSession): ReviewSessionAccess => ({
        session,
        role: "review",
        scopedToItem: null,
        localSourceId: null,
      });
      const own = yield* repo.listLiveSessionsForThread(input.threadId);
      if (own.length === 1) return asReview(own[0]!);
      if (own.length > 1) {
        return yield* fail("This chat drives several reviews; finish one before using the tools.");
      }
      if (input.groupId !== null) {
        const inGroup = yield* repo.listLiveSessionsForGroup(input.groupId);
        if (inGroup.length === 1) return asReview(inGroup[0]!);
        if (inGroup.length > 1) {
          return yield* fail(
            "This group has several live reviews; continue in the review chat of the one you mean.",
          );
        }
      }
      return yield* fail("No review is open for this chat. Start one with review_session_open.");
    }).pipe(Effect.mapError(keepReviewErrors()));

  const agentView: ReviewSessionService["Service"]["agentView"] = (input) =>
    Effect.gen(function* () {
      const session = yield* loadSession(input.sessionId);
      const snapshot = yield* snapshotOf(session);
      const comments = Object.fromEntries(
        yield* Effect.forEach(snapshot.sources, (source) =>
          repo
            .listSourceComments(session.id, source.id)
            .pipe(Effect.map((list) => [source.id, list] as const)),
        ),
      );
      const message = yield* latestUserMessageText(input.threadId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      const shells = yield* threads
        .listProjectThreads({ projectId: session.projectId, includeSubagents: false })
        .pipe(Effect.orElseSucceed(() => []));
      return {
        snapshot,
        comments,
        focusedItem: message === null ? null : (parseReviewPointTag(message)?.number ?? null),
        stack: reviewStackNeighbours(
          shells.flatMap((shell) => shell.pullRequests ?? []),
          session.pullRequest,
        ),
      };
    }).pipe(Effect.mapError(keepReviewErrors(input.sessionId)));

  const importItems: ReviewSessionService["Service"]["importItems"] = (input) =>
    write(
      input.sessionId,
      Effect.gen(function* () {
        const session = yield* loadSession(input.sessionId);
        yield* requireLive(session);
        yield* requireCollecting(session, yield* loadRound(session));
        const sources = yield* repo.listSources(session.id);
        const unknown = input.sourceIds.filter(
          (id) =>
            !sources.some(
              (source) =>
                source.id === id && source.round === session.round && source.state === "done",
            ),
        );
        if (unknown.length > 0) {
          return yield* fail(
            `Not a finished review of round ${session.round}: ${unknown.join(", ")}. Read the list again with review_session_read.`,
            session.id,
          );
        }
        yield* repo.markSourcesTriaged(session.id, input.sourceIds);
        const at = yield* now;
        let nextNumber = session.nextNumber;
        const created: Array<number> = [];
        const matched: Array<number> = [];
        for (const incoming of input.items) {
          const found = yield* repo.findItemNumberByKeys(session.id, incoming.sourceKeys);
          const existing = Option.isSome(found)
            ? yield* repo.getItem(session.id, found.value)
            : Option.none<ReviewItem>();
          if (Option.isSome(existing)) {
            const item = existing.value;
            yield* repo.upsertItem(session.id, {
              ...item,
              sourceKeys: union(item.sourceKeys, incoming.sourceKeys),
              sources: union(item.sources, incoming.sources),
              githubThreadIds: union(item.githubThreadIds, incoming.githubThreadIds),
              path: item.path ?? incoming.path,
              line: item.line ?? incoming.line,
              lastSeenRound: session.round,
              stale: false,
              // Raised again in a new round: the user looks at it again; the decision stays.
              viewed: item.lastSeenRound < session.round ? false : item.viewed,
              updatedAt: at,
            });
            if (!created.includes(item.number) && !matched.includes(item.number)) {
              matched.push(item.number);
            }
            continue;
          }
          const number = nextNumber;
          nextNumber += 1;
          yield* repo.upsertItem(session.id, {
            number,
            round: session.round,
            lastSeenRound: session.round,
            sourceKeys: [...incoming.sourceKeys],
            sources: [...incoming.sources],
            sourceIds: [],
            githubThreadIds: [...incoming.githubThreadIds],
            githubState: null,
            path: incoming.path,
            line: incoming.line,
            summary: incoming.summary,
            shortName: incoming.shortName,
            problem: incoming.problem,
            impact: incoming.impact,
            solution: incoming.solution,
            skipReason: incoming.skipReason,
            excerpt: incoming.excerpt,
            recommendation: incoming.recommendation,
            suggestedDecision: incoming.suggestedDecision,
            alreadyFixedIn: incoming.alreadyFixedIn,
            decision: "needs-call",
            decidedBy: null,
            reason: null,
            conclusion: null,
            draftReply: incoming.draftReply,
            draftReplyRevision: incoming.draftReply === null ? 0 : 1,
            draftReplyBy: incoming.draftReply === null ? null : "agent",
            applyState: "pending",
            stale: false,
            viewed: false,
            sideThreadId: null,
            updatedAt: at,
          });
          created.push(number);
        }
        const updated: ReviewSession = { ...session, nextNumber, updatedAt: at };
        yield* repo.updateSession(updated);
        return { snapshot: yield* snapshotOf(updated), created, matched };
      }),
    ).pipe(Effect.mapError(keepReviewErrors(input.sessionId)));

  const annotate: ReviewSessionService["Service"]["annotate"] = (input) =>
    write(
      input.sessionId,
      Effect.gen(function* () {
        const session = yield* loadSession(input.sessionId);
        yield* requireLive(session);
        const item = yield* loadItem(session.id, input.number);
        const patch = input.annotation;
        const suggestedDecision =
          patch.suggestedDecision === undefined ? item.suggestedDecision : patch.suggestedDecision;
        const next: ReviewItem = {
          ...item,
          summary: patch.summary ?? item.summary,
          shortName: patch.shortName ?? item.shortName,
          problem: patch.problem ?? item.problem,
          impact: patch.impact ?? item.impact,
          solution: patch.solution ?? item.solution,
          skipReason: patch.skipReason ?? item.skipReason,
          excerpt: patch.excerpt === undefined ? item.excerpt : patch.excerpt,
          recommendation:
            patch.recommendation === undefined ? item.recommendation : patch.recommendation,
          alreadyFixedIn:
            patch.alreadyFixedIn === undefined ? item.alreadyFixedIn : patch.alreadyFixedIn,
          conclusion: patch.conclusion === undefined ? item.conclusion : patch.conclusion,
          suggestedDecision,
          // A new suggestion is something the user has not seen yet.
          viewed: suggestedDecision === item.suggestedDecision ? item.viewed : false,
          ...(patch.draftReply === undefined ? {} : nextDraft(item, patch.draftReply, "agent")),
          updatedAt: yield* now,
        };
        yield* repo.upsertItem(session.id, next);
        return next;
      }),
    ).pipe(Effect.mapError(keepReviewErrors(input.sessionId)));

  const decide: ReviewSessionService["Service"]["decide"] = (input) =>
    Effect.gen(function* () {
      if (input.authority._tag === "chat") {
        const message = yield* latestUserMessageText(input.authority.threadId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        const refusal = checkDecisionQuote({
          latestUserMessage: message,
          quote: input.authority.quote,
          number: input.number,
        });
        if (refusal !== null) {
          return yield* fail(decisionQuoteRefusalMessage(refusal, input.number), input.sessionId);
        }
      }
      return yield* write(
        input.sessionId,
        Effect.gen(function* () {
          const { session, item } = yield* loadEditable(input);
          const changed = input.decision !== item.decision;
          const next: ReviewItem = {
            ...item,
            decision: input.decision,
            decidedBy: input.decision === "needs-call" ? null : input.authority._tag,
            reason: input.reason ?? (changed ? null : item.reason),
            applyState: changed ? "pending" : item.applyState,
            viewed: changed ? false : item.viewed,
            updatedAt: yield* now,
          };
          yield* repo.upsertItem(session.id, next);
          return next;
        }),
      );
    }).pipe(Effect.mapError(keepReviewErrors(input.sessionId)));

  const setViewed: ReviewSessionService["Service"]["setViewed"] = (input) =>
    write(
      input.sessionId,
      Effect.gen(function* () {
        const { session, item } = yield* loadEditable(input);
        const at = yield* now;
        let next: ReviewItem = { ...item, viewed: input.viewed, updatedAt: at };
        if (input.viewed && item.decision === "needs-call") {
          if (item.suggestedDecision === null) {
            return yield* fail(`Pick Fix or Decline for #${item.number} first.`, session.id);
          }
          next = {
            ...next,
            decision: item.suggestedDecision,
            decidedBy: "panel",
            applyState: "pending",
          };
        }
        yield* repo.upsertItem(session.id, next);
        return next;
      }),
    ).pipe(Effect.mapError(keepReviewErrors(input.sessionId)));

  const editReply: ReviewSessionService["Service"]["editReply"] = (input) =>
    write(
      input.sessionId,
      Effect.gen(function* () {
        const { session, item } = yield* loadEditable(input);
        const next: ReviewItem = {
          ...item,
          ...nextDraft(item, input.draftReply, "panel"),
          updatedAt: yield* now,
        };
        yield* repo.upsertItem(session.id, next);
        return next;
      }),
    ).pipe(Effect.mapError(keepReviewErrors(input.sessionId)));

  const recordApply: ReviewSessionService["Service"]["recordApply"] = (input) =>
    write(
      input.sessionId,
      Effect.gen(function* () {
        const session = yield* loadSession(input.sessionId);
        yield* requireLive(session);
        const round = yield* loadRound(session);
        if (round.state === "applied") {
          return yield* fail(`Round ${round.round} is already applied.`, session.id);
        }
        const item = yield* loadItem(session.id, input.number);
        yield* requireCurrent(session, item);
        const at = yield* now;
        if (round.state === "collecting") {
          yield* applyGate(session, yield* repo.listItems(session.id));
          yield* repo.upsertRound(session.id, { ...round, state: "applying", updatedAt: at });
        }
        const next: ReviewItem = {
          ...item,
          applyState: input.applyState,
          conclusion: input.conclusion ?? item.conclusion,
          ...(input.draftReply === undefined ? {} : nextDraft(item, input.draftReply, "agent")),
          updatedAt: at,
        };
        yield* repo.upsertItem(session.id, next);
        return next;
      }),
    ).pipe(Effect.mapError(keepReviewErrors(input.sessionId)));

  const advanceRound: ReviewSessionService["Service"]["advanceRound"] = (input) =>
    Effect.gen(function* () {
      const next = yield* write(
        input.sessionId,
        Effect.gen(function* () {
          const session = yield* loadSession(input.sessionId);
          yield* requireLive(session);
          const round = yield* loadRound(session);
          const unapplied = liveItems(session, yield* repo.listItems(session.id))
            .filter(
              (item) =>
                item.decision === "fix" &&
                (item.applyState === "pending" || item.applyState === "working"),
            )
            .map((item) => `#${item.number}`);
          if (unapplied.length > 0) {
            return yield* fail(
              `Apply ${unapplied.join(", ")} first: decided fix and not yet pushed.`,
              session.id,
            );
          }
          const at = yield* now;
          yield* repo.upsertRound(session.id, {
            ...round,
            state: "applied",
            appliedSha: input.headSha,
            updatedAt: at,
          });
          const updated: ReviewSession = input.finish
            ? { ...session, phase: "done", headSha: input.headSha, updatedAt: at }
            : { ...session, round: session.round + 1, headSha: input.headSha, updatedAt: at };
          yield* repo.updateSession(updated);
          if (!input.finish) {
            yield* repo.upsertRound(session.id, {
              round: updated.round,
              headSha: input.headSha,
              state: "collecting",
              appliedSha: null,
              createdAt: at,
              updatedAt: at,
            });
            // Points stay stale until a new round's import raises them again.
            yield* repo.markItemsStale(session.id);
          }
          return updated;
        }),
      );
      // Files the re-requested Copilot and any review held back while the round applied.
      if (!input.finish) yield* syncQuietly(next.id);
      return yield* snapshotOf(next);
    }).pipe(Effect.mapError(keepReviewErrors(input.sessionId)));

  return ReviewSessionService.of({
    open,
    read,
    subscribe,
    readSourceComments,
    resolveForThread,
    agentView,
    importItems,
    annotate,
    decide,
    setViewed,
    editReply,
    recordApply,
    advanceRound,
  });
});

export const layer = Layer.effect(ReviewSessionService, make);
