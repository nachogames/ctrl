/**
 * Ctrl's migrations: numbered from 1 in `ctrl_sql_migrations`, after upstream's. Never add them to
 * Migrations.ts: a fork id in upstream's ledger hides upstream migrations that arrive later.
 * They run against the latest upstream schema on a new database, so keep them additive.
 */
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import CtrlMigration0001 from "./CtrlMigrations/001_ThreadGroups.ts";
import CtrlMigration0002 from "./CtrlMigrations/002_ThreadGroupLinks.ts";
import CtrlMigration0003 from "./CtrlMigrations/003_ReviewSessions.ts";

import CtrlMigration0004 from "./CtrlMigrations/004_ReviewSourceHistory.ts";
import CtrlMigration0005 from "./CtrlMigrations/005_ReviewViewer.ts";
import CtrlMigration0006 from "./CtrlMigrations/006_ReviewPostAs.ts";
import CtrlMigration0007 from "./CtrlMigrations/007_ReviewWriteup.ts";
import CtrlMigration0008 from "./CtrlMigrations/008_ReviewPendingRequest.ts";
import CtrlMigration0009 from "./CtrlMigrations/009_AuthTailnetDeviceBlocks.ts";

export const CTRL_MIGRATIONS_TABLE = "ctrl_sql_migrations";

export const ctrlMigrationEntries = [
  [1, "ThreadGroups", CtrlMigration0001],
  [2, "ThreadGroupLinks", CtrlMigration0002],
  [3, "ReviewSessions", CtrlMigration0003],
  [4, "ReviewSourceHistory", CtrlMigration0004],
  [5, "ReviewViewer", CtrlMigration0005],
  [6, "ReviewPostAs", CtrlMigration0006],
  [7, "ReviewWriteup", CtrlMigration0007],
  [8, "ReviewPendingRequest", CtrlMigration0008],
  [9, "AuthTailnetDeviceBlocks", CtrlMigration0009],
] as const;

/**
 * Ctrl migrations that builds before the split recorded in upstream's ledger,
 * under the ids they had there.
 */
const LEGACY_UPSTREAM_LEDGER_IDS: ReadonlyArray<readonly [upstreamId: number, ctrlId: number]> = [
  [61, 1],
  [62, 2],
];

const run = Migrator.make({});

export interface RunCtrlMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/** Runs pending Ctrl migrations; call after upstream's. */
export const runCtrlMigrations = Effect.fn("runCtrlMigrations")(function* ({
  toMigrationInclusive,
}: RunCtrlMigrationsOptions = {}) {
  const executed = yield* run({
    table: CTRL_MIGRATIONS_TABLE,
    loader: Migrator.fromRecord(
      Object.fromEntries(
        ctrlMigrationEntries
          .filter(([id]) => toMigrationInclusive === undefined || id <= toMigrationInclusive)
          .map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
  if (executed.length > 0) {
    yield* Effect.log("Ctrl migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});

/**
 * Moves Ctrl migrations that older builds recorded in upstream's ledger into
 * Ctrl's, so upstream migrations that share those ids run. Call before
 * upstream's migrator. Rows match on id and name, so upstream's own migrations
 * at those ids are never touched.
 */
export const moveCtrlMigrationsOutOfUpstreamLedger = Effect.fn(
  "moveCtrlMigrationsOutOfUpstreamLedger",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const recorded = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
        readonly created_at: string;
      }>`SELECT migration_id, name, created_at FROM effect_sql_migrations`;
      const moves = LEGACY_UPSTREAM_LEDGER_IDS.flatMap(([upstreamId, ctrlId]) => {
        const name = ctrlMigrationEntries.find(([id]) => id === ctrlId)?.[1];
        const row = recorded.find((r) => r.migration_id === upstreamId && r.name === name);
        return row === undefined || name === undefined ? [] : [{ upstreamId, ctrlId, name, row }];
      });
      if (moves.length === 0) return [];
      yield* sql`
        CREATE TABLE IF NOT EXISTS ${sql(CTRL_MIGRATIONS_TABLE)} (
          migration_id integer PRIMARY KEY NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp,
          name VARCHAR(255) NOT NULL
        )
      `;
      for (const move of moves) {
        yield* sql`
          INSERT OR IGNORE INTO ${sql(CTRL_MIGRATIONS_TABLE)} (migration_id, name, created_at)
          VALUES (${move.ctrlId}, ${move.name}, ${move.row.created_at})
        `;
        yield* sql`
          DELETE FROM effect_sql_migrations
          WHERE migration_id = ${move.upstreamId} AND name = ${move.name}
        `;
      }
      const moved = moves.map((move) => `${move.upstreamId}_${move.name} → ${move.ctrlId}`);
      yield* Effect.log("Moved Ctrl migrations out of the upstream ledger").pipe(
        Effect.annotateLogs({ moved }),
      );
      return moved;
    }),
  );
});
