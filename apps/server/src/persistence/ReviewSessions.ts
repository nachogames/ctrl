import {
  ReviewItem,
  ReviewRanOn,
  ReviewRound,
  ReviewSession,
  ReviewSessionId,
  ReviewSource,
  ReviewSourceComment,
  ReviewAlreadyFixedIn,
  type ReviewGithubState,
  type ThreadGroupId,
  type ThreadId,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

export type ReviewSessionRepositoryError = PersistenceSqlError | PersistenceDecodeError;

interface SessionRow {
  readonly session_id: string;
  readonly project_id: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly group_id: string;
  readonly review_thread_id: string;
  readonly phase: string;
  readonly round: number;
  readonly head_sha: string | null;
  readonly next_number: number;
  readonly author_login: string | null;
  readonly viewer_login: string | null;
  readonly viewer_requested: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RoundRow {
  readonly round: number;
  readonly head_sha: string | null;
  readonly state: string;
  readonly applied_sha: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface SourceRow {
  readonly submitted_at: string | null;
  readonly failed: number;
  readonly verdict: string | null;
  readonly posted: number;
  readonly source_id: string;
  readonly round: number;
  readonly kind: string;
  readonly state: string;
  readonly author: string | null;
  readonly is_bot: number;
  readonly commit_sha: string | null;
  readonly comment_count: number;
  readonly triaged: number;
  readonly thread_id: string | null;
  readonly ran_on_json: string | null;
  readonly url: string | null;
  readonly updated_at: string;
}

interface CommentRow {
  readonly finding_key: string;
  readonly thread_id: string | null;
  readonly path: string | null;
  readonly line: number | null;
  readonly body: string;
  readonly url: string | null;
  readonly diff_hunk: string | null;
}

interface ItemRow {
  readonly number: number;
  readonly round: number;
  readonly last_seen_round: number;
  readonly source_keys_json: string;
  readonly source_ids_json: string;
  readonly sources_json: string;
  readonly github_thread_ids_json: string;
  readonly github_state: string | null;
  readonly path: string | null;
  readonly line: number | null;
  readonly summary: string;
  readonly short_name: string;
  readonly problem: string;
  readonly impact: string;
  readonly solution: string;
  readonly skip_reason: string;
  readonly excerpt: string | null;
  readonly recommendation: string | null;
  readonly suggested_decision: string | null;
  readonly already_fixed_in_json: string | null;
  readonly decision: string;
  readonly decided_by: string | null;
  readonly reason: string | null;
  readonly conclusion: string | null;
  readonly draft_reply: string | null;
  readonly draft_reply_revision: number;
  readonly draft_reply_by: string | null;
  readonly apply_state: string;
  readonly stale: number;
  readonly viewed: number;
  readonly side_thread_id: string | null;
  readonly updated_at: string;
}

const StringListJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeStringList = Schema.decodeUnknownEffect(StringListJson);
const encodeStringList = Schema.encodeSync(StringListJson);
const RanOnJson = Schema.fromJsonString(ReviewRanOn);
const decodeRanOn = Schema.decodeUnknownEffect(RanOnJson);
const encodeRanOn = Schema.encodeSync(RanOnJson);
const FixedInJson = Schema.fromJsonString(ReviewAlreadyFixedIn);
const decodeFixedIn = Schema.decodeUnknownEffect(FixedInJson);
const encodeFixedIn = Schema.encodeSync(FixedInJson);
const decodeSession = Schema.decodeUnknownEffect(ReviewSession);
const decodeRound = Schema.decodeUnknownEffect(ReviewRound);
const decodeSource = Schema.decodeUnknownEffect(ReviewSource);
const decodeComment = Schema.decodeUnknownEffect(ReviewSourceComment);
const decodeItem = Schema.decodeUnknownEffect(ReviewItem);

const sqlError = (operation: string) => (cause: unknown) =>
  new PersistenceSqlError({ operation, cause });
const decodeError = (operation: string) => (cause: Schema.SchemaError) =>
  PersistenceDecodeError.fromSchemaError(operation, cause);

const sessionFromRow = (row: SessionRow) =>
  decodeSession({
    id: row.session_id,
    projectId: row.project_id,
    pullRequest: { host: row.host, repository: row.repository, number: row.number },
    url: row.url,
    groupId: row.group_id,
    reviewThreadId: row.review_thread_id,
    phase: row.phase,
    round: row.round,
    headSha: row.head_sha,
    nextNumber: row.next_number,
    authorLogin: row.author_login,
    viewerLogin: row.viewer_login,
    viewerRequested: row.viewer_requested === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }).pipe(Effect.mapError(decodeError("ReviewSession")));

const roundFromRow = (row: RoundRow) =>
  decodeRound({
    round: row.round,
    headSha: row.head_sha,
    state: row.state,
    appliedSha: row.applied_sha,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }).pipe(Effect.mapError(decodeError("ReviewRound")));

const sourceFromRow = (row: SourceRow) =>
  Effect.gen(function* () {
    return yield* decodeSource({
      id: row.source_id,
      submittedAt: row.submitted_at,
      failed: row.failed === 1,
      round: row.round,
      kind: row.kind,
      state: row.state,
      author: row.author,
      isBot: row.is_bot === 1,
      commitSha: row.commit_sha,
      commentCount: row.comment_count,
      triaged: row.triaged === 1,
      threadId: row.thread_id,
      ranOn: row.ran_on_json === null ? null : yield* decodeRanOn(row.ran_on_json),
      url: row.url,
      verdict: row.verdict,
      posted: row.posted === 1,
      updatedAt: row.updated_at,
    });
  }).pipe(Effect.mapError(decodeError("ReviewSource")));

const commentFromRow = (row: CommentRow) =>
  decodeComment({
    key: row.finding_key,
    threadId: row.thread_id,
    path: row.path,
    line: row.line,
    body: row.body,
    url: row.url,
    diffHunk: row.diff_hunk,
  }).pipe(Effect.mapError(decodeError("ReviewSourceComment")));

const itemFromRow = (row: ItemRow) =>
  Effect.gen(function* () {
    const sourceKeys = yield* decodeStringList(row.source_keys_json);
    const sourceIds = yield* decodeStringList(row.source_ids_json);
    return yield* decodeItem({
      number: row.number,
      round: row.round,
      lastSeenRound: row.last_seen_round,
      // SQLite's aggregates have no order; sort so reads are stable.
      sourceKeys: [...sourceKeys].sort(),
      sourceIds: [...sourceIds].sort(),
      sources: yield* decodeStringList(row.sources_json),
      githubThreadIds: yield* decodeStringList(row.github_thread_ids_json),
      githubState: row.github_state,
      path: row.path,
      line: row.line,
      summary: row.summary,
      shortName: row.short_name,
      problem: row.problem,
      impact: row.impact,
      solution: row.solution,
      skipReason: row.skip_reason,
      excerpt: row.excerpt,
      recommendation: row.recommendation,
      suggestedDecision: row.suggested_decision,
      alreadyFixedIn:
        row.already_fixed_in_json === null ? null : yield* decodeFixedIn(row.already_fixed_in_json),
      decision: row.decision,
      decidedBy: row.decided_by,
      reason: row.reason,
      conclusion: row.conclusion,
      draftReply: row.draft_reply,
      draftReplyRevision: row.draft_reply_revision,
      draftReplyBy: row.draft_reply_by,
      applyState: row.apply_state,
      stale: row.stale === 1,
      viewed: row.viewed === 1,
      sideThreadId: row.side_thread_id,
      updatedAt: row.updated_at,
    });
  }).pipe(Effect.mapError(decodeError("ReviewItem")));

type E = ReviewSessionRepositoryError;

/** Review sessions, rounds, sources and points. The review services are the only writers. */
export class ReviewSessionRepository extends Context.Service<
  ReviewSessionRepository,
  {
    readonly insertSession: (session: ReviewSession) => Effect.Effect<void, E>;
    readonly updateSession: (session: ReviewSession) => Effect.Effect<void, E>;
    readonly getSession: (id: ReviewSessionId) => Effect.Effect<Option.Option<ReviewSession>, E>;
    /** Hands the review to another chat; only for a review whose chat is gone. */
    readonly setSessionReviewThread: (input: {
      readonly sessionId: ReviewSessionId;
      readonly reviewThreadId: ThreadId;
      readonly updatedAt: string;
    }) => Effect.Effect<void, E>;
    readonly findLiveSession: (input: {
      readonly key: ThreadPullRequestKey;
      readonly groupId: ThreadGroupId;
    }) => Effect.Effect<Option.Option<ReviewSession>, E>;
    /** The newest review of a pull request in a group, finished or not, for the Review tab. */
    readonly findLatestSessionForPullRequest: (input: {
      readonly repository: string;
      readonly number: number;
      readonly groupId: ThreadGroupId;
    }) => Effect.Effect<Option.Option<ReviewSession>, E>;
    readonly listLiveSessions: () => Effect.Effect<ReadonlyArray<ReviewSession>, E>;
    readonly listLiveSessionsForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ReviewSession>, E>;
    readonly listLiveSessionsForGroup: (
      groupId: ThreadGroupId,
    ) => Effect.Effect<ReadonlyArray<ReviewSession>, E>;
    readonly upsertRound: (
      sessionId: ReviewSessionId,
      round: ReviewRound,
    ) => Effect.Effect<void, E>;
    /** Newest first. */
    readonly listRounds: (
      sessionId: ReviewSessionId,
    ) => Effect.Effect<ReadonlyArray<ReviewRound>, E>;
    /** Keeps `round` and `triaged` of a known source; null `comments` keeps the stored ones. */
    readonly upsertSource: (
      sessionId: ReviewSessionId,
      source: ReviewSource,
      comments: ReadonlyArray<ReviewSourceComment> | null,
    ) => Effect.Effect<void, E>;
    readonly listSources: (
      sessionId: ReviewSessionId,
    ) => Effect.Effect<ReadonlyArray<ReviewSource>, E>;
    readonly listSourceComments: (
      sessionId: ReviewSessionId,
      sourceId: string,
    ) => Effect.Effect<ReadonlyArray<ReviewSourceComment>, E>;
    readonly deleteSource: (sessionId: ReviewSessionId, sourceId: string) => Effect.Effect<void, E>;
    /**
     * Files a review under a later round, keeping its triage mark and comments. Only the
     * review service moves rounds; `upsertSource` keeps a known source's round.
     */
    readonly moveSourceToRound: (
      sessionId: ReviewSessionId,
      sourceId: string,
      round: number,
    ) => Effect.Effect<void, E>;
    readonly markSourcesTriaged: (
      sessionId: ReviewSessionId,
      sourceIds: ReadonlyArray<string>,
    ) => Effect.Effect<void, E>;
    readonly resetSourcesTriage: (
      sessionId: ReviewSessionId,
      sourceIds: ReadonlyArray<string>,
    ) => Effect.Effect<void, E>;
    /** The live local review run a chat was started for. */
    readonly findLocalSourceByThread: (
      threadId: ThreadId,
    ) => Effect.Effect<
      Option.Option<{ readonly sessionId: ReviewSessionId; readonly sourceId: string }>,
      E
    >;
    readonly listItems: (sessionId: ReviewSessionId) => Effect.Effect<ReadonlyArray<ReviewItem>, E>;
    readonly getItem: (
      sessionId: ReviewSessionId,
      number: number,
    ) => Effect.Effect<Option.Option<ReviewItem>, E>;
    /** Writes the point and records each of its keys; keys are never removed. */
    readonly upsertItem: (sessionId: ReviewSessionId, item: ReviewItem) => Effect.Effect<void, E>;
    readonly setItemGithubState: (
      sessionId: ReviewSessionId,
      number: number,
      state: ReviewGithubState,
    ) => Effect.Effect<void, E>;
    readonly findItemNumberByKeys: (
      sessionId: ReviewSessionId,
      keys: ReadonlyArray<string>,
    ) => Effect.Effect<Option.Option<number>, E>;
    readonly setItemSideThread: (input: {
      readonly sessionId: ReviewSessionId;
      readonly number: number;
      readonly threadId: ThreadId | null;
      readonly updatedAt: string;
    }) => Effect.Effect<void, E>;
    readonly markItemsStale: (sessionId: ReviewSessionId) => Effect.Effect<void, E>;
    /** The live point a side chat was started for. */
    readonly findSideChatItem: (
      threadId: ThreadId,
    ) => Effect.Effect<
      Option.Option<{ readonly sessionId: ReviewSessionId; readonly number: number }>,
      E
    >;
  }
>()("t3/persistence/ReviewSessions/ReviewSessionRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const sessions = (rows: ReadonlyArray<SessionRow>) => Effect.forEach(rows, sessionFromRow);
  const firstSession = (rows: ReadonlyArray<SessionRow>) =>
    rows.length === 0
      ? Effect.succeed(Option.none<ReviewSession>())
      : sessionFromRow(rows[0]!).pipe(Effect.map(Option.some));
  const firstItem = (rows: ReadonlyArray<ItemRow>) =>
    rows.length === 0
      ? Effect.succeed(Option.none<ReviewItem>())
      : itemFromRow(rows[0]!).pipe(Effect.map(Option.some));

  // Keys come from review_item_keys; the review rows are the sources whose comments carry them.
  // A `<body key>#<slug>` key is one finding inside a review body, so it belongs to that review.
  const itemSelect = sql`
    SELECT i.*,
      (SELECT json_group_array(k.source_key) FROM review_item_keys k
        WHERE k.session_id = i.session_id AND k.number = i.number) AS source_keys_json,
      (SELECT json_group_array(DISTINCT c.source_id)
         FROM review_item_keys k
         JOIN review_source_comments c
           ON c.session_id = k.session_id
          AND (c.finding_key = k.source_key
            OR substr(k.source_key, 1, length(c.finding_key) + 1) = c.finding_key || '#')
        WHERE k.session_id = i.session_id AND k.number = i.number) AS source_ids_json
    FROM review_items i
  `;

  return ReviewSessionRepository.of({
    insertSession: (session) =>
      sql`
        INSERT INTO review_sessions
          (session_id, project_id, host, repository, number, url, group_id, review_thread_id,
           phase, round, head_sha, next_number, author_login, viewer_login, viewer_requested,
           created_at, updated_at)
        VALUES (${session.id}, ${session.projectId}, ${session.pullRequest.host},
                ${session.pullRequest.repository}, ${session.pullRequest.number}, ${session.url},
                ${session.groupId}, ${session.reviewThreadId}, ${session.phase}, ${session.round},
                ${session.headSha}, ${session.nextNumber}, ${session.authorLogin ?? null},
                ${session.viewerLogin ?? null}, ${session.viewerRequested ? 1 : 0},
                ${session.createdAt}, ${session.updatedAt})
      `.pipe(Effect.asVoid, Effect.mapError(sqlError("insertReviewSession"))),
    updateSession: (session) =>
      sql`
        UPDATE review_sessions
        SET phase = ${session.phase}, round = ${session.round}, head_sha = ${session.headSha},
            next_number = ${session.nextNumber}, author_login = ${session.authorLogin ?? null},
            viewer_login = ${session.viewerLogin ?? null},
            viewer_requested = ${session.viewerRequested ? 1 : 0},
            updated_at = ${session.updatedAt}
        WHERE session_id = ${session.id}
      `.pipe(Effect.asVoid, Effect.mapError(sqlError("updateReviewSession"))),
    getSession: (id) =>
      sql<SessionRow>`SELECT * FROM review_sessions WHERE session_id = ${id}`.pipe(
        Effect.mapError(sqlError("getReviewSession")),
        Effect.flatMap(firstSession),
      ),
    setSessionReviewThread: ({ sessionId, reviewThreadId, updatedAt }) =>
      sql`
        UPDATE review_sessions SET review_thread_id = ${reviewThreadId}, updated_at = ${updatedAt}
        WHERE session_id = ${sessionId}
      `.pipe(Effect.asVoid, Effect.mapError(sqlError("setReviewSessionThread"))),
    findLiveSession: ({ key, groupId }) =>
      sql<SessionRow>`
        SELECT * FROM review_sessions
        WHERE host = ${key.host} AND repository = ${key.repository} AND number = ${key.number}
          AND group_id = ${groupId} AND phase <> 'done'
      `.pipe(Effect.mapError(sqlError("findLiveReviewSession")), Effect.flatMap(firstSession)),
    findLatestSessionForPullRequest: ({ repository, number, groupId }) =>
      // Host is left out: one group never reviews two hosts' copies of the same repository.
      sql<SessionRow>`
        SELECT * FROM review_sessions
        WHERE lower(repository) = lower(${repository}) AND number = ${number}
          AND group_id = ${groupId}
        ORDER BY created_at DESC, session_id DESC LIMIT 1
      `.pipe(
        Effect.mapError(sqlError("findLatestReviewSessionForPullRequest")),
        Effect.flatMap(firstSession),
      ),
    listLiveSessions: () =>
      sql<SessionRow>`
        SELECT * FROM review_sessions WHERE phase <> 'done' ORDER BY created_at, session_id
      `.pipe(Effect.mapError(sqlError("listLiveReviewSessions")), Effect.flatMap(sessions)),
    listLiveSessionsForThread: (threadId) =>
      sql<SessionRow>`
        SELECT * FROM review_sessions
        WHERE review_thread_id = ${threadId} AND phase <> 'done'
        ORDER BY created_at, session_id
      `.pipe(
        Effect.mapError(sqlError("listLiveReviewSessionsForThread")),
        Effect.flatMap(sessions),
      ),
    listLiveSessionsForGroup: (groupId) =>
      sql<SessionRow>`
        SELECT * FROM review_sessions
        WHERE group_id = ${groupId} AND phase <> 'done'
        ORDER BY created_at, session_id
      `.pipe(Effect.mapError(sqlError("listLiveReviewSessionsForGroup")), Effect.flatMap(sessions)),
    upsertRound: (sessionId, round) =>
      sql`
        INSERT INTO review_rounds
          (session_id, round, head_sha, state, applied_sha, created_at, updated_at)
        VALUES (${sessionId}, ${round.round}, ${round.headSha}, ${round.state},
                ${round.appliedSha}, ${round.createdAt}, ${round.updatedAt})
        ON CONFLICT (session_id, round) DO UPDATE SET
          head_sha = excluded.head_sha,
          state = excluded.state,
          applied_sha = excluded.applied_sha,
          updated_at = excluded.updated_at
      `.pipe(Effect.asVoid, Effect.mapError(sqlError("upsertReviewRound"))),
    listRounds: (sessionId) =>
      sql<RoundRow>`
        SELECT * FROM review_rounds WHERE session_id = ${sessionId} ORDER BY round DESC
      `.pipe(
        Effect.mapError(sqlError("listReviewRounds")),
        Effect.flatMap((rows) => Effect.forEach(rows, roundFromRow)),
      ),
    upsertSource: (sessionId, source, comments) =>
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO review_sources (
            session_id, source_id, round, kind, state, author, is_bot, commit_sha,
            comment_count, triaged, thread_id, ran_on_json, url, updated_at, submitted_at, failed,
            verdict, posted
          ) VALUES (
            ${sessionId}, ${source.id}, ${source.round}, ${source.kind}, ${source.state},
            ${source.author}, ${source.isBot ? 1 : 0}, ${source.commitSha},
            ${source.commentCount}, ${source.triaged ? 1 : 0}, ${source.threadId},
            ${source.ranOn === null ? null : encodeRanOn(source.ranOn)}, ${source.url},
            ${source.updatedAt}, ${source.submittedAt ?? null}, ${source.failed ? 1 : 0},
            ${source.verdict ?? null}, ${source.posted ? 1 : 0}
          )
          ON CONFLICT (session_id, source_id) DO UPDATE SET
            submitted_at = excluded.submitted_at,
            failed = excluded.failed,
            verdict = excluded.verdict,
            posted = excluded.posted,
            triaged = MAX(review_sources.triaged, excluded.triaged),
            kind = excluded.kind,
            state = excluded.state,
            author = excluded.author,
            is_bot = excluded.is_bot,
            commit_sha = excluded.commit_sha,
            comment_count = excluded.comment_count,
            thread_id = excluded.thread_id,
            ran_on_json = excluded.ran_on_json,
            url = excluded.url,
            updated_at = excluded.updated_at
        `;
        if (comments === null) return;
        yield* sql`
          DELETE FROM review_source_comments
          WHERE session_id = ${sessionId} AND source_id = ${source.id}
        `;
        for (const [position, comment] of comments.entries()) {
          yield* sql`
            INSERT INTO review_source_comments
              (session_id, source_id, position, finding_key, thread_id, path, line, body, url, diff_hunk)
            VALUES (${sessionId}, ${source.id}, ${position}, ${comment.key}, ${comment.threadId},
                    ${comment.path}, ${comment.line}, ${comment.body}, ${comment.url},
                    ${comment.diffHunk})
          `;
        }
      }).pipe(Effect.mapError(sqlError("upsertReviewSource"))),
    listSources: (sessionId) =>
      sql<SourceRow>`
        SELECT * FROM review_sources WHERE session_id = ${sessionId}
        ORDER BY round DESC, COALESCE(submitted_at, updated_at), source_id
      `.pipe(
        Effect.mapError(sqlError("listReviewSources")),
        Effect.flatMap((rows) => Effect.forEach(rows, sourceFromRow)),
      ),
    listSourceComments: (sessionId, sourceId) =>
      sql<CommentRow>`
        SELECT * FROM review_source_comments
        WHERE session_id = ${sessionId} AND source_id = ${sourceId}
        ORDER BY position
      `.pipe(
        Effect.mapError(sqlError("listReviewSourceComments")),
        Effect.flatMap((rows) => Effect.forEach(rows, commentFromRow)),
      ),
    deleteSource: (sessionId, sourceId) =>
      sql`
        DELETE FROM review_sources WHERE session_id = ${sessionId} AND source_id = ${sourceId}
      `.pipe(Effect.asVoid, Effect.mapError(sqlError("deleteReviewSource"))),
    moveSourceToRound: (sessionId, sourceId, round) =>
      sql`
        UPDATE review_sources SET round = ${round}
        WHERE session_id = ${sessionId} AND source_id = ${sourceId}
      `.pipe(Effect.asVoid, Effect.mapError(sqlError("moveReviewSourceToRound"))),
    markSourcesTriaged: (sessionId, sourceIds) =>
      sourceIds.length === 0
        ? Effect.void
        : sql`
            UPDATE review_sources SET triaged = 1
            WHERE session_id = ${sessionId} AND source_id IN ${sql.in([...sourceIds])}
          `.pipe(Effect.asVoid, Effect.mapError(sqlError("markReviewSourcesTriaged"))),
    resetSourcesTriage: (sessionId, sourceIds) =>
      sourceIds.length === 0
        ? Effect.void
        : sql`
      UPDATE review_sources SET triaged = 0
      WHERE session_id = ${sessionId} AND source_id IN ${sql.in([...sourceIds])}
    `.pipe(Effect.asVoid, Effect.mapError(sqlError("resetReviewSourcesTriage"))),
    findLocalSourceByThread: (threadId) =>
      sql<{ readonly session_id: string; readonly source_id: string }>`
        SELECT r.session_id, r.source_id
        FROM review_sources r JOIN review_sessions s ON s.session_id = r.session_id
        WHERE r.thread_id = ${threadId} AND r.kind = 'local' AND s.phase <> 'done'
        LIMIT 1
      `.pipe(
        Effect.mapError(sqlError("findLocalReviewSource")),
        Effect.map((rows) =>
          rows.length === 0
            ? Option.none()
            : Option.some({
                sessionId: ReviewSessionId.make(rows[0]!.session_id),
                sourceId: rows[0]!.source_id,
              }),
        ),
      ),
    listItems: (sessionId) =>
      sql<ItemRow>`${itemSelect} WHERE i.session_id = ${sessionId} ORDER BY i.number`.pipe(
        Effect.mapError(sqlError("listReviewItems")),
        Effect.flatMap((rows) => Effect.forEach(rows, itemFromRow)),
      ),
    getItem: (sessionId, number) =>
      sql<ItemRow>`
        ${itemSelect} WHERE i.session_id = ${sessionId} AND i.number = ${number}
      `.pipe(Effect.mapError(sqlError("getReviewItem")), Effect.flatMap(firstItem)),
    upsertItem: (sessionId, item) =>
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO review_items (
            session_id, number, round, last_seen_round, sources_json, github_thread_ids_json,
            github_state, path, line, summary, short_name, problem, impact, solution, skip_reason,
            excerpt, recommendation, suggested_decision, already_fixed_in_json, decision,
            decided_by, reason, conclusion, draft_reply, draft_reply_revision, draft_reply_by,
            apply_state, stale, viewed, side_thread_id, updated_at
          ) VALUES (
            ${sessionId}, ${item.number}, ${item.round}, ${item.lastSeenRound},
            ${encodeStringList(item.sources)}, ${encodeStringList(item.githubThreadIds)},
            ${item.githubState}, ${item.path}, ${item.line}, ${item.summary}, ${item.shortName},
            ${item.problem}, ${item.impact}, ${item.solution}, ${item.skipReason}, ${item.excerpt},
            ${item.recommendation}, ${item.suggestedDecision},
            ${item.alreadyFixedIn === null ? null : encodeFixedIn(item.alreadyFixedIn)},
            ${item.decision}, ${item.decidedBy}, ${item.reason}, ${item.conclusion},
            ${item.draftReply}, ${item.draftReplyRevision}, ${item.draftReplyBy},
            ${item.applyState}, ${item.stale ? 1 : 0}, ${item.viewed ? 1 : 0},
            ${item.sideThreadId}, ${item.updatedAt}
          )
          ON CONFLICT (session_id, number) DO UPDATE SET
            round = excluded.round,
            last_seen_round = excluded.last_seen_round,
            sources_json = excluded.sources_json,
            github_thread_ids_json = excluded.github_thread_ids_json,
            path = excluded.path,
            line = excluded.line,
            summary = excluded.summary,
            short_name = excluded.short_name,
            problem = excluded.problem,
            impact = excluded.impact,
            solution = excluded.solution,
            skip_reason = excluded.skip_reason,
            excerpt = excluded.excerpt,
            recommendation = excluded.recommendation,
            suggested_decision = excluded.suggested_decision,
            already_fixed_in_json = excluded.already_fixed_in_json,
            decision = excluded.decision,
            decided_by = excluded.decided_by,
            reason = excluded.reason,
            conclusion = excluded.conclusion,
            draft_reply = excluded.draft_reply,
            draft_reply_revision = excluded.draft_reply_revision,
            draft_reply_by = excluded.draft_reply_by,
            apply_state = excluded.apply_state,
            stale = excluded.stale,
            viewed = excluded.viewed,
            side_thread_id = excluded.side_thread_id,
            updated_at = excluded.updated_at
        `;
        for (const sourceKey of item.sourceKeys) {
          yield* sql`
            INSERT OR IGNORE INTO review_item_keys (session_id, source_key, number)
            VALUES (${sessionId}, ${sourceKey}, ${item.number})
          `;
        }
      }).pipe(Effect.mapError(sqlError("upsertReviewItem"))),
    setItemGithubState: (sessionId, number, state) =>
      sql`
        UPDATE review_items SET github_state = ${state}
        WHERE session_id = ${sessionId} AND number = ${number}
      `.pipe(Effect.asVoid, Effect.mapError(sqlError("setReviewItemGithubState"))),
    findItemNumberByKeys: (sessionId, keys) =>
      keys.length === 0
        ? Effect.succeed(Option.none<number>())
        : sql<{ readonly number: number }>`
            SELECT number FROM review_item_keys
            WHERE session_id = ${sessionId} AND source_key IN ${sql.in([...keys])}
            ORDER BY number LIMIT 1
          `.pipe(
            Effect.mapError(sqlError("findReviewItemByKeys")),
            Effect.map((rows) =>
              rows.length === 0 ? Option.none<number>() : Option.some(rows[0]!.number),
            ),
          ),
    setItemSideThread: ({ sessionId, number, threadId, updatedAt }) =>
      sql`
        UPDATE review_items SET side_thread_id = ${threadId}, updated_at = ${updatedAt}
        WHERE session_id = ${sessionId} AND number = ${number}
      `.pipe(Effect.asVoid, Effect.mapError(sqlError("setReviewItemSideThread"))),
    markItemsStale: (sessionId) =>
      sql`UPDATE review_items SET stale = 1 WHERE session_id = ${sessionId}`.pipe(
        Effect.asVoid,
        Effect.mapError(sqlError("markReviewItemsStale")),
      ),
    findSideChatItem: (threadId) =>
      sql<{ readonly session_id: string; readonly number: number }>`
        SELECT i.session_id, i.number
        FROM review_items i JOIN review_sessions s ON s.session_id = i.session_id
        WHERE i.side_thread_id = ${threadId} AND s.phase <> 'done'
        LIMIT 1
      `.pipe(
        Effect.mapError(sqlError("findReviewSideChatItem")),
        Effect.map((rows) =>
          rows.length === 0
            ? Option.none()
            : Option.some({
                sessionId: ReviewSessionId.make(rows[0]!.session_id),
                number: rows[0]!.number,
              }),
        ),
      ),
  });
});

export const layer = Layer.effect(ReviewSessionRepository, make);
