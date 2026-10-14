import { isActiveReviewItem } from "@t3tools/contracts";
import {
  CommandId,
  MessageId,
  ReviewSessionError,
  ReviewSessionId,
  type OrchestrationV2ThreadShell,
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
  type ReviewSource,
  type ReviewSourceComment,
  type ReviewSuggestedDecision,
  type ReviewTurnRequest,
  ThreadGroupId,
  ThreadId,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import { parseReviewPointTag } from "@t3tools/shared/reviewPointTag";
import { normalizeThreadPullRequestKey } from "@t3tools/shared/threadPullRequests";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import { forkParked } from "../serverActivation.ts";
import * as ThreadGroupService from "../orchestration-v2/ThreadGroupService.ts";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadGroupLaunchService from "../orchestration-v2/ThreadGroupLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ReviewSessions from "../persistence/ReviewSessions.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { checkDecisionQuote, decisionQuoteRefusalMessage } from "./decisionQuote.ts";
import { latestUserMessageText } from "./latestUserMessage.ts";
import * as ReviewSessionChanges from "./ReviewSessionChanges.ts";
import {
  localReviewPrompt,
  reviewRequestText,
  reviewSourceName,
  sideChatPrompt,
  sideChatTitle,
} from "./reviewPrompts.ts";
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

/** One problem the local review found; `slug` names the defect so later rounds match it. */
export interface ReviewLocalFinding {
  readonly path: string | null;
  readonly line: number | null;
  readonly title: string;
  readonly body: string;
  readonly slug: string;
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
    readonly discoverLinked: () => Effect.Effect<void, ReviewSessionError>;
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
    /**
     * The side chat about one point: the existing one while it lives, else a new chat in the
     * review's group seeded with only that point. The server sends the seed as the review
     * chat's agent, so it never counts as the user's words.
     */
    readonly openSideChat: (
      input: PointInput,
    ) => Effect.Effect<{ readonly threadId: ThreadId }, ReviewSessionError>;
    /** Your independent review of the round, in its own chat on the review chat's model. */
    readonly runLocalReview: (input: {
      readonly sessionId: ReviewSessionId;
    }) => Effect.Effect<{ readonly threadId: ThreadId }, ReviewSessionError>;
    /** The local review chat hands in its findings; its source becomes `done`. */
    readonly submitLocalFindings: (input: {
      readonly sessionId: ReviewSessionId;
      readonly sourceId: string;
      readonly headSha: string;
      readonly findings: ReadonlyArray<ReviewLocalFinding>;
    }) => Effect.Effect<ReviewSource, ReviewSessionError>;
    /** A Review tab button: a turn in the review chat, sent as the system. */
    readonly requestTurn: (input: {
      readonly sessionId: ReviewSessionId;
      readonly request: ReviewTurnRequest;
    }) => Effect.Effect<void, ReviewSessionError>;
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

const hasText = (text: string | null) => text !== null && text.trim() !== "";

/** A point raised again needs a new reply: triage's new draft, or none until one is written. */
const replyForNewRound = (item: ReviewItem, draftReply: string | null) =>
  hasText(draftReply)
    ? nextDraft(item, draftReply, "agent")
    : item.draftReply === null
      ? {}
      : { draftReply: null, draftReplyRevision: item.draftReplyRevision + 1, draftReplyBy: null };

/** The points the panel lists under the current round. */
const liveItems = (session: ReviewSession, items: ReadonlyArray<ReviewItem>) =>
  items.filter((item) => item.lastSeenRound === session.round && isActiveReviewItem(item));

/** `#N` of each live point the user has not yet viewed and decided. */
const unseenPoints = (session: ReviewSession, items: ReadonlyArray<ReviewItem>) =>
  liveItems(session, items)
    .filter((item) => !item.viewed || item.decision === "needs-call")
    .map((item) => `#${item.number}`);

const isOpen = (applyState: ReviewApplyState) =>
  applyState === "pending" || applyState === "working";

/** "Copilot", "Copilot and your review", "Copilot, @dan and your review". */
const namesOf = (names: ReadonlyArray<string>) => {
  const unique = [...new Set(names)];
  return unique.length <= 1
    ? (unique[0] ?? "")
    : `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
};

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* ReviewSessions.ReviewSessionRepository;
  const changes = yield* ReviewSessionChanges.ReviewSessionChanges;
  const sync = yield* ReviewSyncService.ReviewSyncService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const groups = yield* ThreadGroupService.ThreadGroupService;
  const discoveryLock = yield* Semaphore.make(1);
  const crypto = yield* Crypto.Crypto;
  const writeLock = yield* Semaphore.make(1);
  const launches = yield* ThreadGroupLaunchService.ThreadGroupLaunchService;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  // Two quick clicks must not start two chats.
  const launchLock = yield* Semaphore.make(1);

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

  /** A chat that still exists and is not archived; a deleted or archived chat is gone. */
  const liveThread = (threadId: ThreadId) =>
    threads
      .getThreadShell(threadId)
      .pipe(
        Effect.map((shell) =>
          shell !== null && shell.deletedAt === null && shell.archivedAt === null ? shell : null,
        ),
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
    const waiting = unseenPoints(session, items);
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
      // Stored and looked up in one case, so `Owner/Repo` and `owner/repo` are one review.
      const key = normalizeThreadPullRequestKey(input.key);
      const result = yield* writeLock.withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* repo.findLiveSession({ key, groupId: input.groupId });
            if (Option.isSome(existing)) {
              const session = existing.value;
              // A review whose chat was deleted or archived could never be driven again; the
              // chat that opens it takes it over, with its rounds, points and side chats.
              if (
                session.reviewThreadId === input.reviewThreadId ||
                (yield* liveThread(session.reviewThreadId)) !== null
              ) {
                return { session, created: false };
              }
              const at = yield* now;
              yield* repo.setSessionReviewThread({
                sessionId: session.id,
                reviewThreadId: input.reviewThreadId,
                updatedAt: at,
              });
              return {
                session: { ...session, reviewThreadId: input.reviewThreadId, updatedAt: at },
                created: false,
              };
            }
            const at = yield* now;
            const session: ReviewSession = {
              id: ReviewSessionId.make(`review:${yield* crypto.randomUUIDv4}`),
              projectId: input.projectId,
              pullRequest: key,
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
      return { snapshot: yield* read(result.session.id), created: result.created };
    }).pipe(Effect.mapError(keepReviewErrors()));

  const read: ReviewSessionService["Service"]["read"] = (sessionId) =>
    loadSession(sessionId).pipe(
      Effect.flatMap(snapshotOf),
      Effect.mapError(keepReviewErrors(sessionId)),
    );

  // Discovery never launches an agent. A group is allocated only for a PR-bearing chat.
  const ensureDiscovered = (input: ReviewSessionSubscribeInput) =>
    discoveryLock.withPermits(1)(
      Effect.gen(function* () {
        const shell = yield* liveThread(input.threadId);
        if (shell === null || shell.lineage.relationshipToParent === "subagent") return;
        if (!/^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(input.repository)) return;
        const groupId = shell.groupId ?? ThreadGroupId.make(`review-group:${shell.id}`);
        if (shell.groupId == null)
          yield* groups.create({
            commandId: CommandId.make(`review-group:${shell.id}:${yield* crypto.randomUUIDv4}`),
            groupId,
            projectId: shell.projectId,
            threadIds: [shell.id],
            title: shell.title,
          });
        const existing = yield* repo.findLatestSessionForPullRequest({
          repository: input.repository.toLowerCase(),
          number: input.number,
          groupId,
        });
        if (Option.isSome(existing)) return;
        yield* open({
          key: { host: "github.com", repository: input.repository, number: input.number },
          url: `https://github.com/${input.repository}/pull/${input.number}`,
          projectId: shell.projectId,
          groupId,
          reviewThreadId: shell.id,
          headSha: null,
        });
      }).pipe(Effect.mapError(keepReviewErrors())),
    );

  const discoverLinked: ReviewSessionService["Service"]["discoverLinked"] = () =>
    Effect.gen(function* () {
      const rows = yield* sql<{ thread_id: string; repository: string; number: number }>`
      SELECT t.thread_id, json_extract(link.value, '$.repository') AS repository,
        json_extract(link.value, '$.number') AS number
      FROM orchestration_v2_projection_threads t JOIN json_each(t.payload_json, '$.pullRequests') link
      WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
        AND json_extract(link.value, '$.host') = 'github.com'
        AND json_extract(link.value, '$.source') != 'stack-dismissed'
      UNION
      SELECT t.thread_id, json_extract(t.payload_json, '$.linkedPullRequest.repository'),
        json_extract(t.payload_json, '$.linkedPullRequest.number')
      FROM orchestration_v2_projection_threads t
      WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
        AND json_type(t.payload_json, '$.pullRequests') IS NULL
        AND json_type(t.payload_json, '$.linkedPullRequest') = 'object'
    `;
      for (const row of rows)
        yield* ensureDiscovered({
          threadId: ThreadId.make(row.thread_id),
          repository: row.repository,
          number: row.number,
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("review discovery failed", { cause: error.cause }),
          ),
        );
    }).pipe(Effect.mapError(keepReviewErrors()));

  const subscribe: ReviewSessionService["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the first read so a change landing between the two is not lost.
        const feed = yield* changes.subscribe;
        yield* ensureDiscovered(input);
        // The chat's group is read on every lookup: the agent may group the chat (or move it)
        // after the tab opened, and the open tab must then show that group's review.
        const lookup: Effect.Effect<ReviewSessionSubscribeResult, ReviewSessionError> =
          Effect.suspend(() => threads.getThreadShell(input.threadId)).pipe(
            Effect.orElseSucceed(() => null),
            Effect.flatMap((shell) => {
              const groupId = shell?.groupId ?? null;
              if (groupId === null) {
                return Effect.succeed<ReviewSessionSubscribeResult>({ snapshot: null });
              }
              return repo
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
            }),
          );
        const first = yield* lookup;
        // Re-read for this review, for any review while none is shown or it is done (a new one
        // for the same pull request may start), or once the chat has left the shown review's
        // group (another group's review may be the one to show).
        let shown = first.snapshot?.session ?? null;
        return Stream.concat(
          Stream.make(first),
          feed.pipe(
            Stream.filterEffect((sessionId) =>
              shown === null || shown.phase === "done" || sessionId === shown.id
                ? Effect.succeed(true)
                : threads.getThreadShell(input.threadId).pipe(
                    Effect.map((shell) => shell?.groupId !== shown?.groupId),
                    Effect.orElseSucceed(() => true),
                  ),
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
            const raisedAgain = item.lastSeenRound < session.round;
            yield* repo.upsertItem(session.id, {
              ...item,
              // AI may enrich raw GitHub feedback, but never replaces a user's decision/reply.
              ...(item.impact === "" && item.solution === "" && item.skipReason === ""
                ? {
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
                    ...(item.draftReply === null && incoming.draftReply !== null
                      ? {
                          draftReply: incoming.draftReply,
                          draftReplyBy: "agent" as const,
                          draftReplyRevision: item.draftReplyRevision + 1,
                        }
                      : {}),
                  }
                : {}),
              sourceKeys: union(item.sourceKeys, incoming.sourceKeys),
              sources: union(item.sources, incoming.sources),
              githubThreadIds: union(item.githubThreadIds, incoming.githubThreadIds),
              path: item.path ?? incoming.path,
              line: item.line ?? incoming.line,
              lastSeenRound: session.round,
              stale: false,
              // Raised again in a new round: the user looks at it again; the decision stays.
              viewed: raisedAgain ? false : item.viewed,
              // Last round's fix or reply does not answer this round's raising of it, and
              // its posted reply is not posted twice.
              applyState: raisedAgain ? "pending" : item.applyState,
              ...(raisedAgain ? replyForNewRound(item, incoming.draftReply) : {}),
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

  /**
   * A review cannot finish over a review of its round that is in but not triaged, or still
   * running: nothing could triage it once the review is done. A local run whose chat is gone
   * never hands in findings, so it does not hold the review.
   */
  const requireReviewsSettled = (session: ReviewSession) =>
    Effect.gen(function* () {
      const untriaged: Array<string> = [];
      const running: Array<string> = [];
      for (const source of yield* repo.listSources(session.id)) {
        if (source.round !== session.round) continue;
        if (source.state === "done" && !source.triaged) untriaged.push(reviewSourceName(source));
        if (source.state !== "requested" && source.state !== "reviewing") continue;
        if (source.kind === "local") {
          if (source.threadId === null || (yield* liveThread(source.threadId)) === null) continue;
        }
        running.push(reviewSourceName(source));
      }
      const clauses = [
        ...(untriaged.length === 0
          ? []
          : [
              `${namesOf(untriaged)} ${untriaged.length === 1 ? "is" : "are"} done but not triaged`,
            ]),
        ...(running.length === 0
          ? []
          : [`${namesOf(running)} ${running.length === 1 ? "is" : "are"} still reviewing`]),
      ];
      if (clauses.length === 0) return;
      return yield* fail(
        `The review cannot finish yet: ${clauses.join("; ")}. Triage what is in and wait for what is running (or withdraw that review request on GitHub), then finish.`,
        session.id,
      );
    });

  const advanceRound: ReviewSessionService["Service"]["advanceRound"] = (input) =>
    Effect.gen(function* () {
      const next = yield* write(
        input.sessionId,
        Effect.gen(function* () {
          const session = yield* loadSession(input.sessionId);
          yield* requireLive(session);
          const round = yield* loadRound(session);
          const items = yield* repo.listItems(session.id);
          if (round.state === "collecting") {
            const unseen = unseenPoints(session, items);
            if (unseen.length > 0) {
              return yield* fail(
                `${unseen.join(", ")} ${unseen.length === 1 ? "is" : "are"} not viewed yet: a round moves on only once every point in it is viewed and decided.`,
                session.id,
              );
            }
          }
          const live = liveItems(session, items);
          const unapplied = live
            .filter((item) => item.decision === "fix" && isOpen(item.applyState))
            .map((item) => `#${item.number}`);
          if (unapplied.length > 0) {
            return yield* fail(
              `Apply ${unapplied.join(", ")} first: decided fix and not yet pushed.`,
              session.id,
            );
          }
          // Every GitHub thread gets its drafted reply before the round closes; `fixed` is
          // not enough while a drafted reply waits on the thread.
          const unreplied = live
            .filter(
              (item) =>
                item.githubThreadIds.length > 0 &&
                hasText(item.draftReply) &&
                item.applyState !== "replied" &&
                item.applyState !== "resolved",
            )
            .map((item) => `#${item.number}`);
          if (unreplied.length > 0) {
            return yield* fail(
              `${unreplied.join(", ")}: reply not posted yet. Post it, then record it with review_items_record_apply.`,
              session.id,
            );
          }
          if (input.finish) yield* requireReviewsSettled(session);
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
            // A review that finished but was never triaged goes to the next round's triage.
            for (const source of yield* repo.listSources(session.id)) {
              if (source.round === session.round && source.state === "done" && !source.triaged) {
                yield* repo.moveSourceToRound(session.id, source.id, updated.round);
              }
            }
          }
          return updated;
        }),
      );
      // Files the re-requested Copilot and any review held back while the round applied.
      if (!input.finish) yield* syncQuietly(next.id);
      return yield* snapshotOf(next);
    }).pipe(Effect.mapError(keepReviewErrors(input.sessionId)));

  const reviewChatOf = (session: ReviewSession) =>
    liveThread(session.reviewThreadId).pipe(
      Effect.filterOrFail(
        (shell): shell is OrchestrationV2ThreadShell => shell !== null,
        () =>
          fail(
            "The review chat is gone. Ask for the review in another chat of this group (review_session_open) and it continues there.",
            session.id,
          ),
      ),
    );

  /**
   * A new chat in the review's group on the review chat's model and modes. The server sends
   * the seed after recording its review association, so tools are available immediately.
   */
  const launch = (session: ReviewSession, reviewChat: OrchestrationV2ThreadShell, title: string) =>
    Effect.gen(function* () {
      return yield* launches
        .newThread({
          commandId: CommandId.make(`review-chat:${yield* crypto.randomUUIDv4}`),
          groupId: session.groupId,
          title,
          modelSelection: reviewChat.modelSelection,
          runtimeMode: reviewChat.runtimeMode,
          interactionMode: reviewChat.interactionMode,
          senderThreadId: session.reviewThreadId,
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError((error) =>
            fail(`Could not start the chat: ${error.message}`, session.id),
          ),
        );
    });

  // Record the review association before dispatching the seed: the first turn can call tools.
  const seedChat = (session: ReviewSession, threadId: ThreadId, text: string) =>
    Effect.gen(function* () {
      const id = yield* crypto.randomUUIDv4;
      yield* threads.sendToThread({
        projectId: session.projectId,
        threadId,
        commandId: CommandId.make(`review-seed:${id}`),
        messageId: MessageId.make(`message:review-seed:${id}`),
        text,
        attachments: [],
        mode: "queue",
        senderThreadId: session.reviewThreadId,
        createdBy: "agent",
        creationSource: "server",
      });
    });

  const openSideChat: ReviewSessionService["Service"]["openSideChat"] = (input) =>
    launchLock
      .withPermits(1)(
        Effect.gen(function* () {
          const session = yield* loadSession(input.sessionId);
          yield* requireLive(session);
          const item = yield* loadItem(session.id, input.number);
          if (item.sideThreadId !== null && (yield* liveThread(item.sideThreadId)) !== null) {
            return { threadId: item.sideThreadId };
          }
          const launched = yield* launch(
            session,
            yield* reviewChatOf(session),
            sideChatTitle(item),
          );
          yield* write(
            session.id,
            Effect.gen(function* () {
              yield* repo.setItemSideThread({
                sessionId: session.id,
                number: item.number,
                threadId: launched.threadId,
                updatedAt: yield* now,
              });
            }),
          );
          yield* seedChat(session, launched.threadId, sideChatPrompt(session, item)).pipe(
            Effect.tapError(() =>
              write(
                session.id,
                Effect.gen(function* () {
                  yield* repo.setItemSideThread({
                    sessionId: session.id,
                    number: item.number,
                    threadId: null,
                    updatedAt: yield* now,
                  });
                }),
              ),
            ),
          );
          return { threadId: launched.threadId };
        }),
      )
      .pipe(Effect.mapError(keepReviewErrors(input.sessionId)));

  const runLocalReview: ReviewSessionService["Service"]["runLocalReview"] = (input) =>
    launchLock
      .withPermits(1)(
        Effect.gen(function* () {
          const session = yield* loadSession(input.sessionId);
          yield* requireLive(session);
          yield* requireCollecting(session, yield* loadRound(session));
          const running = (yield* repo.listSources(session.id)).filter(
            (source) =>
              source.kind === "local" &&
              source.round === session.round &&
              source.state === "reviewing",
          );
          const abandoned: Array<string> = [];
          for (const source of running) {
            if (source.threadId !== null && (yield* liveThread(source.threadId)) !== null) {
              return { threadId: source.threadId };
            }
            abandoned.push(source.id);
          }
          const reviewChat = yield* reviewChatOf(session);
          const instance = yield* providers.getInstance(reviewChat.modelSelection.instanceId);
          const launched = yield* launch(
            session,
            reviewChat,
            `Your review · round ${session.round}`,
          );
          const sourceId = `local:${yield* crypto.randomUUIDv4}`;
          yield* write(
            session.id,
            Effect.gen(function* () {
              // A run whose chat was deleted can never hand in findings; it must not
              // show as still reviewing next to the new one.
              for (const id of abandoned) yield* repo.deleteSource(session.id, id);
              yield* repo.upsertSource(
                session.id,
                {
                  id: sourceId,
                  round: session.round,
                  kind: "local",
                  state: "reviewing",
                  author: null,
                  isBot: false,
                  commitSha: null,
                  commentCount: 0,
                  triaged: false,
                  threadId: launched.threadId,
                  ranOn: {
                    instanceId: reviewChat.modelSelection.instanceId,
                    model: reviewChat.modelSelection.model,
                  },
                  url: null,
                  updatedAt: yield* now,
                },
                [],
              );
            }),
          );
          yield* seedChat(
            session,
            launched.threadId,
            localReviewPrompt({ session, driverKind: instance?.driverKind ?? null }),
          ).pipe(Effect.tapError(() => write(session.id, repo.deleteSource(session.id, sourceId))));
          return { threadId: launched.threadId };
        }),
      )
      .pipe(Effect.mapError(keepReviewErrors(input.sessionId)));

  const submitLocalFindings: ReviewSessionService["Service"]["submitLocalFindings"] = (input) =>
    write(
      input.sessionId,
      Effect.gen(function* () {
        const session = yield* loadSession(input.sessionId);
        yield* requireLive(session);
        const source = (yield* repo.listSources(session.id)).find(
          (candidate) => candidate.id === input.sourceId && candidate.kind === "local",
        );
        if (source === undefined) {
          return yield* fail("This chat is not running a review of this pull request.", session.id);
        }
        if (source.state === "done") {
          return yield* fail(
            "These findings are already in. Start a new run from the Review tab for another look.",
            session.id,
          );
        }
        const comments = input.findings.map((finding): ReviewSourceComment => ({
          key: `local:${finding.path ?? ""}:${finding.slug}`,
          threadId: null,
          path: finding.path,
          line: finding.line,
          body: `${finding.title}\n\n${finding.body}`,
          url: null,
          diffHunk: null,
        }));
        // A run can outlast its round. Its findings go to the current round's triage;
        // `commitSha` says which code they were about.
        const done: ReviewSource = {
          ...source,
          round: session.round,
          state: "done",
          commitSha: input.headSha,
          commentCount: comments.length,
          updatedAt: yield* now,
        };
        yield* repo.upsertSource(session.id, done, comments);
        if (source.round !== session.round) {
          yield* repo.moveSourceToRound(session.id, source.id, session.round);
        }
        return done;
      }),
    ).pipe(Effect.mapError(keepReviewErrors(input.sessionId)));

  const requestTurn: ReviewSessionService["Service"]["requestTurn"] = (input) =>
    Effect.gen(function* () {
      const session = yield* loadSession(input.sessionId);
      yield* requireLive(session);
      yield* requireCollecting(session, yield* loadRound(session));
      yield* reviewChatOf(session);
      const request = input.request;
      let item: ReviewItem | null = null;
      let untriaged: ReadonlyArray<ReviewSource> = [];
      if (request._tag === "triage") {
        untriaged = (yield* repo.listSources(session.id)).filter(
          (source) => source.round === session.round && source.state === "done" && !source.triaged,
        );
        if (untriaged.length === 0) {
          return yield* fail("No finished review is waiting for triage in this round.", session.id);
        }
      }
      if (request._tag === "rewrite-reply") {
        item = yield* loadItem(session.id, request.number);
        yield* requireCurrent(session, item);
      }
      if (request._tag === "apply") {
        // The panel shows "Waiting" on every point from the moment the user confirms.
        // Checked again under the lock: a point may have changed since the reads above.
        yield* write(
          session.id,
          Effect.gen(function* () {
            const current = yield* loadSession(session.id);
            yield* requireLive(current);
            const round = yield* loadRound(current);
            yield* requireCollecting(current, round);
            yield* applyGate(current, yield* repo.listItems(current.id));
            yield* repo.upsertRound(current.id, {
              ...round,
              state: "applying",
              updatedAt: yield* now,
            });
          }),
        );
      }
      // The agent never got the request, so the round goes back to collecting.
      const moveBack = write(
        session.id,
        Effect.gen(function* () {
          const current = yield* loadSession(session.id);
          const round = yield* loadRound(current);
          if (current.round === session.round && round.state === "applying") {
            yield* repo.upsertRound(current.id, {
              ...round,
              state: "collecting",
              updatedAt: yield* now,
            });
          }
        }),
      );
      const id = yield* crypto.randomUUIDv4;
      yield* threads
        .sendToThread({
          projectId: session.projectId,
          commandId: CommandId.make(`review-request:${id}`),
          threadId: session.reviewThreadId,
          messageId: MessageId.make(`message:review-request:${id}`),
          text: reviewRequestText({ session, request, item, sources: untriaged }),
          attachments: [],
          mode: "queue",
          // Sent as the system so the quote guard never reads it as the user's words.
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReviewSessionError({
                message: "The review chat could not be reached.",
                sessionId: session.id,
                cause,
              }),
          ),
          Effect.tapError(() => (request._tag === "apply" ? moveBack : Effect.void)),
        );
    }).pipe(Effect.mapError(keepReviewErrors(input.sessionId)));

  return ReviewSessionService.of({
    discoverLinked,
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
    openSideChat,
    runLocalReview,
    submitLocalFindings,
    requestTurn,
  });
});

export const layer = Layer.effect(ReviewSessionService, make);

/** Discover links after restart and as chats acquire PRs, without starting provider turns. */
export const layerStart = Layer.effectDiscard(
  Effect.gen(function* () {
    const reviews = yield* ReviewSessionService;
    yield* forkParked(
      reviews.discoverLinked().pipe(
        Effect.catchCause((cause) => Effect.logWarning("review discovery sweep failed", cause)),
        Effect.repeat(Schedule.spaced("30 seconds")),
        Effect.asVoid,
      ),
    );
  }),
);
