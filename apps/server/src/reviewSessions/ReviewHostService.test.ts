import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadGroupId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Host from "./ReviewHostService.ts";
import * as Reviews from "./ReviewSessionService.ts";
import * as PullRequests from "../pullRequest/PullRequestService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Groups from "../orchestration-v2/ThreadGroupService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Git from "../git/GitWorkflowService.ts";
import * as Settings from "../serverSettings.ts";
import {
  chatShell,
  githubReview,
  githubThread,
  threadComment,
  reviewRoundRead,
  sessionFixture,
  roundFixture,
  prLink,
  projectId,
} from "./testkit.ts";

const reference = { projectId, repository: "nachogames/ctrl", number: 23 };
const reviewChatId = ThreadId.make("pr-review:project:github.com:nachogames/ctrl:23");
const authoringChat = () => ({
  ...chatShell(ThreadId.make("linked")),
  pullRequests: [prLink(23, "feature", "main")],
});
function harness(
  options: {
    linked?: boolean;
    currentHead?: boolean;
    closed?: boolean;
    reviewChatLive?: boolean;
    /** A live review of this PR, and whether it already ran your own review. */
    live?: { localReview: boolean };
    /** Chats besides the authoring one, such as one the panel sits beside. */
    chats?: ReadonlyArray<OrchestrationV2ThreadShell>;
  } = {},
) {
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>();
  if (options.linked) shells.set(ThreadId.make("linked"), authoringChat());
  for (const chat of options.chats ?? []) shells.set(chat.id, chat);
  const launches: string[] = [];
  const groupsCreated: string[] = [];
  let prepared = 0;
  let runs = 0;
  const opened: Array<{ thread: string; group: string }> = [];
  const moved: Array<{ thread: string; group: string }> = [];
  const turns: string[] = [];
  const snapshot = {
    session: sessionFixture(),
    rounds: [roundFixture(1)],
    sources: options.live?.localReview
      ? [{ kind: "local", round: 1, threadId: "local", state: "done" }]
      : [],
    items: [],
  } as never;
  const layer = Host.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(PullRequests.PullRequestService)({
          summary: () =>
            Effect.succeed({
              ...reference,
              url: "https://github.com/nachogames/ctrl/pull/23",
              title: "Fix",
              state: options.closed ? "closed" : "open",
            } as never),
          reviewRound: () =>
            Effect.succeed(
              reviewRoundRead({
                reviews: [githubReview("R1", "copilot-pull-request-reviewer")],
                threads: [githubThread("T1", [threadComment("R1", "Problem")])],
                pendingReviewers: [{ login: "dan", name: null, avatarUrl: null, isBot: false }],
              }),
            ),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getShellSnapshot: () => Effect.sync(() => ({ threads: [...shells.values()] }) as never),
          getThreadShell: (id) => Effect.sync(() => shells.get(id) ?? null),
          dispatch: (command) =>
            Effect.sync(() => {
              if (command.type === "thread.create") {
                launches.push(command.threadId);
                shells.set(command.threadId, {
                  ...chatShell(command.threadId),
                  groupId: null,
                  pullRequests: [],
                  worktreePath: null,
                });
              } else if (command.type === "thread.metadata.update") {
                const shell = shells.get(command.threadId)!;
                shells.set(command.threadId, {
                  ...shell,
                  worktreePath: command.worktreePath ?? shell.worktreePath,
                });
              } else if (command.type === "thread.pull-request.link") {
                const shell = shells.get(command.threadId)!;
                shells.set(command.threadId, {
                  ...shell,
                  pullRequests: [prLink(23, "feature", "main")],
                });
              }
              return {} as never;
            }),
        }),
        Layer.mock(Groups.ThreadGroupService)({
          create: (input) =>
            Effect.sync(() => {
              groupsCreated.push(input.groupId);
              return {} as never;
            }),
        }),
        Layer.mock(Projects.ProjectService)({
          getById: () => Effect.succeedSome({ id: projectId, workspaceRoot: "/repo" } as never),
        }),
        Layer.mock(Git.GitWorkflowService)({
          preparePullRequestThread: () =>
            Effect.sync(() => {
              prepared++;
              return {
                worktreePath: "/isolated",
                branch: "review",
                isOnPullRequestHead: options.currentHead !== false,
              } as never;
            }),
        }),
        Layer.mock(Settings.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
        Layer.mock(Reviews.ReviewSessionService)({
          findSessionForPullRequest: () =>
            Effect.succeed(options.live === undefined ? null : sessionFixture()),
          isAssignedChat: (id) => Effect.succeed(id === ThreadId.make("point")),
          hasLiveReviewChat: () => Effect.succeed(options.reviewChatLive !== false),
          read: () => Effect.succeed(snapshot),
          requestTurn: (input) =>
            Effect.sync(() => {
              turns.push(input.request._tag);
            }),
          open: (input) =>
            Effect.sync(() => {
              opened.push({ thread: input.reviewThreadId, group: input.groupId });
            }).pipe(Effect.as({ created: true, snapshot })),
          moveToChat: (input) =>
            Effect.sync(() => {
              moved.push({ thread: input.threadId, group: input.groupId });
            }),
          runLocalReview: () =>
            Effect.sync(() => {
              const reviewChat = shells.get(reviewChatId);
              if (reviewChat) assert.equal(reviewChat.worktreePath, "/isolated");
              runs++;
              return { threadId: ThreadId.make("local") };
            }),
        }),
      ),
    ),
  );
  return {
    layer,
    launches,
    groupsCreated,
    opened,
    moved,
    turns,
    counts: () => ({ prepared, runs }),
  };
}

