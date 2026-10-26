import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProviderInstanceId,
  ReviewSessionError,
  ThreadGroupId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ReviewHostInput,
  type ReviewHostResult,
  type ReviewRequestInput,
  type ReviewSession,
  type ReviewSessionSnapshot,
  type ReviewThreadResult,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Groups from "../orchestration-v2/ThreadGroupService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as Settings from "../serverSettings.ts";
import * as Reviews from "./ReviewSessionService.ts";
import { itemGithubState, planReviewSync, rawReviewItems } from "./reviewSync.ts";

const isReviewSessionError = Schema.is(ReviewSessionError);

/** Whether this round already has your own review running or done. */
const hasLocalReview = (snapshot: ReviewSessionSnapshot) =>
  snapshot.sources.some(
    (source) =>
      source.kind === "local" &&
      source.round === snapshot.session.round &&
      source.threadId !== null &&
      (source.state === "reviewing" || source.state === "done"),
  );

export class ReviewHostService extends Context.Service<
  ReviewHostService,
  {
    readonly read: (input: ReviewHostInput) => Effect.Effect<ReviewHostResult, ReviewSessionError>;
    readonly start: (
      input: ReviewHostInput,
    ) => Effect.Effect<ReviewThreadResult, ReviewSessionError>;
    /**
     * A review action from the panel. It runs in the open chat, which takes the review over first;
     * a review whose chats are all gone gets its own Review chat first.
     */
    readonly request: (input: ReviewRequestInput) => Effect.Effect<void, ReviewSessionError>;
  }
>()("t3/reviewSessions/ReviewHostService") {}

