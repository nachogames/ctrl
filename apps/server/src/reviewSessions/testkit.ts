import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  ProjectId,
  ProviderInstanceId,
  ReviewSessionId,
  ThreadGroupId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type PullRequestActor,
  type ReviewItem,
  type ReviewRound,
  type ReviewSession,
  type ReviewSource,
  type ReviewSourceComment,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import type { ProviderChangeRequestReviewRound } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";

import * as ThreadGroupLaunchService from "../orchestration-v2/ThreadGroupLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ReviewSessions from "../persistence/ReviewSessions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ReviewSessionChanges from "./ReviewSessionChanges.ts";
import * as ReviewSessionService from "./ReviewSessionService.ts";
import * as ReviewSyncService from "./ReviewSyncService.ts";

export const at = "2026-10-13T10:00:00.000Z";
export const projectId = ProjectId.make("project");
export const prKey = { host: "github.com", repository: "nachogames/ctrl", number: 23 };
export const prUrl = "https://github.com/nachogames/ctrl/pull/23";
export const groupId = ThreadGroupId.make("group:review");
export const reviewThreadId = ThreadId.make("thread:review");

export const sessionFixture = (fields: Partial<ReviewSession> = {}): ReviewSession => ({
  id: ReviewSessionId.make("review:1"),
  projectId,
  pullRequest: prKey,
  url: prUrl,
  groupId,
  reviewThreadId,
  phase: "self-review",
  round: 1,
  headSha: "abc123",
  nextNumber: 1,
  createdAt: at,
  updatedAt: at,
  ...fields,
});

export const roundFixture = (round: number, fields: Partial<ReviewRound> = {}): ReviewRound => ({
  round,
  headSha: "abc123",
  state: "collecting",
  appliedSha: null,
  createdAt: at,
  updatedAt: at,
  ...fields,
});

export const itemFixture = (number: number, fields: Partial<ReviewItem> = {}): ReviewItem => ({
  number,
  round: 1,
  lastSeenRound: 1,
  sourceKeys: [`gh:T${number}`],
  sources: ["copilot"],
  sourceIds: [],
  githubThreadIds: [],
  githubState: null,
  path: "apps/server/src/auth.ts",
  line: 12,
  summary: `Point ${number}`,
  shortName: `point ${number}`,
  problem: "It breaks.",
  impact: "Users see it.",
  solution: "Fix it.",
  skipReason: "No reason to skip.",
  excerpt: null,
  recommendation: null,
  suggestedDecision: "fix",
  alreadyFixedIn: null,
  decision: "needs-call",
  decidedBy: null,
  reason: null,
  conclusion: null,
  draftReply: null,
  draftReplyRevision: 0,
  draftReplyBy: null,
  applyState: "pending",
  stale: false,
  viewed: false,
  sideThreadId: null,
  updatedAt: at,
  ...fields,
});

export const actor = (login: string, isBot = false): PullRequestActor => ({
  login,
  name: null,
  avatarUrl: null,
  ...(isBot ? { isBot: true } : {}),
});

type Read = ProviderChangeRequestReviewRound;

export const githubReview = (
  id: string,
  login: string,
  fields: Partial<Read["reviews"][number]> & { readonly isBot?: boolean } = {},
): Read["reviews"][number] => {
  const { isBot, ...rest } = fields;
  return {
    id,
    author: actor(login, isBot === true),
    state: "COMMENTED",
    body: "",
    submittedAt: at,
    url: null,
    commitSha: "abc123",
    ...rest,
  };
};

export const threadComment = (
  reviewId: string,
  body: string,
): Read["threads"][number]["comments"][number] => ({
  id: `${reviewId}:${body.length}`,
  reviewId,
  author: null,
  body,
  url: null,
  diffHunk: null,
});

export const githubThread = (
  id: string,
  comments: Read["threads"][number]["comments"],
  fields: Partial<Read["threads"][number]> = {},
): Read["threads"][number] => ({
  id,
  isResolved: false,
  isOutdated: false,
  path: "apps/server/src/auth.ts",
  line: 12,
  comments,
  ...fields,
});

export const reviewRoundRead = (fields: Partial<Read> = {}): Read => ({
  authorLogin: "nach",
  headSha: "abc123",
  reviews: [],
  pendingReviewers: [],
  threads: [],
  ...fields,
});

/** What GitHub answers; tests change `read` between syncs. */
export interface SyncHarness {
  read: Read | null;
}

/** The real sync on an in-memory database, reading GitHub from `harness`. */
export const makeSyncLayer = (harness: SyncHarness) =>
  ReviewSyncService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ReviewSessions.layer,
        ReviewSessionChanges.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          reviewRound: () => Effect.sync(() => harness.read),
          watchFingerprint: () => Effect.succeed(null),
        }),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

