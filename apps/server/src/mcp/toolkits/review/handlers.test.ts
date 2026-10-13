import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";

import * as ReviewSessionService from "../../../reviewSessions/ReviewSessionService.ts";
import {
  chatShell,
  groupId,
  insertProjectionMessage,
  makeReviewServiceLayer,
  newHarness,
  prUrl,
  reviewThreadId,
} from "../../../reviewSessions/testkit.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ReviewHandlers from "./handlers.ts";
import { ReviewToolkit } from "./tools.ts";

const toolItem = (key: string) => ({
  sourceKeys: [key],
  sources: ["copilot"],
  summary: `Point ${key}`,
  shortName: `point ${key}`,
  problem: "It breaks.",
  impact: "Users see it.",
  solution: "Fix it.",
  skipReason: "No reason to skip.",
  suggestedDecision: "fix" as const,
});

const threadCapabilities: ReadonlyArray<McpInvocationContext.McpCapability> = [
  "orchestration",
  "worktree",
  "pull-requests",
];

/** One database; each `as(threadId)` calls the tools as that chat. */
const harnessed = Effect.gen(function* () {
  const harness = newHarness();
  const services = yield* Layer.build(makeReviewServiceLayer(harness));
  const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(Layer.succeedContext(services)));
  const as = (
    callerId: ThreadId,
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = threadCapabilities,
  ) =>
    Effect.gen(function* () {
      const dependencies = Layer.mergeAll(
        Layer.succeedContext(services),
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment"),
          requestNamespace: "session",
          thread: {
            threadId: callerId,
            providerSessionId: "session",
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          },
          client: undefined,
          issuedAt: 0,
          capabilities: new Set(capabilities),
        }),
      );
      const toolkit = yield* ReviewToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ReviewHandlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      return <Name extends keyof typeof ReviewToolkit.tools>(
        name: Name,
        params: Parameters<typeof toolkit.handle<Name>>[1],
      ) =>
        toolkit.handle(name, params).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((parts) => parts.at(-1)?.result),
          Effect.provide(dependencies),
        );
    });
  return { harness, provided, as };
});

const reviewService = Effect.service(ReviewSessionService.ReviewSessionService);
const sqlClient = Effect.service(SqlClient.SqlClient);

it("lets no tool set or clear a point's viewed box", () => {
  for (const tool of Object.values(ReviewToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {}), tool.name).not.toContain("viewed");
  }
  // The deciding chat is always the caller: no tool takes a thread to act for.
  for (const tool of Object.values(ReviewToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {}), tool.name).not.toContain("threadId");
  }
});

it.effect("opens the review from a grouped chat with its brief, and refuses an ungrouped one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { harness, as } = yield* harnessed;
      const loner = ThreadId.make("thread:loner");
      harness.shells.set(loner, chatShell(loner, { groupId: null }));
      const lonerTools = yield* as(loner);
      expect(yield* lonerTools("review_session_open", { url: prUrl })).toMatchObject({
        code: "invalid_request",
      });

      const review = yield* as(reviewThreadId);
      expect(yield* review("review_session_open", { url: prUrl, headSha: "abc123" })).toMatchObject(
        {
          created: true,
          session: { groupId, reviewThreadId, round: 1, pullRequest: { number: 23 } },
          rounds: [{ round: 1, state: "collecting" }],
          items: [],
          brief: expect.stringContaining("review_items_decide"),
        },
      );
      expect(
        yield* review("review_items_import", {
          sourceIds: [],
          items: [toolItem("gh:T1"), toolItem("gh:T2")],
        }),
      ).toMatchObject({ created: [1, 2], matched: [] });
      expect(yield* review("review_session_read", {})).toMatchObject({
        role: "review",
        scopedToItem: null,
        focusedItem: null,
        items: [{ number: 1 }, { number: 2 }],
      });
    }),
  ),
);

it.effect("refuses a credential without the pull-requests capability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { as } = yield* harnessed;
      const review = yield* as(reviewThreadId, ["orchestration"]);
      expect(yield* review("review_session_open", { url: prUrl })).toMatchObject({
        code: "capability_denied",
      });
      expect(yield* review("review_session_read", {})).toMatchObject({
        code: "capability_denied",
      });
    }),
  ),
);

it.effect("a question through the tool changes nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { provided, as } = yield* harnessed;
      const review = yield* as(reviewThreadId);
      yield* review("review_session_open", { url: prUrl });
      yield* review("review_items_import", {
        sourceIds: [],
        items: [toolItem("gh:T1"), toolItem("gh:T2")],
      });
      const sql = yield* provided(sqlClient);
      yield* insertProjectionMessage(sql, {
        threadId: reviewThreadId,
        messageId: "m1",
        text: "why #2?",
        createdAt: "2026-10-13T10:00:00.000Z",
      });
      expect(
        yield* review("review_items_decide", { number: 2, decision: "fix", quote: "why #2?" }),
      ).toMatchObject({ code: "invalid_request", message: expect.stringContaining("question") });
      expect(yield* review("review_session_read", {})).toMatchObject({
        items: [{ number: 1 }, { number: 2, decision: "needs-call" }],
      });
    }),
  ),
);

