import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProviderInstanceId,
  ReviewSessionError,
  ThreadGroupId,
  ThreadId,
  type ReviewHostInput,
  type ReviewHostResult,
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

export class ReviewHostService extends Context.Service<
  ReviewHostService,
  {
    readonly read: (input: ReviewHostInput) => Effect.Effect<ReviewHostResult, ReviewSessionError>;
    readonly start: (
      input: ReviewHostInput,
    ) => Effect.Effect<ReviewThreadResult, ReviewSessionError>;
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

  const read: ReviewHostService["Service"]["read"] = (input) =>
    Effect.gen(function* () {
      const data = yield* pullRequests.reviewRound(input);
      if (data === null) return { sources: [], items: [], comments: {} };
      const plan = planReviewSync({
        sessionRound: 1,
        roundState: "collecting",
        existing: [],
        read: data,
        now: DateTime.formatIso(yield* DateTime.now),
      });
      return {
        sources: plan.upserts.map(({ source }) => source),
        items: rawReviewItems({ round: 1, nextNumber: 1 }, [], plan.upserts).map((item) => ({
          ...item,
          githubState: itemGithubState(item.githubThreadIds, plan.threads),
        })),
        comments: Object.fromEntries(
          plan.upserts.map(({ source, comments }) => [source.id, comments ?? []]),
        ),
      };
    }).pipe(Effect.mapError(failure));

  const start: ReviewHostService["Service"]["start"] = (input) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
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
          const snapshot = yield* threads.getShellSnapshot();
          const linked = snapshot.threads.filter(
            (thread) =>
              thread.archivedAt === null &&
              thread.lineage.relationshipToParent !== "subagent" &&
              (thread.pullRequests ?? []).some(
                (link) =>
                  link.host === key.host &&
                  link.repository.toLowerCase() === key.repository &&
                  link.number === key.number &&
                  link.source !== "stack-dismissed",
              ),
          );
          const groupKeys = new Set(linked.map((thread) => thread.groupId ?? thread.id));
          if (groupKeys.size > 1)
            return yield* new ReviewSessionError({
              message: "Choose the review group before starting your review.",
              cause: null,
            });
          let thread = linked[0];
          if (thread === undefined) {
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
            const previous = snapshot.threads.find(
              (candidate) =>
                candidate.projectId === project.id &&
                candidate.lineage.relationshipToParent !== "subagent",
            );
            // Stable identity makes retries reuse a prepared review chat, even after a server restart.
            const id = ThreadId.make(
              `pr-review:${project.id}:${key.host}:${key.repository}:${key.number}`,
            );
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
          const groupId = thread.groupId ?? ThreadGroupId.make(`review-group:${thread.id}`);
          if (thread.groupId == null)
            yield* groups.create({
              commandId: CommandId.make(`review-group:${yield* crypto.randomUUIDv4()}`),
              groupId,
              projectId: thread.projectId,
              threadIds: [thread.id],
              title: thread.title,
            });
          const { snapshot: opened } = yield* reviews.open({
            key,
            url: detail.url,
            projectId: thread.projectId,
            groupId,
            reviewThreadId: thread.id,
            headSha: null,
          });
          if (
            !opened.sources.some(
              (source) =>
                source.kind === "local" &&
                source.round === opened.session.round &&
                source.threadId !== null &&
                (source.state === "reviewing" || source.state === "done"),
            )
          ) {
            yield* reviews.runLocalReview({ sessionId: opened.session.id });
          }
          return { threadId: opened.session.reviewThreadId };
        }),
      )
      .pipe(Effect.mapError(failure));
  return ReviewHostService.of({ read, start });
});
export const layer = Layer.effect(ReviewHostService, make);
