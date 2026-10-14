import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ThreadId } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
function harness(options: { linked?: boolean; currentHead?: boolean; closed?: boolean } = {}) {
  let shell = options.linked
    ? { ...chatShell(ThreadId.make("linked")), pullRequests: [prLink(23, "feature", "main")] }
    : null;
  const launches: string[] = [];
  let prepared = 0;
  let runs = 0;
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
          getShellSnapshot: () => Effect.succeed({ threads: shell ? [shell] : [] } as never),
          getThreadShell: () => Effect.sync(() => shell),
          dispatch: (command) =>
            Effect.sync(() => {
              if (command.type === "thread.create") {
                launches.push(command.threadId);
                shell = {
                  ...chatShell(command.threadId),
                  groupId: null,
                  pullRequests: [],
                  worktreePath: null,
                };
              } else if (command.type === "thread.metadata.update" && shell) {
                shell = { ...shell, worktreePath: command.worktreePath ?? shell.worktreePath };
              } else if (command.type === "thread.pull-request.link" && shell) {
                shell = { ...shell, pullRequests: [prLink(23, "feature", "main")] };
              }
              return {} as never;
            }),
        }),
        Layer.mock(Groups.ThreadGroupService)({ create: () => Effect.succeed({} as never) }),
        Layer.mock(Projects.ProjectService)({
          getById: () =>
            Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/repo" } as never)),
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
          open: () =>
            Effect.succeed({
              created: true,
              snapshot: {
                session: sessionFixture(),
                rounds: [roundFixture(1)],
                sources: [],
                items: [],
              },
            }),
          runLocalReview: () =>
            Effect.sync(() => {
              if (!options.linked) assert.equal(shell?.worktreePath, "/isolated");
              runs++;
              return { threadId: ThreadId.make("local") };
            }),
        }),
      ),
    ),
  );
  return { layer, launches, counts: () => ({ prepared, runs }) };
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
    assert.equal(h.launches.length, 1);
    assert.deepEqual(h.counts(), { prepared: 1, runs: 1 });
  }).pipe(Effect.provide(h.layer));
});
it.effect("reuses a linked group instead of making another checkout", () => {
  const h = harness({ linked: true });
  return Effect.gen(function* () {
    yield* (yield* Host.ReviewHostService).start(reference);
    assert.equal(h.launches.length, 0);
    assert.deepEqual(h.counts(), { prepared: 0, runs: 1 });
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