it.effect("reads requested and completed reviews without creating chats", () => {
  const h = harness();
  return Effect.gen(function* () {
    const host = yield* Host.ReviewHostService;
    const data = yield* host.read(reference);
    assert.equal(data.sources.find((source) => source.id === "R1")?.state, "done");
    assert.equal(data.sources.find((source) => source.author === "dan")?.state, "requested");
    assert.equal(data.items[0]?.githubState, "open");
    assert.equal(h.launches.length, 0);
    assert.deepEqual(h.counts(), { prepared: 0, runs: 0 });
  }).pipe(Effect.provide(h.layer));
});
it.effect("creates an isolated review checkout before starting the reviewer", () => {
  const h = harness();
  return Effect.gen(function* () {
    yield* (yield* Host.ReviewHostService).start(reference);
    assert.deepEqual(h.launches, [reviewChatId]);
    assert.deepEqual(h.counts(), { prepared: 1, runs: 1 });
  }).pipe(Effect.provide(h.layer));
});
it.effect("starts in its own Review chat and group even when a chat worked on the PR", () => {
  const h = harness({ linked: true, live: { localReview: false } });
  return Effect.gen(function* () {
    yield* (yield* Host.ReviewHostService).start(reference);
    assert.deepEqual(h.launches, [reviewChatId]);
    assert.deepEqual(h.opened, [{ thread: reviewChatId, group: `review-group:${reviewChatId}` }]);
    assert.deepEqual(h.counts(), { prepared: 1, runs: 1 });
  }).pipe(Effect.provide(h.layer));
});
it.effect("opens a review that already ran your review where it is", () => {
  const h = harness({ linked: true, live: { localReview: true } });
  return Effect.gen(function* () {
    const result = yield* (yield* Host.ReviewHostService).start(reference);
    assert.equal(result.threadId, sessionFixture().reviewThreadId);
    assert.deepEqual([h.launches, h.opened, h.counts()], [[], [], { prepared: 0, runs: 0 }]);
  }).pipe(Effect.provide(h.layer));
});
it.effect("does not review an outdated checkout or a closed PR", () =>
  Effect.gen(function* () {
    for (const options of [{ currentHead: false }, { closed: true }]) {
      const h = harness(options);
      const error = yield* Effect.flip(
        Effect.flatMap(Host.ReviewHostService, (host) => host.start(reference)).pipe(
          Effect.provide(h.layer),
        ),
      );
      assert.match(error.message, /current PR head|Only open/);
      assert.equal(h.counts().runs, 0);
    }
  }),
);
it.effect("sends an action straight to a live review chat", () => {
  const h = harness();
  return Effect.gen(function* () {
    yield* (yield* Host.ReviewHostService).request({
      sessionId: sessionFixture().id,
      request: { _tag: "re-review" },
    });
    assert.deepEqual([h.launches.length, h.opened, h.turns], [0, [], ["re-review"]]);
  }).pipe(Effect.provide(h.layer));
});
it.effect("hands the review to the open chat before its action runs there", () => {
  const other = ThreadGroupId.make("group:other");
  const h = harness({
    chats: [
      chatShell(ThreadId.make("beside"), { groupId: other }),
      chatShell(ThreadId.make("loose"), { groupId: null }),
      // A reviewer or point chat, and another chat of the review's own group, count too.
      chatShell(ThreadId.make("point"), { groupId: other }),
      chatShell(ThreadId.make("sibling")),
    ],
  });
  return Effect.gen(function* () {
    const host = yield* Host.ReviewHostService;
    const sessionId = sessionFixture().id;
    for (const [chat, tag] of [
      ["beside", "triage"],
      ["loose", "apply"],
      ["point", "triage"],
      ["sibling", "triage"],
    ] as const) {
      yield* host.request({
        sessionId,
        targetThreadId: ThreadId.make(chat),
        request: { _tag: tag },
      });
    }
    assert.deepEqual(h.moved, [
      { thread: "beside", group: other },
      { thread: "loose", group: "review-group:loose" },
      { thread: "point", group: other },
      { thread: "sibling", group: sessionFixture().groupId },
    ]);
    assert.deepEqual(h.groupsCreated, ["review-group:loose"]);
    assert.deepEqual(h.turns, ["triage", "apply", "triage", "triage"]);
  }).pipe(Effect.provide(h.layer));
});
it.effect("runs your review in the open chat's group after it takes the review over", () => {
  const other = ThreadGroupId.make("group:pr-6");
  const h = harness({ chats: [chatShell(ThreadId.make("pr-6"), { groupId: other })] });
  return Effect.gen(function* () {
    const host = yield* Host.ReviewHostService;
    const result = yield* host.runLocalReview({
      sessionId: sessionFixture().id,
      targetThreadId: ThreadId.make("pr-6"),
    });
    assert.deepEqual(h.moved, [{ thread: "pr-6", group: other }]);
    assert.equal(result.threadId, "local");
    assert.equal(h.counts().runs, 1);
  }).pipe(Effect.provide(h.layer));
});
it.effect("leaves the review where it is for reply rewrites and chats of other projects", () => {
  const h = harness({
    chats: [
      chatShell(ThreadId.make("elsewhere"), { groupId: ThreadGroupId.make("group:other") }),
      chatShell(ThreadId.make("foreign"), { projectId: ProjectId.make("other-project") }),
    ],
  });
  return Effect.gen(function* () {
    const host = yield* Host.ReviewHostService;
    const sessionId = sessionFixture().id;
    yield* host.request({
      sessionId,
      targetThreadId: ThreadId.make("elsewhere"),
      request: { _tag: "rewrite-reply", number: 1, style: "shorter" },
    });
    yield* host.request({
      sessionId,
      targetThreadId: ThreadId.make("foreign"),
      request: { _tag: "triage" },
    });
    assert.deepEqual([h.moved, h.opened, h.turns.length], [[], [], 2]);
  }).pipe(Effect.provide(h.layer));
});
it.effect("gives a review whose chats are gone its Review chat, then sends the action", () => {
  const h = harness({ reviewChatLive: false, linked: true });
  return Effect.gen(function* () {
    yield* (yield* Host.ReviewHostService).request({
      sessionId: sessionFixture().id,
      request: { _tag: "re-review" },
    });
    assert.deepEqual(h.launches, [reviewChatId]);
    assert.deepEqual(
      [h.opened, h.turns],
      [[{ thread: reviewChatId, group: `review-group:${reviewChatId}` }], ["re-review"]],
    );
    // Moving the review never starts another independent review.
    assert.deepEqual(h.counts(), { prepared: 1, runs: 0 });
  }).pipe(Effect.provide(h.layer));
});
