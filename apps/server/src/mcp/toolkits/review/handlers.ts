import {
  OrchestratorMcpFailure,
  type ReviewSessionId,
  type ReviewSessionError,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { normalizeThreadPullRequestKey } from "@t3tools/shared/threadPullRequests";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { reviewBrief } from "../../../reviewSessions/reviewBrief.ts";
import * as ReviewSessionService from "../../../reviewSessions/ReviewSessionService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { ReviewToolkit } from "./tools.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/**
 * Review errors are written for the agent. One with a cause (storage, or a chat that could not
 * be reached) is the server's failure, not a bad request: its cause is logged, never shown.
 */
const reviewFailure = (error: ReviewSessionError) =>
  error.cause === undefined
    ? Effect.fail(invalid(error.message))
    : Effect.logWarning("review tool failed", {
        sessionId: error.sessionId,
        message: error.message,
        cause: error.cause,
      }).pipe(
        Effect.andThen(
          Effect.fail(
            new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        ),
      );

/**
 * Every review tool acts for the chat that calls it, under the pull-requests capability. The
 * chat is always the caller, never a tool input, so a decision is checked against its own words.
 */
const callingChat = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has("pull-requests")) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential cannot work on pull request reviews.",
    });
  }
  const context = yield* loadCaller();
  if (context.caller === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "target_required",
      message: "Review tools run inside a T3 chat.",
    });
  }
  return context.caller;
});

/** The review this chat works on, and its role in it. */
const reviewAccess = (input: { readonly sessionId?: ReviewSessionId | undefined }) =>
  Effect.gen(function* () {
    const caller = yield* callingChat;
    const sessions = yield* ReviewSessionService.ReviewSessionService;
    const access = yield* sessions
      .resolveForThread({ threadId: caller.id, groupId: caller.groupId ?? null, ...input })
      .pipe(Effect.catch(reviewFailure));
    return { ...access, caller };
  });

const LOCAL_ONLY =
  "This chat runs your independent review: it may not read the list (it holds the other reviews' comments) and may only hand in findings with review_source_submit.";

/** The review chat does everything; a side chat discusses its point; the local review submits. */
const requireReviewChat = (access: ReviewSessionService.ReviewSessionAccess, what: string) => {
  if (access.role === "review") return Effect.void;
  if (access.role === "local") return Effect.fail(invalid(LOCAL_ONLY));
  return Effect.fail(
    invalid(
      `This side chat is about #${access.scopedToItem} only; ${what} happens in the review chat.`,
    ),
  );
};

const requireItemInScope = (access: ReviewSessionService.ReviewSessionAccess, number: number) => {
  if (access.role === "local") return Effect.fail(invalid(LOCAL_ONLY));
  return access.role === "side" && access.scopedToItem !== number
    ? Effect.fail(
        invalid(
          `This side chat is about #${access.scopedToItem} only. Discuss #${number} in the review chat.`,
        ),
      )
    : Effect.void;
};

