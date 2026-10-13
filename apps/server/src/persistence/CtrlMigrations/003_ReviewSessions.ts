import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE review_sessions (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      number INTEGER NOT NULL,
      url TEXT NOT NULL,
      group_id TEXT NOT NULL,
      review_thread_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      round INTEGER NOT NULL,
      head_sha TEXT,
      next_number INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // One live review per pull request per group; finished ones stay as history.
  yield* sql`
    CREATE UNIQUE INDEX review_sessions_live_idx
    ON review_sessions(host, repository, number, group_id)
    WHERE phase <> 'done'
  `;
  yield* sql`CREATE INDEX review_sessions_thread_idx ON review_sessions(review_thread_id)`;
  yield* sql`
    CREATE TABLE review_rounds (
      session_id TEXT NOT NULL REFERENCES review_sessions(session_id) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      head_sha TEXT,
      state TEXT NOT NULL,
      applied_sha TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, round)
    )
  `;
  // A review that went into a round: a GitHub review, a pending request, or a local run.
  yield* sql`
    CREATE TABLE review_sources (
      session_id TEXT NOT NULL REFERENCES review_sessions(session_id) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      round INTEGER NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      author TEXT,
      is_bot INTEGER NOT NULL DEFAULT 0,
      commit_sha TEXT,
      comment_count INTEGER NOT NULL DEFAULT 0,
      triaged INTEGER NOT NULL DEFAULT 0,
      thread_id TEXT,
      ran_on_json TEXT,
      url TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, source_id)
    )
  `;
  yield* sql`
    CREATE INDEX review_sources_thread_idx ON review_sources(thread_id)
    WHERE thread_id IS NOT NULL
  `;
  // Exactly what each review said, so the panel can show it and triage can read it.
  yield* sql`
    CREATE TABLE review_source_comments (
      session_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      finding_key TEXT NOT NULL,
      thread_id TEXT,
      path TEXT,
      line INTEGER,
      body TEXT NOT NULL,
      url TEXT,
      diff_hunk TEXT,
      PRIMARY KEY (session_id, source_id, position),
      FOREIGN KEY (session_id, source_id)
        REFERENCES review_sources(session_id, source_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX review_source_comments_key_idx ON review_source_comments(session_id, finding_key)
  `;
  yield* sql`
    CREATE TABLE review_items (
      session_id TEXT NOT NULL REFERENCES review_sessions(session_id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      round INTEGER NOT NULL,
      last_seen_round INTEGER NOT NULL,
      sources_json TEXT NOT NULL,
      github_thread_ids_json TEXT NOT NULL,
      github_state TEXT,
      path TEXT,
      line INTEGER,
      summary TEXT NOT NULL,
      short_name TEXT NOT NULL,
      problem TEXT NOT NULL,
      impact TEXT NOT NULL,
      solution TEXT NOT NULL,
      skip_reason TEXT NOT NULL,
      excerpt TEXT,
      recommendation TEXT,
      suggested_decision TEXT,
      already_fixed_in_json TEXT,
      decision TEXT NOT NULL,
      decided_by TEXT,
      reason TEXT,
      conclusion TEXT,
      draft_reply TEXT,
      draft_reply_revision INTEGER NOT NULL DEFAULT 0,
      draft_reply_by TEXT,
      apply_state TEXT NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0,
      viewed INTEGER NOT NULL DEFAULT 0,
      side_thread_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, number)
    )
  `;
  yield* sql`
    CREATE INDEX review_items_side_thread_idx ON review_items(side_thread_id)
    WHERE side_thread_id IS NOT NULL
  `;
  // Every key a point was raised under (a GitHub thread, a local finding), so a
  // re-import finds the point instead of numbering it again.
  yield* sql`
    CREATE TABLE review_item_keys (
      session_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      number INTEGER NOT NULL,
      PRIMARY KEY (session_id, source_key),
      FOREIGN KEY (session_id, number)
        REFERENCES review_items(session_id, number) ON DELETE CASCADE
    )
  `;
});
