import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ComposerContextId,
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadGroupId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadGroupLaunchService from "./ThreadGroupLaunchService.ts";
import * as ThreadGroupService from "./ThreadGroupService.ts";
import * as ThreadGroupStore from "./ThreadGroupStore.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { projectCreatedEvent } from "./testkit/threadGroupFixtures.ts";

const projectId = ProjectId.make("project:group-launch");
const environmentId = EnvironmentId.make("environment-group-launch");
const source = ThreadId.make("thread-source");
const sibling = ThreadId.make("thread-sibling");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

const shell = (id: ThreadId, overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  ({
    id,
    projectId,
    title: `Chat ${id}`,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feat/auth-refactor",
    worktreePath: "/repo-worktrees/auth",
    groupId: null,
    handedOffFrom: null,
    handedOffTo: null,
    autoSettleDisabledAt: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  }) as OrchestrationV2ThreadShell;

interface Harness {
  readonly threads: Map<ThreadId, OrchestrationV2ThreadShell>;
  readonly launches: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly settles: Array<{ readonly threadId: ThreadId; readonly commandId: CommandId }>;
}

function makeLayer(
  harness: Harness,
  options: {
    readonly autoSettleAfterDays?: number | null;
    readonly failLaunch?: boolean;
    readonly failSettle?: boolean;
    /** Fails the next read of this thread once, e.g. a crash between launch and group create. */
    readonly failReadOnce?: ThreadId;
  } = {},
) {
  let failReadPending = options.failReadOnce;
  const { threads, launches, settles } = harness;
  const launchedByCommand = new Map<CommandId, ThreadId>();
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const management = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.suspend(() => {
        if (threadId === failReadPending) {
          failReadPending = undefined;
          return Effect.die("read failed");
        }
        return Effect.succeed(threads.get(threadId) ?? null);
      }),
    listProjectThreads: (input) =>
      Effect.succeed(
        [...threads.values()].filter(
          (thread) =>
            thread.projectId === input.projectId &&
            thread.archivedAt === null &&
            thread.deletedAt === null,
        ),
      ),
    getShellSnapshot: () =>
      Effect.succeed({
        schemaVersion: 1,
        snapshotSequence: 0,
        threads: [],
        archivedThreads: [],
      }),
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        if (command.type === "thread.create") {
          threads.set(
            command.threadId,
            shell(command.threadId, {
              title: command.title,
              branch: command.branch ?? null,
              worktreePath: command.worktreePath ?? null,
              groupId: command.groupId ?? null,
            }),
          );
        }
        if (command.type === "thread.metadata.update") {
          const thread = threads.get(command.threadId);
          if (thread !== undefined) {
            threads.set(command.threadId, {
              ...thread,
              ...(command.groupId === undefined ? {} : { groupId: command.groupId }),
              ...(command.handedOffFrom === undefined
                ? {}
                : { handedOffFrom: command.handedOffFrom }),
              ...(command.handedOffTo === undefined ? {} : { handedOffTo: command.handedOffTo }),
            });
          }
        }
        return { sequence: dispatched.length, storedEvents: [] };
      }),
    settleThread: (input) =>
      Effect.suspend(() => {
        if (options.failSettle === true) return Effect.die("settle failed");
        return Effect.void;
      }).pipe(
        Effect.map(() => {
          settles.push({ threadId: input.threadId, commandId: input.commandId });
          return { sequence: settles.length };
        }),
      ),
  });
  const launcher = Layer.effect(
    ThreadLaunch.ThreadLaunchService,
    Effect.gen(function* () {
      const threadService = yield* ThreadManagement.ThreadManagementService;
      return ThreadLaunch.ThreadLaunchService.of({
        launch: (input) =>
          Effect.gen(function* () {
            launches.push(input);
            if (options.failLaunch === true) {
              return yield* new ThreadLaunch.ThreadLaunchError({
                operation: "create-thread",
                commandId: input.commandId,
                projectId: input.projectId,
                cause: "boom",
              });
            }
            const previous = launchedByCommand.get(input.commandId);
            if (previous !== undefined) {
              return {
                threadId: previous,
                projection: undefined as never,
                resumed: true,
              };
            }
            const threadId = ThreadId.make(`thread-launched-${launchedByCommand.size + 1}`);
            launchedByCommand.set(input.commandId, threadId);
            yield* threadService
              .dispatch({
                type: "thread.create",
                commandId: input.commandId,
                threadId,
                projectId: input.projectId,
                title: input.title,
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                branch: input.workspaceStrategy.branch ?? null,
                worktreePath:
                  input.workspaceStrategy.type === "existing_worktree"
                    ? input.workspaceStrategy.worktreePath
                    : null,
                ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
                createdBy: input.createdBy,
                creationSource: input.creationSource,
              })
              .pipe(Effect.orDie);
            return { threadId, projection: undefined as never, resumed: false };
          }),
        checkWorktreeBase: () => Effect.void,
        retryPreparation: () => Effect.die("unused"),
      });
    }),
  );
  return ThreadGroupLaunchService.layer.pipe(
    Layer.provideMerge(Layer.merge(ThreadGroupService.layer, launcher)),
    Layer.provideMerge(
      Layer.mergeAll(
        FileSystem.layerNoop({}),
        Layer.mock(GitWorkflow.GitWorkflowService)({}),
        RuntimeLayer.layerEventSink,
        ThreadGroupStore.layer,
        ProjectStore.layer,
        IdAllocator.layer,
        management,
        ServerSettings.layerTest({
          sidebarAutoSettleAfterDays:
            options.autoSettleAfterDays === undefined ? 3 : options.autoSettleAfterDays,
        }),
        Layer.succeed(
          ServerEnvironment.ServerEnvironment,
          ServerEnvironment.ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(environmentId),
            getDescriptor: Effect.die("unused"),
          }),
        ),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
}

