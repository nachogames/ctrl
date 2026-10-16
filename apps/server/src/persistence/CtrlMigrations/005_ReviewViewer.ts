import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Who wrote the pull request and who Ctrl reads GitHub as, so a review knows which are yours. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE review_sessions ADD COLUMN author_login TEXT`;
  yield* sql`ALTER TABLE review_sessions ADD COLUMN viewer_login TEXT`;
  yield* sql`ALTER TABLE review_sessions ADD COLUMN viewer_requested INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE review_sources ADD COLUMN verdict TEXT`;
  yield* sql`ALTER TABLE review_sources ADD COLUMN posted INTEGER NOT NULL DEFAULT 0`;
});
