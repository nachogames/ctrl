import { isHomeThreadId, type ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  type FrontContext,
  RECENT_MESSAGE_LIMIT,
  SNAPSHOT_THREAD_LIMIT,
  threadLine,
} from "./frontPrompt.ts";

/** What the front voice is told about a thread before it answers. */
export class VoiceFrontContext extends Context.Service<
  VoiceFrontContext,
  { readonly load: (threadId: ThreadId) => Effect.Effect<FrontContext> }
>()("t3/voiceFront/VoiceFrontContext") {}

const empty: FrontContext = { kind: "thread", title: "this thread", threads: [], messages: [] };

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;

  /** The last few user and agent messages, from the thread's latest runs only. */
  const recentMessages = Effect.fnUntraced(function* (threadId: ThreadId) {
    const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
    const runIds = runs.slice(-3).map((run) => run.id);
    if (runIds.length === 0) return [];
    const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageRunIds: runIds,
      messageRoles: ["user", "assistant"],
    });
    return messages
      .filter((message) => message.text.trim().length > 0)
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
      )
      .slice(-RECENT_MESSAGE_LIMIT)
      .map((message) => ({
        role: message.role === "user" ? ("user" as const) : ("assistant" as const),
        text: message.text,
      }));
  });

  const load = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const messages = yield* recentMessages(threadId);
      if (isHomeThreadId(threadId)) {
        const snapshot = yield* threads.getShellSnapshot();
        const shells = snapshot.threads
          .filter(
            (shell) =>
              shell.deletedAt === null &&
              shell.archivedAt === null &&
              shell.settledOverride !== "settled" &&
              !isHomeThreadId(shell.id) &&
              shell.lineage.relationshipToParent !== "subagent",
          )
          .toSorted(
            (left, right) =>
              DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
          )
          .slice(0, SNAPSHOT_THREAD_LIMIT);
        return {
          kind: "shift" as const,
          title: "Shift",
          threads: shells.map((shell) =>
            threadLine(shell, DateTime.toEpochMillis(shell.updatedAt), nowMs),
          ),
          messages,
        };
      }
      const shell = yield* threads.getThreadShell(threadId);
      return {
        kind: "thread" as const,
        title: shell?.title || "this thread",
        threads: shell ? [threadLine(shell, DateTime.toEpochMillis(shell.updatedAt), nowMs)] : [],
        messages,
      };
    }).pipe(
      // A thread the front cannot read still gets an answer, just without context.
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not load the front voice's thread context.").pipe(
          Effect.annotateLogs({ cause: String(cause) }),
          Effect.as(empty),
        ),
      ),
    );

  return VoiceFrontContext.of({ load });
});

export const layer = Layer.effect(VoiceFrontContext, make);
