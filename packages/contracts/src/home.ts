/**
 * Home: one agent thread per desktop install, run by the desktop's local server
 * (the hub), that acts with the user's reach across every project here and every
 * linked environment. See docs/internals/home.md.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, RuntimeRequestId, ThreadId, IsoDateTime } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2DispatchCommandResult } from "./orchestrationV2.ts";
import {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderRequestKind,
  ProviderUserInputAnswers,
} from "./providerPolicy.ts";

/** Why Home watches a thread. Threads Home launched also stop notifying the user. */
export const HomeWatchReason = Schema.Literals(["launched", "requested"]);
export type HomeWatchReason = typeof HomeWatchReason.Type;

export const HomeWatch = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  reason: HomeWatchReason,
});
export type HomeWatch = typeof HomeWatch.Type;

/**
 * Home's state on the hub. It lives in server settings so every client sees
 * it with the settings it already streams, but clients cannot patch it: only
 * the Home RPCs and Home's own tools change it.
 */
export const HomeSettings = Schema.Struct({
  /** The current Home thread. Null when Home is off. */
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Wake Home for every thread in the fleet, not only watched ones. */
  watchAll: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  watches: Schema.Array(HomeWatch).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type HomeSettings = typeof HomeSettings.Type;

export const DEFAULT_HOME_SETTINGS: HomeSettings = { threadId: null, watchAll: false, watches: [] };

/**
 * Every Home thread's id starts with this, the current one and any a fresh
 * start left behind, so any client can label a message Home sent without
 * knowing which environment it came from.
 */
export const HOME_THREAD_ID_PREFIX = "home:";

export const isHomeThreadId = (threadId: string): boolean =>
  threadId.startsWith(HOME_THREAD_ID_PREFIX);

/**
 * Every thread Home launches has an id that starts with this, chosen before the
 * thread exists. Clients use it to leave those threads to Home instead of
 * notifying the user, with no race against Home's watch settings.
 */
export const HOME_LAUNCHED_THREAD_ID_PREFIX = "home-launched:";

export const isHomeLaunchedThreadId = (threadId: string): boolean =>
  threadId.startsWith(HOME_LAUNCHED_THREAD_ID_PREFIX);

/** Watch reports T3 Code sends into Home's thread have message ids that start with this. */
export const HOME_REPORT_MESSAGE_ID_PREFIX = "home-report:";

export const isHomeReportMessageId = (messageId: string): boolean =>
  messageId.startsWith(HOME_REPORT_MESSAGE_ID_PREFIX);

export const HomeEnableInput = Schema.Struct({ modelSelection: ModelSelection });
export type HomeEnableInput = typeof HomeEnableInput.Type;

export const HomeThreadResult = Schema.Struct({ threadId: ThreadId });
export type HomeThreadResult = typeof HomeThreadResult.Type;

export class HomeUnavailableError extends Schema.TaggedError<HomeUnavailableError>()(
  "HomeUnavailableError",
  { message: Schema.String },
) {}

/** The Home thread that asked, recorded as the sender of messages it causes. */
export const FleetActor = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type FleetActor = typeof FleetActor.Type;

export const FleetThreadOrganizeAction = Schema.Literals([
  "pin",
  "unpin",
  "snooze",
  "unsnooze",
  "settle",
  "unsettle",
  "archive",
  "unarchive",
  "mark_unread",
]);
export type FleetThreadOrganizeAction = typeof FleetThreadOrganizeAction.Type;

export const FleetThreadOrganizeInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  action: FleetThreadOrganizeAction,
  snoozedUntil: Schema.optional(IsoDateTime),
});
export type FleetThreadOrganizeInput = typeof FleetThreadOrganizeInput.Type;

export const FleetRequestsListInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
});
export type FleetRequestsListInput = typeof FleetRequestsListInput.Type;

export const FleetPendingRequestKind = Schema.Literals(["question", "approval"]);
export type FleetPendingRequestKind = typeof FleetPendingRequestKind.Type;