const newHarness = (threads: ReadonlyArray<OrchestrationV2ThreadShell>): Harness => ({
  threads: new Map(threads.map((thread) => [thread.id, thread])),
  launches: [],
  settles: [],
});

const seedProject = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  yield* projects.apply(projectCreatedEvent(projectId, 1));
});

const createGroup = (threadIds: ReadonlyArray<ThreadId>, groupId: ThreadGroupId) =>
  Effect.gen(function* () {
    const groups = yield* ThreadGroupService.ThreadGroupService;
    return yield* groups.create({
      commandId: CommandId.make(`command:create:${groupId}`),
      groupId,
      projectId,
      threadIds,
    });
  });

const newThreadInput = (groupId: ThreadGroupId) => ({
  commandId: CommandId.make("command:new-thread"),
  groupId,
  prompt: "Write the migration.",
  modelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  createdBy: "agent" as const,
  creationSource: "mcp" as const,
});

const handoffInput = {
  commandId: CommandId.make("command:handoff"),
  sourceThreadId: source,
  summary: "  Auth is refactored; the migration is left.  ",
  createdBy: "agent" as const,
  creationSource: "mcp" as const,
};

it.effect("newThread launches into the group's worktree with the prompt", () => {
  const harness = newHarness([shell(sibling)]);
  const groupId = ThreadGroupId.make("group:worktree");
  return Effect.gen(function* () {
    yield* seedProject;
    yield* createGroup([sibling], groupId);
    const service = yield* ThreadGroupLaunchService.ThreadGroupLaunchService;

    const result = yield* service.newThread(newThreadInput(groupId));

    const launch = harness.launches[0]!;
    assert.equal(launch.groupId, groupId);
    assert.deepStrictEqual(launch.workspaceStrategy, {
      type: "existing_worktree",
      worktreePath: "/repo-worktrees/auth",
      branch: "feat/auth-refactor",
    });
    assert.equal(launch.initialMessage?.text, "Write the migration.");
    assert.equal(launch.title, "New chat");
    assert.isTrue(launch.generateTitle);
    assert.equal(result.group.id, groupId);
    assert.equal(harness.threads.get(result.threadId)?.groupId, groupId);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("newThread into a group without a worktree launches at the root", () => {
  const harness = newHarness([shell(sibling, { branch: null, worktreePath: null })]);
  const groupId = ThreadGroupId.make("group:root");
  return Effect.gen(function* () {
    yield* seedProject;
    yield* createGroup([sibling], groupId);
    const service = yield* ThreadGroupLaunchService.ThreadGroupLaunchService;

    yield* service.newThread(newThreadInput(groupId));

    assert.deepStrictEqual(harness.launches[0]?.workspaceStrategy, { type: "root" });
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("handoff from an ungrouped chat creates a group and links the two chats", () => {
  const harness = newHarness([shell(source, { title: "Auth refactor" })]);
  return Effect.gen(function* () {
    yield* seedProject;
    const service = yield* ThreadGroupLaunchService.ThreadGroupLaunchService;

    const result = yield* service.handoff(handoffInput);

    assert.isTrue(result.createdGroup);
    assert.equal(result.group.worktreePath, "/repo-worktrees/auth");
    assert.equal(harness.threads.get(source)?.groupId, result.group.id);
    assert.equal(harness.threads.get(result.threadId)?.groupId, result.group.id);
    const launch = harness.launches[0]!;
    // The group is created after the launch, from both chats.
    assert.isUndefined(launch.groupId);
    assert.deepStrictEqual(launch.workspaceStrategy, {
      type: "existing_worktree",
      worktreePath: "/repo-worktrees/auth",
      branch: "feat/auth-refactor",
    });
    assert.equal(launch.title, "Continue: Auth refactor");
    assert.equal(launch.initialMessage?.text, ThreadGroupLaunchService.HANDOFF_DEFAULT_PROMPT);
    assert.deepStrictEqual(launch.initialMessage?.context?.records, [
      {
        version: 1,
        contextId: ComposerContextId.make("handoff"),
        label: "Auth refactor",
        kind: "handoff",
        environmentId,
        threadId: source,
        title: "Auth refactor",
        summary: "Auth is refactored; the migration is left.",
      },
    ]);
    assert.equal(harness.threads.get(result.threadId)?.handedOffFrom, source);
    assert.equal(harness.threads.get(source)?.handedOffTo, result.threadId);
    assert.deepInclude(result.group.lastHandoff, {
      summary: "Auth is refactored; the migration is left.",
      fromThreadId: source,
      toThreadId: result.threadId,
    });
    assert.isTrue(Option.isSome(DateTime.make(result.group.lastHandoff?.at ?? "")));
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("handoff from a grouped chat joins its group", () => {
  const harness = newHarness([shell(source), shell(sibling)]);
  const groupId = ThreadGroupId.make("group:existing");
  return Effect.gen(function* () {
    yield* seedProject;
    yield* createGroup([sibling, source], groupId);
    const service = yield* ThreadGroupLaunchService.ThreadGroupLaunchService;

    const result = yield* service.handoff(handoffInput);

    assert.isFalse(result.createdGroup);
    assert.equal(result.group.id, groupId);
    assert.equal(harness.threads.get(result.threadId)?.groupId, groupId);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("handoff settles the source by default", () => {
  const harness = newHarness([shell(source)]);
  return Effect.gen(function* () {
    yield* seedProject;
    const service = yield* ThreadGroupLaunchService.ThreadGroupLaunchService;

    const result = yield* service.handoff(handoffInput);

    assert.equal(result.sourceSettle, "settled");
    assert.deepStrictEqual(harness.settles, [
      { threadId: source, commandId: CommandId.make("command:handoff:settle") },
    ]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("handoff leaves a source that opted out of auto-settle active", () => {
  const harness = newHarness([
    shell(source, { autoSettleDisabledAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z") }),
  ]);
  return Effect.gen(function* () {
    yield* seedProject;
    const service = yield* ThreadGroupLaunchService.ThreadGroupLaunchService;

    const result = yield* service.handoff(handoffInput);

    assert.equal(result.sourceSettle, "skipped");
    assert.equal(harness.settles.length, 0);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("handoff leaves the source active when auto-settle is off", () => {
  const harness = newHarness([shell(source)]);
  return Effect.gen(function* () {
    yield* seedProject;
    const service = yield* ThreadGroupLaunchService.ThreadGroupLaunchService;

    const result = yield* service.handoff(handoffInput);

    assert.equal(result.sourceSettle, "skipped");
    assert.equal(harness.settles.length, 0);
  }).pipe(Effect.provide(makeLayer(harness, { autoSettleAfterDays: null })));
});

it.effect("handoff from a subagent fails and launches nothing", () => {
  const harness = newHarness([
    shell(source, {
      lineage: { parentThreadId: sibling, relationshipToParent: "subagent", rootThreadId: sibling },
    }),
  ]);
  return Effect.gen(function* () {
    yield* seedProject;
    const service = yield* ThreadGroupLaunchService.ThreadGroupLaunchService;

    const error = yield* service.handoff(handoffInput).pipe(Effect.flip);

    assert.equal(error._tag, "ThreadGroupSubagentError");
    assert.equal(harness.launches.length, 0);
    assert.isNull(harness.threads.get(source)?.groupId);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a retried handoff returns the same chat and keeps the recorded handoff", () => {
  const harness = newHarness([shell(source)]);
  return Effect.gen(function* () {
    yield* seedProject;
    const service = yield* ThreadGroupLaunchService.ThreadGroupLaunchService;

    const first = yield* service.handoff(handoffInput);
    const retried = yield* service.handoff(handoffInput);

    assert.equal(retried.threadId, first.threadId);
    assert.equal(retried.group.id, first.group.id);
    assert.isTrue(retried.createdGroup);
    assert.deepStrictEqual(retried.group.lastHandoff, first.group.lastHandoff);
    assert.deepEqual(
      harness.launches.map((launch) => launch.commandId),
      ["command:handoff:launch", "command:handoff:launch"],
    );
    assert.equal(
      [...harness.threads.values()].filter((thread) => thread.handedOffFrom === source).length,
      1,
    );
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a failed launch leaves the source untouched", () => {
  const harness = newHarness([shell(source)]);
  return Effect.gen(function* () {
    yield* seedProject;
    const service = yield* ThreadGroupLaunchService.ThreadGroupLaunchService;
    const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;

    const error = yield* service.handoff(handoffInput).pipe(Effect.flip);

    assert.equal(error._tag, "ThreadLaunchError");
    assert.deepStrictEqual(harness.threads.get(source), shell(source));
    assert.isTrue(Option.isNone(yield* groups.get(ThreadGroupId.make("command:handoff:group"))));
    assert.equal(harness.settles.length, 0);
  }).pipe(Effect.provide(makeLayer(harness, { failLaunch: true })));
});

it.effect("a handoff that failed after its launch completes on retry with one new chat", () => {
  const harness = newHarness([shell(source)]);
  const launchedId = ThreadId.make("thread-launched-1");
  return Effect.gen(function* () {
    yield* seedProject;
    const service = yield* ThreadGroupLaunchService.ThreadGroupLaunchService;

    yield* service.handoff(handoffInput).pipe(Effect.exit);
    assert.isNull(harness.threads.get(source)?.groupId);
    const result = yield* service.handoff(handoffInput);

    assert.equal(result.threadId, launchedId);
    assert.isTrue(result.createdGroup);
    assert.equal(harness.threads.get(source)?.groupId, result.group.id);
    assert.equal(harness.threads.get(launchedId)?.groupId, result.group.id);
    assert.equal(harness.threads.size, 2);
    assert.equal(harness.threads.get(source)?.handedOffTo, launchedId);
  }).pipe(Effect.provide(makeLayer(harness, { failReadOnce: launchedId })));
});

it.effect("a failed settle still reports the handoff", () => {
  const harness = newHarness([shell(source)]);
  return Effect.gen(function* () {
    yield* seedProject;
    const service = yield* ThreadGroupLaunchService.ThreadGroupLaunchService;

    const result = yield* service.handoff(handoffInput);

    assert.equal(result.sourceSettle, "failed");
    assert.equal(harness.threads.get(source)?.handedOffTo, result.threadId);
    assert.equal(result.group.lastHandoff?.toThreadId, result.threadId);
  }).pipe(Effect.provide(makeLayer(harness, { failSettle: true })));
});

it.effect.each([
  { name: "an empty", summary: "   ", reason: "empty" },
  {
    name: "an oversize",
    summary: "x".repeat(ThreadGroupLaunchService.HANDOFF_SUMMARY_MAX_CHARS + 1),
    reason: "too-long",
  },
] as const)("handoff rejects $name summary before any write", ({ summary, reason }) => {
  const harness = newHarness([shell(source)]);
  return Effect.gen(function* () {
    yield* seedProject;
    const service = yield* ThreadGroupLaunchService.ThreadGroupLaunchService;

    const error = yield* service.handoff({ ...handoffInput, summary }).pipe(Effect.flip);

    assert.equal(error._tag, "ThreadGroupHandoffSummaryError");
    assert.equal(error._tag === "ThreadGroupHandoffSummaryError" && error.reason, reason);
    assert.equal(harness.launches.length, 0);
    assert.deepStrictEqual(harness.threads.get(source), shell(source));
  }).pipe(Effect.provide(makeLayer(harness)));
});
