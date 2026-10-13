import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The text of the last message the user typed into `threadId`, or null.
 * None of these count, because each can carry text the user did not type:
 * - scheduled and webhook runs;
 * - pull request wake-ups;
 * - messages another chat or the server sent;
 * - the Review tab's own requests, sent as the system.
 *
 * Reads the orchestration projection directly to keep this Ctrl-only check out of the
 * upstream ProjectionStore.
 */
export const latestUserMessageText = Effect.fn("ReviewSessions.latestUserMessageText")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly text: string | null }>`
    SELECT json_extract(payload_json, '$.text') AS text
    FROM orchestration_v2_projection_messages
    WHERE thread_id = ${threadId}
      AND role = 'user'
      AND json_extract(payload_json, '$.createdBy') = 'user'
      AND json_extract(payload_json, '$.scheduledTaskId') IS NULL
      AND json_extract(payload_json, '$.senderThreadId') IS NULL
      AND json_extract(payload_json, '$.notification') IS NULL
    ORDER BY created_at DESC, message_id DESC
    LIMIT 1
  `;
  return rows[0]?.text ?? null;
});
