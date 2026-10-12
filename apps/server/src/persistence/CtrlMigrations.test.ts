import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import CtrlMigration0001 from "./CtrlMigrations/001_ThreadGroups.ts";
import CtrlMigration0002 from "./CtrlMigrations/002_ThreadGroupLinks.ts";
import { CTRL_MIGRATIONS_TABLE, ctrlMigrationEntries } from "./CtrlMigrations.ts";
import { migrationEntries, runMigrations } from "./Migrations.ts";

const ledger = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id
    `;
    return rows.map((row) => [row.migration_id, row.name] as const);
  });

const upstreamManifest = migrationEntries.map(([id, name]) => [id, name] as const);
const ctrlManifest = ctrlMigrationEntries.map(([id, name]) => [id, name] as const);

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "Ctrl ledger on a new database",
  (it) => {
    it.effect("records upstream and Ctrl migrations in their own ledgers", () =>
      Effect.gen(function* () {
        yield* runMigrations();
        assert.deepEqual(yield* ledger("effect_sql_migrations"), upstreamManifest);
        assert.deepEqual(yield* ledger(CTRL_MIGRATIONS_TABLE), ctrlManifest);
      }),
    );
  },
);

it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })))(
  "Ctrl ledger on a database from before the split",
  (it) => {
    it.effect("moves Ctrl's 61 and 62 out so upstream's 61 runs", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // A pre-split Ctrl build: upstream through 60, then Ctrl's two at 61 and 62.
        yield* runMigrations({ toMigrationInclusive: 60 });
        yield* CtrlMigration0001;
        yield* CtrlMigration0002;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name, created_at)
          VALUES (61, 'ThreadGroups', '2026-10-11 10:00:00'),
                 (62, 'ThreadGroupLinks', '2026-10-11 11:00:00')
        `;
        yield* sql`
          INSERT INTO projection_thread_groups
            (group_id, project_id, title, manual_resources_json, created_at, updated_at)
          VALUES ('group-1', 'project-1', 'Auth', '[]', '2026-10-11', '2026-10-11')
        `;

        yield* runMigrations();

        assert.deepEqual(yield* ledger("effect_sql_migrations"), upstreamManifest);
        assert.deepEqual(yield* ledger(CTRL_MIGRATIONS_TABLE), ctrlManifest);
        const moved = yield* sql<{ readonly created_at: string }>`
          SELECT created_at FROM ${sql(CTRL_MIGRATIONS_TABLE)} ORDER BY migration_id
        `;
        assert.deepEqual(
          moved.map((row) => row.created_at),
          ["2026-10-11 10:00:00", "2026-10-11 11:00:00"],
        );
        const guides = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pull_request_review_guides'
        `;
        assert.lengthOf(guides, 1);
        const groups = yield* sql<{ readonly title: string }>`
          SELECT title FROM projection_thread_groups
        `;
        assert.deepEqual(
          groups.map((row) => row.title),
          ["Auth"],
        );

        // Later starts change nothing.
        yield* runMigrations();
        assert.deepEqual(yield* ledger("effect_sql_migrations"), upstreamManifest);
        assert.deepEqual(yield* ledger(CTRL_MIGRATIONS_TABLE), ctrlManifest);
      }),
    );
  },
);