export const layer = McpToolAccess.toLayer(ReviewToolkit, {
  review_session_open: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* callingChat;
      const sessions = yield* ReviewSessionService.ReviewSessionService;
      // A side chat or your review's chat already belongs to a review and is no review chat.
      const existing = yield* sessions
        .resolveForThread({ threadId: caller.id, groupId: caller.groupId ?? null })
        .pipe(Effect.option);
      if (Option.isSome(existing)) yield* requireReviewChat(existing.value, "opening a review");
      const groupId = caller.groupId ?? null;
      if (groupId === null) {
        return yield* invalid(
          "Put this chat in the pull request's group first: t3_group_create, or t3_group_move_thread into the group.",
        );
      }
      const parsed = parseChangeRequestUrl(input.url);
      if (parsed === null) return yield* invalid("This is not a recognised pull request URL.");
      if (parsed.host !== "github.com")
        return yield* invalid("Review sessions support GitHub pull requests.");
      if (!/^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(parsed.repository)) {
        return yield* invalid("This is not a recognised GitHub repository.");
      }
      const key = normalizeThreadPullRequestKey(parsed);
      const result = yield* sessions
        .open({
          key,
          url: `https://${key.host}/${key.repository}/pull/${key.number}`,
          projectId: caller.projectId,
          groupId,
          reviewThreadId: caller.id,
          headSha: input.headSha ?? null,
        })
        .pipe(Effect.catch(reviewFailure));
      return {
        ...result.snapshot,
        created: result.created,
        brief: reviewBrief(result.snapshot.session),
      };
    }),
  ),
  review_session_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const access = yield* reviewAccess(input);
      if (access.role === "local") return yield* invalid(LOCAL_ONLY);
      const sessions = yield* ReviewSessionService.ReviewSessionService;
      const view = yield* sessions
        .agentView({ sessionId: access.session.id, threadId: access.caller.id })
        .pipe(Effect.catch(reviewFailure));
      return {
        ...view.snapshot,
        sources: view.snapshot.sources.map((source) => ({
          ...source,
          comments: view.comments[source.id] ?? [],
        })),
        role: access.role,
        scopedToItem: access.scopedToItem,
        focusedItem: view.focusedItem,
        stack: view.stack,
      };
    }),
  ),
  review_source_submit: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const access = yield* reviewAccess(input);
      if (access.role !== "local" || access.localSourceId === null) {
        return yield* invalid("Only the chat your local review runs in hands in its findings.");
      }
      const sessions = yield* ReviewSessionService.ReviewSessionService;
      const source = yield* sessions
        .submitLocalFindings({
          sessionId: access.session.id,
          sourceId: access.localSourceId,
          headSha: input.headSha,
          findings: input.findings.map((finding) => ({
            path: finding.path ?? null,
            line: finding.line ?? null,
            title: finding.title,
            body: finding.body,
            slug: finding.slug,
          })),
        })
        .pipe(Effect.catch(reviewFailure));
      return { source };
    }),
  ),
  review_local_review_start: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const access = yield* reviewAccess(input);
      yield* requireReviewChat(access, "starting a review");
      const sessions = yield* ReviewSessionService.ReviewSessionService;
      return yield* sessions
        .runLocalReview({ sessionId: access.session.id })
        .pipe(Effect.catch(reviewFailure));
    }),
  ),
  review_items_import: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const access = yield* reviewAccess(input);
      yield* requireReviewChat(access, "triage");
      const sessions = yield* ReviewSessionService.ReviewSessionService;
      const result = yield* sessions
        .importItems({
          sessionId: access.session.id,
          sourceIds: input.sourceIds,
          items: input.items.map((item) => ({
            sourceKeys: item.sourceKeys,
            sources: item.sources,
            githubThreadIds: item.githubThreadIds ?? [],
            path: item.path ?? null,
            line: item.line ?? null,
            summary: item.summary,
            shortName: item.shortName,
            problem: item.problem,
            impact: item.impact,
            solution: item.solution,
            skipReason: item.skipReason,
            excerpt: item.excerpt ?? null,
            recommendation: item.recommendation ?? null,
            suggestedDecision: item.suggestedDecision ?? null,
            alreadyFixedIn: item.alreadyFixedIn ?? null,
            draftReply: item.draftReply ?? null,
          })),
        })
        .pipe(Effect.catch(reviewFailure));
      return { ...result.snapshot, created: result.created, matched: result.matched };
    }),
  ),
  review_items_annotate: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const access = yield* reviewAccess(input);
      yield* requireItemInScope(access, input.number);
      const sessions = yield* ReviewSessionService.ReviewSessionService;
      const { number, ...annotation } = input;
      const item = yield* sessions
        .annotate({ sessionId: access.session.id, number, annotation })
        .pipe(Effect.catch(reviewFailure));
      return { item };
    }),
  ),
  review_items_decide: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const access = yield* reviewAccess(input);
      yield* requireItemInScope(access, input.number);
      const sessions = yield* ReviewSessionService.ReviewSessionService;
      const item = yield* sessions
        .decide({
          sessionId: access.session.id,
          number: input.number,
          decision: input.decision,
          reason: input.reason,
          postAs: input.postAs,
          authority: { _tag: "chat", threadId: access.caller.id, quote: input.quote },
        })
        .pipe(Effect.catch(reviewFailure));
      return { item };
    }),
  ),
  review_items_record_apply: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const access = yield* reviewAccess(input);
      yield* requireReviewChat(access, "applying");
      const sessions = yield* ReviewSessionService.ReviewSessionService;
      const item = yield* sessions
        .recordApply({
          sessionId: access.session.id,
          number: input.number,
          applyState: input.applyState,
          githubThreadIds: input.githubThreadIds,
          conclusion: input.conclusion,
          draftReply: input.draftReply,
        })
        .pipe(Effect.catch(reviewFailure));
      return { item };
    }),
  ),
  review_round_advance: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const access = yield* reviewAccess(input);
      yield* requireReviewChat(access, "running rounds");
      const sessions = yield* ReviewSessionService.ReviewSessionService;
      return yield* sessions
        .advanceRound({
          sessionId: access.session.id,
          headSha: input.headSha,
          finish: input.finish ?? false,
        })
        .pipe(Effect.catch(reviewFailure));
    }),
  ),
});
