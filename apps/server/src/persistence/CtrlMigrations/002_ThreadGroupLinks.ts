import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Ticket links on a chat group, folded by ThreadGroupStore; older rows hold none.
  yield* sql`
    ALTER TABLE projection_thread_groups ADD COLUMN links_json TEXT NOT NULL DEFAULT '[]'
  `;
});
