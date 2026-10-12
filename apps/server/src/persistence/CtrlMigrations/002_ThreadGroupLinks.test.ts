import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runCtrlMigrations } from "../CtrlMigrations.ts";
import { migrationEntries, runMigrations } from "../Migrations.ts";

const upstreamLatest = migrationEntries[migrationEntries.length - 1]![0];

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("Ctrl 002_ThreadGroupLinks", (it) => {
  it.effect("gives existing groups an empty links column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: upstreamLatest });
      yield* runCtrlMigrations({ toMigrationInclusive: 1 });
      yield* sql`
        INSERT INTO projection_thread_groups
          (group_id, project_id, title, manual_resources_json, created_at, updated_at)
        VALUES ('group-1', 'project-1', 'Auth', '[]', '2026-10-11', '2026-10-11')
      `;
      yield* runCtrlMigrations({ toMigrationInclusive: 2 });
      const rows = yield* sql<{ readonly links: string }>`
        SELECT links_json AS links FROM projection_thread_groups
      `;
      assert.deepEqual(
        rows.map((row) => row.links),
        ["[]"],
      );
    }),
  );
});
