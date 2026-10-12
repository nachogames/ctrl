import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Chat groups, folded from thread-group application events by ThreadGroupStore.
  // JSON columns hold contract structs that are always read back whole.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_groups (
      group_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      goal TEXT,
      branch TEXT,
      worktree_path TEXT,
      pull_request_json TEXT,
      last_handoff_json TEXT,
      pinned_at TEXT,
      snoozed_until TEXT,
      settled_at TEXT,
      manual_resources_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_groups_project_id
    ON projection_thread_groups(project_id)
  `;

  // Thread group events join the application log. Replay reads it with
  // INDEXED BY this partial index, so it must cover the new kind and
  // OrchestrationEventStore's filter must repeat this WHERE term for term.
  // The old idx_orchestration_events_application_high_water stays as it was:
  // older builds name it with INDEXED BY and its original WHERE, and SQLite
  // fails their queries ("no query solution") if its predicate changes.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_events_application_high_water_v2
    ON orchestration_events(sequence)
    WHERE aggregate_kind IN ('project', 'thread-group')
      OR (application_event_version = 2 AND aggregate_kind = 'thread')
  `;
});
