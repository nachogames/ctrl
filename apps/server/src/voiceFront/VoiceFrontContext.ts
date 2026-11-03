import { isHomeThreadId, type PeerLinkSummary, type ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import {
  type FrontContext,
  RECENT_MESSAGE_LIMIT,
  remoteThreadLine,
  SNAPSHOT_THREAD_LIMIT,
  type ThreadLine,
  threadLine,
} from "./frontPrompt.ts";

/**
 * How long Shift's front waits on another machine's thread list. The voice
 * answers without a machine that is slower than this.
 */
export const REMOTE_THREADS_TIMEOUT = Duration.millis(1500);

interface DatedLine {
  readonly updatedAtMs: number;
  readonly line: ThreadLine;
}

interface RemoteThreads {
  readonly machines: ReadonlyArray<string>;
  readonly unreachable: ReadonlyArray<string>;
  readonly lines: ReadonlyArray<DatedLine>;
}

const noRemoteThreads: RemoteThreads = { machines: [], unreachable: [], lines: [] };

/** What the front voice is told about a thread before it answers. */
export class VoiceFrontContext extends Context.Service<
  VoiceFrontContext,
  { readonly load: (threadId: ThreadId) => Effect.Effect<FrontContext> }
>()("t3/voiceFront/VoiceFrontContext") {}

const empty: FrontContext = { kind: "thread", title: "this thread", threads: [], messages: [] };

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const peerLinks = yield* PeerLinks.PeerLinks;
  const environment = yield* ServerEnvironment.ServerEnvironment;

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

  /** This machine's open threads, newest first. */
  const localThreads = Effect.fnUntraced(function* () {
    const snapshot = yield* threads.getShellSnapshot();
    return snapshot.threads
      .filter(
        (shell) =>
          shell.deletedAt === null &&
          shell.archivedAt === null &&
          shell.settledOverride !== "settled" &&
          !isHomeThreadId(shell.id) &&
          shell.lineage.relationshipToParent !== "subagent",
      )
      .map((shell) => ({ shell, updatedAtMs: DateTime.toEpochMillis(shell.updatedAt) }));
  });

  /** One linked machine's open threads, or None when it did not answer in time. */
  const machineThreads = (
    scope: McpInvocationContext.McpThreadInvocationScope,
    link: PeerLinkSummary,
  ) =>
    forwarding
      .call(scope, OrchestratorToolkit.tools.t3_thread_list, link.environmentId, {
        allProjects: true,
        settled: false,
        includeSubagents: false,
        limit: SNAPSHOT_THREAD_LIMIT,
      })
      .pipe(
        Effect.map((result) => result.threads),
        Effect.timeoutOption(REMOTE_THREADS_TIMEOUT),
        Effect.catchCause(() => Effect.succeedNone),
      );

  /**
   * Open threads on the user's linked machines, asked as Shift's thread, the
   * way Shift's own tools reach them. Every machine is asked at once; one that
   * is offline, expired, or slow is left out and named, never waited on past
   * the timeout.
   */
  const otherMachines = Effect.fnUntraced(function* (homeThreadId: ThreadId, nowMs: number) {
    if (!(yield* peerLinks.enabled)) return noRemoteThreads;
    const targets = yield* peerLinks.list;
    if (targets.length === 0) return noRemoteThreads;
    const home = yield* threads.getThreadShell(homeThreadId);
    if (home === null) return noRemoteThreads;
    const scope: McpInvocationContext.McpThreadInvocationScope = {
      environmentId: (yield* environment.getDescriptor).environmentId,
      requestNamespace: `voice-front:${homeThreadId}`,
      thread: {
        threadId: homeThreadId,
        providerSessionId: `voice-front:${homeThreadId}`,
        providerInstanceId: home.modelSelection.instanceId,
      },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 0,
    };
    const answers = yield* Effect.forEach(
      targets,
      (target) =>
        (target.status === "expired" ? Effect.succeedNone : machineThreads(scope, target)).pipe(
          Effect.map((items) => ({ target, items })),
        ),
      { concurrency: "unbounded" },
    );
    const lines: DatedLine[] = [];
    for (const { target, items } of answers) {
      if (Option.isNone(items)) continue;
      for (const item of items.value) {
        // The list already leaves out archived, settled, and subagent threads.
        if (isHomeThreadId(item.threadId)) continue;
        const updatedAtMs = DateTime.toEpochMillis(DateTime.makeUnsafe(item.updatedAt));
        lines.push({ updatedAtMs, line: remoteThreadLine(item, target.label, updatedAtMs, nowMs) });
      }
    }
    return {
      machines: answers
        .filter(({ items }) => Option.isSome(items))
        .map(({ target }) => target.label),
      unreachable: answers
        .filter(({ items }) => Option.isNone(items))
        .map(({ target }) => target.label),
      lines,
    };
  });

  const load = Effect.fn("VoiceFrontContext.load")(
    function* (threadId: ThreadId) {
      const nowMs = yield* Clock.currentTimeMillis;
      if (isHomeThreadId(threadId)) {
        const { messages, local, remote } = yield* Effect.all(
          {
            messages: recentMessages(threadId),
            local: localThreads(),
            remote: otherMachines(threadId, nowMs).pipe(
              Effect.catchCause(() => Effect.succeed(noRemoteThreads)),
            ),
          },
          { concurrency: "unbounded" },
        );
        const lines = [
          ...local.map(({ shell, updatedAtMs }) => ({
            updatedAtMs,
            line: threadLine(shell, updatedAtMs, nowMs),
          })),
          ...remote.lines,
        ]
          .toSorted((left, right) => right.updatedAtMs - left.updatedAtMs)
          .slice(0, SNAPSHOT_THREAD_LIMIT);
        return {
          kind: "shift" as const,
          title: "Shift",
          threads: lines.map(({ line }) => line),
          machines: remote.machines,
          unreachable: remote.unreachable,
          messages,
        };
      }
      const messages = yield* recentMessages(threadId);
      const shell = yield* threads.getThreadShell(threadId);
      return {
        kind: "thread" as const,
        title: shell?.title || "this thread",
        threads: shell ? [threadLine(shell, DateTime.toEpochMillis(shell.updatedAt), nowMs)] : [],
        messages,
      };
    },
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
