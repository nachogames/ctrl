import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runCtrlMigrations } from "../CtrlMigrations.ts";
import { migrationEntries, runMigrations } from "../Migrations.ts";

const upstreamLatest = migrationEntries[migrationEntries.length - 1]![0];

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("Ctrl 001_ThreadGroups", (it) => {
  it.effect("adds the thread group read model and widens the application index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: upstreamLatest });
      yield* runCtrlMigrations({ toMigrationInclusive: 1 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_groups)
      `;
      assert.deepEqual(
        columns.map((column) => column.name),
        [
          "group_id",
          "project_id",
          "title",
          "goal",
          "branch",
          "worktree_path",
          "pull_request_json",
          "last_handoff_json",
          "pinned_at",
          "snoozed_until",
          "settled_at",
          "manual_resources_json",
          "created_at",
          "updated_at",
          "deleted_at",
        ],
      );
      const indexes = yield* sql<{ readonly sql: string }>`
        SELECT sql FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_orchestration_events_application_high_water_v2'
      `;
      assert.include(indexes[0]?.sql ?? "", "'thread-group'");
    }),
  );

  it.effect("keeps the old application index so older builds still plan their queries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const indexes = yield* sql<{ readonly sql: string }>`
        SELECT sql FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_orchestration_events_application_high_water'
      `;
      const definition = indexes[0]?.sql ?? "";
      assert.include(definition, "WHERE aggregate_kind = 'project'");
      assert.notInclude(definition, "'thread-group'");

      // The query an older build runs; SQLite rejects it if the index predicate changed.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT sequence
        FROM orchestration_events INDEXED BY idx_orchestration_events_application_high_water
        WHERE aggregate_kind = 'project'
          OR (application_event_version = 2 AND aggregate_kind = 'thread')
        ORDER BY sequence DESC
        LIMIT 1
      `;
      assert.match(
        plan.map((row) => row.detail).join("\n"),
        /USING (COVERING )?INDEX idx_orchestration_events_application_high_water\b/,
      );
    }),
  );
});
