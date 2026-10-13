import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

import { runCtrlMigrations } from "../CtrlMigrations.ts";
import { migrationEntries, runMigrations } from "../Migrations.ts";

const upstreamLatest = migrationEntries[migrationEntries.length - 1]![0];

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("Ctrl 003_ReviewSessions", (it) => {
  it.effect("allows one live review per pull request per group", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: upstreamLatest });
      yield* runCtrlMigrations({ toMigrationInclusive: 3 });
      const insert = (id: string, group: string, phase: string) => sql`
        INSERT INTO review_sessions
          (session_id, project_id, host, repository, number, url, group_id, review_thread_id,
           phase, round, head_sha, next_number, created_at, updated_at)
        VALUES (${id}, 'project', 'github.com', 'nachogames/ctrl', 23,
                'https://github.com/nachogames/ctrl/pull/23', ${group}, 'thread:review', ${phase},
                1, NULL, 1, '2026-10-13', '2026-10-13')
      `;
      // A finished review stays as history beside the live one.
      yield* insert("review:1", "group:a", "done");
      yield* insert("review:2", "group:a", "self-review");
      yield* insert("review:3", "group:b", "self-review");
      const duplicate = yield* Effect.result(insert("review:4", "group:a", "self-review"));
      assert.isTrue(Result.isFailure(duplicate));
    }),
  );

  it.effect("lets one point own a source key", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: upstreamLatest });
      yield* runCtrlMigrations({ toMigrationInclusive: 3 });
      yield* sql`
        INSERT INTO review_sessions
          (session_id, project_id, host, repository, number, url, group_id, review_thread_id,
           phase, round, head_sha, next_number, created_at, updated_at)
        VALUES ('review:keys', 'project', 'github.com', 'nachogames/ctrl', 24,
                'https://github.com/nachogames/ctrl/pull/24', 'group:a', 'thread:review',
                'self-review', 1, NULL, 3, '2026-10-13', '2026-10-13')
      `;
      for (const number of [1, 2]) {
        yield* sql`
          INSERT INTO review_items
            (session_id, number, round, last_seen_round, sources_json, github_thread_ids_json,
             summary, short_name, problem, impact, solution, skip_reason, decision, apply_state,
             updated_at)
          VALUES ('review:keys', ${number}, 1, 1, '[]', '[]', 's', 's', 'p', 'i', 'f', 'n',
                  'needs-call', 'pending', '2026-10-13')
        `;
      }
      yield* sql`
        INSERT INTO review_item_keys (session_id, source_key, number)
        VALUES ('review:keys', 'gh:T1', 1)
      `;
      const taken = yield* Effect.result(sql`
        INSERT INTO review_item_keys (session_id, source_key, number)
        VALUES ('review:keys', 'gh:T1', 2)
      `);
      assert.isTrue(Result.isFailure(taken));
    }),
  );
});
