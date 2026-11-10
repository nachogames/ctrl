import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A point's text in the user's review writing style, and which style that was. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE review_items ADD COLUMN writeup TEXT`;
  yield* sql`ALTER TABLE review_items ADD COLUMN writeup_style TEXT`;
});