export const make = Effect.gen(function* () {
  const pullRequests = yield* PullRequestService.PullRequestService;
  const threads = yield* Threads.ThreadManagementService;
  const groups = yield* Groups.ThreadGroupService;
  const projects = yield* Projects.ProjectService;
  const git = yield* GitWorkflow.GitWorkflowService;
  const settings = yield* Settings.ServerSettingsService;
  const reviews = yield* Reviews.ReviewSessionService;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const failure = (cause: unknown) =>
    isReviewSessionError(cause)
      ? cause
      : new ReviewSessionError({
          message: "Could not open the pull request review.",
          cause,
        });

  const read: ReviewHostService["Service"]["read"] = Effect.fn("ReviewHostService.read")(function* (
    input,
  ) {
    const data = yield* pullRequests.reviewRound(input);
    if (data === null) return { viewerLogin: null, sources: [], items: [], comments: {} };
    const plan = planReviewSync({
      sessionRound: 1,
      roundState: "collecting",
      existing: [],
      read: data,
      now: DateTime.formatIso(yield* DateTime.now),
    });
    return {
      viewerLogin: data.viewerLogin,
      sources: plan.upserts.map(({ source }) => source),
      items: rawReviewItems({ round: 1, nextNumber: 1 }, [], plan.upserts, {
        viewerLogin: data.viewerLogin,
      }).map((item) => ({
        ...item,
        githubState: itemGithubState(item.githubThreadIds, plan.threads),
      })),
      comments: Object.fromEntries(
        plan.upserts.map(({ source, comments }) => [source.id, comments ?? []]),
      ),
    };
  }, Effect.mapError(failure));

  const groupOf = Effect.fn("ReviewHostService.groupOf")(function* (
    thread: OrchestrationV2ThreadShell,
  ) {
    if (thread.groupId != null) return thread.groupId;
    const groupId = ThreadGroupId.make(`review-group:${thread.id}`);
    yield* groups.create({
      commandId: CommandId.make(`review-group:${yield* crypto.randomUUIDv4()}`),
      groupId,
      projectId: thread.projectId,
      threadIds: [thread.id],
      title: thread.title,
    });
    return groupId;
  });

  const openPullRequest = Effect.fn("ReviewHostService.openPullRequest")(function* (
    input: ReviewHostInput,
  ) {
    const detail = yield* pullRequests.summary(input);
    if (detail.state !== "open")
      return yield* new ReviewSessionError({
        message: "Only open pull requests can start a review.",
        cause: null,
      });
    const key = {
      host: new URL(detail.url).host.toLowerCase(),
      repository: detail.repository.toLowerCase(),
      number: detail.number,
    };
    return { detail, key };
  });

  /**
   * The pull request's own "Review #N" chat, in its own group and checkout. Chats that worked on
   * the PR are never picked: the review runs beside them, not inside their group.
   */
  const ensureReviewChat = Effect.fn("ReviewHostService.ensureReviewChat")(function* (
    input: ReviewHostInput,
  ) {
    const { detail, key } = yield* openPullRequest(input);
    // Stable identity makes retries reuse a prepared review chat, even after a server restart.
    const stableId = ThreadId.make(
      `pr-review:${input.projectId}:${key.host}:${key.repository}:${key.number}`,
    );
    const existing = yield* threads.getThreadShell(stableId);
    let thread =
      existing !== null && existing.deletedAt === null && existing.archivedAt === null
        ? existing
        : null;
    if (thread === null) {
      const found = yield* projects.getById(input.projectId);
      if (Option.isNone(found))
        return yield* new ReviewSessionError({
          message: "The registered project is no longer available.",
          cause: null,
        });
      const project = found.value;
      const resolved = resolveProjectSettings(
        yield* settings.getSettings,
        project.id,
        project,
      ).settings;
      const snapshot = yield* threads.getShellSnapshot();
      const previous = snapshot.threads.find(
        (candidate) =>
          candidate.projectId === project.id &&
          candidate.lineage.relationshipToParent !== "subagent",
      );
      // An archived or deleted review chat keeps its id; the new one needs another.
      const id =
        existing === null ? stableId : ThreadId.make(`${stableId}:${yield* crypto.randomUUIDv4()}`);
      const modelSelection = resolved.defaultModelSelection ??
        previous?.modelSelection ?? {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        };
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`review-create:${id}`),
        threadId: id,
        projectId: project.id,
        title: `Review #${detail.number}: ${detail.title}`,
        modelSelection,
        runtimeMode: resolved.defaultRuntimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "server",
      });
      const prepared = yield* git.preparePullRequestThread({
        cwd: project.workspaceRoot,
        reference: detail.url,
        mode: "worktree",
        threadId: id,
      });
      if (!prepared.isOnPullRequestHead || prepared.worktreePath === null)
        return yield* new ReviewSessionError({
          message:
            "The review checkout is not on the current PR head. Update its checkout before reviewing.",
          cause: null,
        });
      // Bind synchronously: ThreadLaunch's background preparation may otherwise race
      // group creation and start the independent reviewer in the project root.
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`review-checkout:${yield* crypto.randomUUIDv4()}`),
        threadId: id,
        expectedEmpty: true,
        worktreePath: prepared.worktreePath,
        branch: prepared.branch,
      });
      const created = yield* threads.getThreadShell(id);
      if (created === null)
        return yield* new ReviewSessionError({
          message: "The review chat could not be found.",
          cause: null,
        });
      thread = created;
      yield* threads.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make(`review-link:${yield* crypto.randomUUIDv4()}`),
        threadId: id,
        ...key,
        url: detail.url,
        source: "manual",
      });
    }
    return { thread, groupId: yield* groupOf(thread), detail, key };
  });

  const start: ReviewHostService["Service"]["start"] = (input) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const { key } = yield* openPullRequest(input);
          // A review already running its own review stays where it is, even in a group it was
          // moved to; Run your review then just opens it.
          const live = yield* reviews.findSessionForPullRequest(key);
          if (live !== null && (yield* reviews.hasLiveReviewChat(live.id))) {
            if (hasLocalReview(yield* reviews.read(live.id)))
              return { threadId: live.reviewThreadId };
          }
          const { thread, groupId, detail } = yield* ensureReviewChat(input);
          const { snapshot: opened } = yield* reviews.open({
            key,
            url: detail.url,
            projectId: thread.projectId,
            groupId,
            reviewThreadId: thread.id,
            headSha: null,
          });
          if (!hasLocalReview(opened))
            yield* reviews.runLocalReview({ sessionId: opened.session.id });
          return { threadId: opened.session.reviewThreadId };
        }),
      )
      .pipe(Effect.mapError(failure));

  /**
   * The chat beside the panel that a review action runs in: any live chat of the review's project.
   * It takes the review over first, so the action never lands in a chat the user is not looking at.
   */
  const besideChat = Effect.fn("ReviewHostService.besideChat")(function* (
    input: ReviewRequestInput,
    session: ReviewSession,
  ) {
    if (input.targetThreadId === undefined || session.phase === "done") return null;
    if (input.request._tag === "rewrite-reply" || input.request._tag === "finish") return null;
    const shell = yield* threads.getThreadShell(input.targetThreadId);
    if (
      shell === null ||
      shell.deletedAt !== null ||
      shell.archivedAt !== null ||
      shell.projectId !== session.projectId ||
      shell.lineage.relationshipToParent === "subagent"
    )
      return null;
    return shell;
  });

  const request: ReviewHostService["Service"]["request"] = (input) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const { session } = yield* reviews.read(input.sessionId);
          const beside = yield* besideChat(input, session);
          if (beside !== null) {
            yield* reviews.moveToChat({
              sessionId: session.id,
              threadId: beside.id,
              groupId: yield* groupOf(beside),
            });
            return;
          }
          if (yield* reviews.hasLiveReviewChat(input.sessionId)) return;
          const { thread, groupId } = yield* ensureReviewChat({
            projectId: session.projectId,
            host: session.pullRequest.host,
            repository: session.pullRequest.repository,
            number: session.pullRequest.number,
          });
          yield* reviews.open({
            key: session.pullRequest,
            url: session.url,
            projectId: thread.projectId,
            groupId,
            reviewThreadId: thread.id,
            headSha: null,
          });
        }),
      )
      .pipe(
        Effect.flatMap(() => reviews.requestTurn(input)),
        Effect.mapError(failure),
      );

  return ReviewHostService.of({ read, start, request });
});
export const layer = Layer.effect(ReviewHostService, make);
