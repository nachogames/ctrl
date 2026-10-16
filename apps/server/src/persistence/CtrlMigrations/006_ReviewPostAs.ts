import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** How a point someone else already raised goes out: a +1 reply or your own comment. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE review_items ADD COLUMN post_as TEXT`;
});
