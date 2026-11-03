/**
 * FleetService - the Home operations that need more than an agent's reach:
 * organizing any thread and answering any request, approvals included. It runs
 * only here; on a linked machine Home acts as any linked agent. No deletes.
 */
import {
  CommandId,
  type FleetActor,
  type FleetInput,
  type FleetInvokeInput,
  type FleetOperation,
  type FleetResult,
  ProviderRequestKind,
  type ProjectId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { threadManagementFailure } from "../mcp/OrchestratorMcpService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";

export class FleetService extends Context.Service<
  FleetService,
  {
    /** Runs one operation and returns its result, typed by `FleetResults[op]`. */
    readonly execute: (input: FleetInvokeInput) => Effect.Effect<unknown, OrchestratorMcpFailure>;
  }
>()("t3/home/FleetService") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const orchestrationError = (error: unknown) =>
  failure(
    "orchestration_error",
    error instanceof Error ? error.message : "The operation could not be completed.",
  );

/**
 * Fails when a launch would run in Home's folder, as its project or an
 * existing worktree. That folder's instructions make any agent there act as
 * Home. Every Home launch path calls this.
 */
export const refuseHomeFolder = Effect.fn("FleetService.refuseHomeFolder")(function* (
  services: {
    readonly projects: ProjectService.ProjectService["Service"];
    readonly folders: ManagedProjectFolders.ManagedProjectFolders["Service"];
  },
  input: {
    readonly projectId: ProjectId;
    readonly workspaceStrategy?: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined;
  },
) {
  const project = yield* services.projects
    .getById(input.projectId)
    .pipe(Effect.mapError(orchestrationError));
  const roots = [
    ...(Option.isSome(project) ? [project.value.workspaceRoot] : []),
    ...(input.workspaceStrategy?.type === "existing_worktree"
      ? [input.workspaceStrategy.worktreePath]
      : []),
  ];
  for (const root of roots) {
    if (yield* services.folders.isInHomeFolder(root)) {
      return yield* failure("invalid_request", "Threads never launch in Shift's folder.");
    }
  }
});

type Handlers = {
  readonly [Op in FleetOperation]: (
    input: FleetInput<Op>,
    actor: FleetActor,
  ) => Effect.Effect<FleetResult<Op>, OrchestratorMcpFailure>;
};

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const crypto = yield* SecureRandom.SecureRandom;

  // A retried request with the same clientRequestId maps to the same command
  // for the same target thread; another target gets its own command.
  const commandId = (
    actor: FleetActor,
    operation: string,
    target?: { readonly threadId: ThreadId; readonly clientRequestId?: string | undefined },
  ) =>
    (target?.clientRequestId === undefined
      ? crypto.uuidV4().pipe(Effect.orDie)
      : Effect.succeed(
          `${actor.environmentId}:${actor.threadId}:${target.threadId}:${target.clientRequestId}`,
        )
    ).pipe(Effect.map((key) => CommandId.make(`fleet:${operation}:${key}`)));

  const loadShell = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.mapError(threadManagementFailure),
      Effect.filterOrFail(
        (shell) => shell !== null && shell.deletedAt === null,
        () => failure("thread_not_found", `Thread ${threadId} was not found.`),
      ),
    );

  const requireThreadId = (threadId: ThreadId | undefined) =>
    threadId === undefined
      ? Effect.fail(failure("invalid_request", "threadId is required."))
      : Effect.succeed(threadId);

  const dispatch = (command: OrchestrationV2Command) =>
    threads.dispatch(command).pipe(
      Effect.map((result) => ({ sequence: result.sequence })),
      Effect.mapError(threadManagementFailure),
    );

  const loadRequests = (threadId: ThreadId) =>
    threads
      .getThreadRecords(threadId, ["runtimeRequests", "turnItems"], {
        turnItemTypes: ["user_input_request", "approval_request"],
      })
      .pipe(Effect.mapError(threadManagementFailure));

  const handlers: Handlers = {
    "threads.organize": Effect.fn("FleetService.organizeThread")(function* (input, actor) {
      const threadId = yield* requireThreadId(input.threadId);
      yield* loadShell(threadId);
      const common = { commandId: yield* commandId(actor, "organize"), threadId };
      switch (input.action) {
        case "snooze":
          if (input.snoozedUntil === undefined) {
            return yield* failure("invalid_request", "snooze requires snoozedUntil.");
          }
          return yield* dispatch({
            ...common,
            type: "thread.snooze",
            snoozedUntil: input.snoozedUntil,
          });
        case "unsnooze":
        case "unsettle":
          return yield* dispatch({ ...common, type: `thread.${input.action}`, reason: "user" });
        case "mark_unread":
          return yield* dispatch({ ...common, type: "thread.mark-unread" });
        default:
          return yield* dispatch({ ...common, type: `thread.${input.action}` });
      }
    }),

    "requests.list": Effect.fn("FleetService.listRequests")(function* (input) {
      const threadId = yield* requireThreadId(input.threadId);
      const { runtimeRequests } = yield* loadRequests(threadId);
      const pending = runtimeRequests.filter((request) => request.status === "pending");
      return {
        requestIds: pending
          .filter((request) => request.kind === "user_input")
          .map((request) => request.id),
        approvalRequestIds: pending
          .filter((request) => isApprovalKind(request.kind))
          .map((request) => request.id),
      };
    }),

    "requests.read": Effect.fn("FleetService.readRequest")(function* (input) {
      const threadId = yield* requireThreadId(input.threadId);
      const { runtimeRequests, turnItems } = yield* loadRequests(threadId);
      const request = runtimeRequests.find(
        (candidate) => candidate.id === input.requestId && candidate.status === "pending",
      );
      const item = turnItems.find(
        (candidate) =>
          (candidate.type === "user_input_request" || candidate.type === "approval_request") &&
          candidate.requestId === input.requestId,
      );
      if (request === undefined || item === undefined) {
        return yield* failure("invalid_request", "The pending request was not found.");
      }
      if (item.type === "user_input_request") {
        return {
          requestId: input.requestId,
          kind: "question" as const,
          questions: item.questions,
        };
      }
      if (item.type !== "approval_request") {
        return yield* failure("invalid_request", "The pending request was not found.");
      }
      return {
        requestId: input.requestId,
        kind: "approval" as const,
        questions: [],
        approval: {
          requestKind: item.requestKind,
          prompt: item.prompt ?? null,
          appName: item.appName ?? null,
          options: item.options ?? [],
        },
      };
    }),

    "requests.respond": Effect.fn("FleetService.respondToRequest")(function* (input, actor) {
      const threadId = yield* requireThreadId(input.threadId);
      const { runtimeRequests } = yield* loadRequests(threadId);
      const request = runtimeRequests.find(
        (candidate) => candidate.id === input.requestId && candidate.status === "pending",
      );
      if (request === undefined) {
        return yield* failure("invalid_request", "The pending request was not found.");
      }
      const isQuestion = request.kind === "user_input";
      // Tool calls and auth refreshes are answered by the runtime, never by a decision.
      if (!isQuestion && !isApprovalKind(request.kind)) {
        return yield* failure(
          "invalid_request",
          "This request does not take an answer or decision.",
        );
      }
      if (isQuestion ? input.answers === undefined : input.decision === undefined) {
        return yield* failure(
          "invalid_request",
          isQuestion ? "A question needs answers." : "An approval needs a decision.",
        );
      }
      return yield* dispatch({
        type: "runtime-request.respond",
        commandId: yield* commandId(actor, "respond"),
        threadId,
        requestId: input.requestId,
        ...(isQuestion ? { answers: input.answers } : { decision: input.decision }),
      });
    }),
  };

  // Each handler takes its own operation's input; the request union keeps them paired.
  const run = (request: FleetInvokeInput["request"], actor: FleetActor) =>
    (
      handlers[request.op] as (
        input: never,
        actor: FleetActor,
      ) => Effect.Effect<unknown, OrchestratorMcpFailure>
    )(request.input as never, actor);

  return FleetService.of({
    execute: Effect.fn("FleetService.execute")(function* ({ actor, request }) {
      yield* Effect.annotateCurrentSpan({ "fleet.op": request.op });
      return yield* run(request, actor);
    }),
  });
});

/** Approvals are the provider permission kinds; questions and tool calls are not. */
/** Approval requests take a decision; other provider requests do not. */
const isApprovalKind = Schema.is(ProviderRequestKind);

export const layer = Layer.effect(FleetService, make);