it.effect("keeps a side chat to its point and the local review to its findings", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { provided, as } = yield* harnessed;
      const review = yield* as(reviewThreadId);
      yield* review("review_session_open", { url: prUrl });
      yield* review("review_items_import", {
        sourceIds: [],
        items: [toolItem("gh:T1"), toolItem("gh:T2")],
      });
      const reviews = yield* provided(reviewService);
      const access = yield* reviews.resolveForThread({ threadId: reviewThreadId, groupId });
      const { threadId: sideThreadId } = yield* reviews.openSideChat({
        sessionId: access.session.id,
        number: 1,
      });
      const sql = yield* provided(sqlClient);
      yield* insertProjectionMessage(sql, {
        threadId: sideThreadId,
        messageId: "m1",
        text: "decline, out of scope",
        createdAt: "2026-10-13T10:00:00.000Z",
      });
      // The quote is checked against the calling chat's own latest message, not the side chat's.
      expect(
        yield* review("review_items_decide", {
          number: 1,
          decision: "decline",
          quote: "decline, out of scope",
        }),
      ).toMatchObject({ code: "invalid_request" });

      const side = yield* as(sideThreadId);
      expect(yield* side("review_session_read", {})).toMatchObject({
        role: "side",
        scopedToItem: 1,
      });
      expect(
        yield* side("review_items_decide", {
          number: 2,
          decision: "decline",
          quote: "decline, out of scope",
        }),
      ).toMatchObject({ code: "invalid_request", message: expect.stringContaining("#1 only") });
      expect(
        yield* side("review_items_annotate", { number: 2, recommendation: "Skip it." }),
      ).toMatchObject({ code: "invalid_request", message: expect.stringContaining("#1 only") });
      expect(yield* side("review_round_advance", { headSha: "def456" })).toMatchObject({
        code: "invalid_request",
      });
      expect(
        yield* side("review_items_import", { sourceIds: [], items: [toolItem("gh:T3")] }),
      ).toMatchObject({ code: "invalid_request" });
      expect(
        yield* side("review_items_record_apply", { number: 1, applyState: "working" }),
      ).toMatchObject({ code: "invalid_request" });
      expect(yield* side("review_local_review_start", {})).toMatchObject({
        code: "invalid_request",
      });
      expect(
        yield* side("review_items_annotate", { number: 1, recommendation: "Out of scope." }),
      ).toMatchObject({ item: { number: 1, recommendation: "Out of scope." } });
      expect(
        yield* side("review_items_decide", {
          number: 1,
          decision: "decline",
          quote: "decline, out of scope",
          reason: "Out of scope",
        }),
      ).toMatchObject({ item: { number: 1, decision: "decline", decidedBy: "chat" } });

      // Your review runs blind to the list and may only hand in its findings.
      const { threadId: localThreadId } = yield* review("review_local_review_start", {}).pipe(
        Effect.map((result) => result as { readonly threadId: ThreadId }),
      );
      const local = yield* as(localThreadId);
      expect(yield* local("review_session_read", {})).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("independent"),
      });
      expect(
        yield* local("review_items_import", { sourceIds: [], items: [toolItem("gh:T3")] }),
      ).toMatchObject({ code: "invalid_request" });
      expect(
        yield* local("review_items_annotate", { number: 1, recommendation: "x" }),
      ).toMatchObject({ code: "invalid_request", message: expect.stringContaining("independent") });
      expect(
        yield* local("review_items_decide", { number: 1, decision: "fix", quote: "fix it" }),
      ).toMatchObject({ code: "invalid_request", message: expect.stringContaining("independent") });
      expect(yield* local("review_local_review_start", {})).toMatchObject({
        code: "invalid_request",
      });
      // Opening returns the list, so neither chat may reach it that way either.
      expect(yield* local("review_session_open", { url: prUrl })).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("independent"),
      });
      expect(yield* side("review_session_open", { url: prUrl })).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("#1 only"),
      });
      expect(
        yield* local("review_source_submit", {
          headSha: "abc123",
          findings: [
            {
              path: "apps/server/src/auth.ts",
              line: 12,
              title: "Null session",
              body: "Return 401.",
              slug: "null-session",
            },
          ],
        }),
      ).toMatchObject({ source: { kind: "local", state: "done", commentCount: 1 } });
      expect(
        yield* review("review_source_submit", { headSha: "abc123", findings: [] }),
      ).toMatchObject({ code: "invalid_request" });
      expect(
        yield* side("review_source_submit", { headSha: "abc123", findings: [] }),
      ).toMatchObject({ code: "invalid_request" });
    }),
  ),
);
