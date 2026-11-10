import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The review action a chat is working on, so every client shows it until its run ends. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE review_sessions ADD COLUMN pending_request_json TEXT`;
});