/** A row in the orchestration messages projection, shaped as the quote guard reads it. */
export const insertProjectionMessage = (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: ThreadId | string;
    readonly messageId: string;
    readonly role?: "user" | "assistant" | "system";
    readonly text: string;
    readonly createdAt: string;
    readonly payload?: Readonly<Record<string, unknown>>;
  },
) =>
  sql`
    INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
    VALUES (
      ${input.messageId}, ${input.threadId}, NULL, NULL, ${input.role ?? "user"}, 0,
      ${input.createdAt}, ${input.createdAt},
      ${JSON.stringify({ createdBy: "user", creationSource: "web", text: input.text, ...input.payload })}
    )
  `;

export const openInput: ReviewSessionService.ReviewSessionOpenInput = {
  key: prKey,
  url: prUrl,
  projectId,
  groupId,
  reviewThreadId,
  headSha: "abc123",
};

export const importItem = (
  key: string,
  fields: Partial<ReviewSessionService.ReviewImportItem> = {},
): ReviewSessionService.ReviewImportItem => ({
  sourceKeys: [key],
  sources: ["copilot"],
  githubThreadIds: [],
  path: "apps/server/src/auth.ts",
  line: 12,
  summary: `Point ${key}`,
  shortName: `point ${key}`,
  problem: "It breaks.",
  impact: "Users see it.",
  solution: "Fix it.",
  skipReason: "No reason to skip.",
  excerpt: null,
  recommendation: null,
  suggestedDecision: "fix",
  alreadyFixedIn: null,
  draftReply: null,
  ...fields,
});

export const localSourceFixture = (
  id: string,
  fields: Partial<ReviewSource> = {},
): ReviewSource => ({
  id,
  round: 1,
  kind: "local",
  state: "done",
  author: null,
  isBot: false,
  commitSha: "abc123",
  commentCount: 1,
  triaged: false,
  threadId: ThreadId.make(`thread:${id}`),
  ranOn: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  url: null,
  updatedAt: at,
  ...fields,
});

export const sourceComment = (key: string, body: string): ReviewSourceComment => ({
  key,
  threadId: null,
  path: "apps/server/src/auth.ts",
  line: 12,
  body,
  url: null,
  diffHunk: null,
});

export const prLink = (
  number: number,
  headBranch: string,
  baseBranch: string,
): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "nachogames/ctrl",
  number,
  url: `https://github.com/nachogames/ctrl/pull/${number}`,
  source: "manual",
  linkedAt: at,
  snapshot: {
    state: "open",
    title: `PR ${number}`,
    headBranch,
    baseBranch,
    isDraft: false,
    updatedAt: null,
    syncedAt: at,
  },
  stack: null,
});

const providerInstanceId = ProviderInstanceId.make("claudeAgent");

/** A live chat in the review group, running as the MCP caller tests expect. */
export const chatShell = (
  id: ThreadId,
  fields: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell =>
  ({
    id,
    projectId,
    title: "Review PR 23",
    status: "idle",
    groupId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    activeRunId: "run:active",
    archivedAt: null,
    deletedAt: null,
    lineage: { relationshipToParent: null },
    createdAt: DateTime.makeUnsafe(1),
    ...fields,
  }) as OrchestrationV2ThreadShell;

export interface ReviewServiceHarness extends SyncHarness {
  readonly launched: Array<ThreadGroupLaunchService.ThreadGroupNewThreadInput>;
  readonly sent: Array<ThreadManagementService.ThreadManagementSendInput>;
  readonly shells: Map<ThreadId, OrchestrationV2ThreadShell>;
  readonly projectThreads: Array<OrchestrationV2ThreadShell>;
  /** Provider instance id to driver kind, for the local review's prompt. */
  readonly drivers: Map<string, string>;
}

export const newHarness = (): ReviewServiceHarness => ({
  read: null,
  launched: [],
  sent: [],
  shells: new Map([[reviewThreadId, chatShell(reviewThreadId)]]),
  projectThreads: [],
  drivers: new Map([["claudeAgent", "claudeAgent"]]),
});

/** The real service and sync on an in-memory database; threads, sends and launches go to `harness`. */
export const makeReviewServiceLayer = (harness: ReviewServiceHarness) =>
  ReviewSessionService.layer.pipe(
    Layer.provideMerge(ReviewSyncService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        ReviewSessions.layer,
        ReviewSessionChanges.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          reviewRound: () => Effect.sync(() => harness.read),
          watchFingerprint: () => Effect.succeed(null),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(harness.shells.get(threadId) ?? null),
          listProjectThreads: () => Effect.sync(() => harness.projectThreads),
          sendToThread: (input) =>
            Effect.sync(() => {
              harness.sent.push(input);
              return {} as never;
            }),
        }),
        Layer.mock(ThreadGroupLaunchService.ThreadGroupLaunchService)({
          newThread: (input) => {
            harness.launched.push(input);
            const threadId = ThreadId.make(`thread:launched-${harness.launched.length}`);
            harness.shells.set(threadId, chatShell(threadId));
            return Effect.succeed({ group: {} as never, threadId });
          },
        }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: (instanceId) =>
            Effect.sync(() => {
              const driverKind = harness.drivers.get(instanceId);
              return driverKind === undefined
                ? undefined
                : ({ instanceId, driverKind, displayName: undefined } as never);
            }),
        }),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
