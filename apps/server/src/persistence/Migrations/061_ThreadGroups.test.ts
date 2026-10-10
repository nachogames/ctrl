import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("061_ThreadGroups", (it) => {
  it.effect("adds the thread group read model and widens the application index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* runMigrations({ toMigrationInclusive: 61 });

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
        WHERE type = 'index' AND name = 'idx_orchestration_events_application_high_water'
      `;
      assert.include(indexes[0]?.sql ?? "", "'thread-group'");
    }),
  );
});