export const FleetRequestsListResult = Schema.Struct({
  /** Pending user questions. */
  requestIds: Schema.Array(RuntimeRequestId),
  /** Pending approvals. Only Home sees these. */
  approvalRequestIds: Schema.optional(Schema.Array(RuntimeRequestId)),
});
export type FleetRequestsListResult = typeof FleetRequestsListResult.Type;

export const FleetRequestTarget = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  requestId: RuntimeRequestId,
});
export type FleetRequestTarget = typeof FleetRequestTarget.Type;

const FleetQuestion = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.String,
      value: Schema.optional(Schema.String),
    }),
  ),
  multiSelect: Schema.optional(Schema.Boolean),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  required: Schema.optional(Schema.Boolean),
});

export const FleetRequestReadResult = Schema.Struct({
  requestId: RuntimeRequestId,
  kind: Schema.optional(FleetPendingRequestKind),
  /** The questions of a user-input request; empty for an approval. */
  questions: Schema.Array(FleetQuestion),
  /** What an approval asks to do. */
  approval: Schema.optional(
    Schema.Struct({
      requestKind: ProviderRequestKind,
      prompt: Schema.NullOr(Schema.String),
      appName: Schema.NullOr(Schema.String),
      options: Schema.Array(ProviderApprovalOption),
    }),
  ),
});
export type FleetRequestReadResult = typeof FleetRequestReadResult.Type;

export const FleetRequestRespondInput = Schema.Struct({
  ...FleetRequestTarget.fields,
  answers: Schema.optional(ProviderUserInputAnswers),
  decision: Schema.optional(
    ProviderApprovalDecision.annotate({
      description: "Shift only: the decision for a pending approval.",
    }),
  ),
});
export type FleetRequestRespondInput = typeof FleetRequestRespondInput.Type;

const operation = <const Op extends string, S extends Schema.Top>(op: Op, input: S) =>
  Schema.Struct({ op: Schema.Literal(op), input });

/** One operation Home runs in its own environment with the user's reach, beyond an agent's. */
export const FleetRequest = Schema.Union([
  operation("threads.organize", FleetThreadOrganizeInput),
  operation("requests.list", FleetRequestsListInput),
  operation("requests.read", FleetRequestTarget),
  operation("requests.respond", FleetRequestRespondInput),
]);
export type FleetRequest = typeof FleetRequest.Type;
export type FleetOperation = FleetRequest["op"];

/** The result schema of each operation. */
const FleetResults = {
  "threads.organize": OrchestrationV2DispatchCommandResult,
  "requests.list": FleetRequestsListResult,
  "requests.read": FleetRequestReadResult,
  "requests.respond": OrchestrationV2DispatchCommandResult,
} satisfies Record<FleetOperation, Schema.Top>;
export type FleetResult<Op extends FleetOperation> = (typeof FleetResults)[Op]["Type"];
export type FleetInput<Op extends FleetOperation> = Extract<FleetRequest, { op: Op }>["input"];

/** One Home operation and the Home thread that asked. */
export const FleetInvokeInput = Schema.Struct({ actor: FleetActor, request: FleetRequest });
export type FleetInvokeInput = typeof FleetInvokeInput.Type;

export const HomeWatchEventKind = Schema.Literals([
  "completed",
  "failed",
  "question",
  "approval",
  // The thread was settled or archived; its watch ends without waking Home.
  "ended",
]);
export type HomeWatchEventKind = typeof HomeWatchEventKind.Type;

export const HomeWatchEvent = Schema.Struct({
  environmentId: EnvironmentId,
  environmentLabel: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  threadId: ThreadId,
  title: Schema.String.check(Schema.isMaxLength(300)),
  kind: HomeWatchEventKind,
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type HomeWatchEvent = typeof HomeWatchEvent.Type;

export const HomeWatchReport = Schema.Struct({ events: Schema.Array(HomeWatchEvent) });
export type HomeWatchReport = typeof HomeWatchReport.Type;
