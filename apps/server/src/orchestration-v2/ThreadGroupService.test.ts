import { assert, it } from "@effect/vitest";
import {
  CommandId,
  GitCommandError,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadGroupId,
  type ThreadGroupMutation,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { orderGroupMembers } from "@t3tools/shared/groupOrder";
import * as Stream from "effect/Stream";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadGroupService from "./ThreadGroupService.ts";
import * as ThreadGroupStore from "./ThreadGroupStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { projectCreatedEvent, pullRequestLink } from "./testkit/threadGroupFixtures.ts";

const projectId = ProjectId.make("project:group-service");
const otherProjectId = ProjectId.make("project:group-service:other");
const groupId = ThreadGroupId.make("group:service");
const otherGroupId = ThreadGroupId.make("group:service:other");
const a = ThreadId.make("thread-a");
const b = ThreadId.make("thread-b");
const c = ThreadId.make("thread-c");

const shell = (id: ThreadId, overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  ({
    id,
    projectId,
    title: `Chat ${id}`,
    branch: "feat/auth-refactor",
    worktreePath: "/repo-worktrees/auth",
    groupId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    archivedAt: null,
    deletedAt: null,
    createdAt: DateTime.makeUnsafe("2026-10-10T00:00:00.000Z"),
    ...overrides,
  }) as OrchestrationV2ThreadShell;

const subagentShell = (
  id: ThreadId,
  parentThreadId: ThreadId,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
) =>
  shell(id, {
    lineage: { parentThreadId, relationshipToParent: "subagent", rootThreadId: parentThreadId },
    ...overrides,
  });

interface LayerOptions {
  /** Paths the injected file system reports as present. */
  readonly existingPaths?: ReadonlySet<string>;
  readonly createWorktree?: GitWorkflow.GitWorkflowService["Service"]["createWorktree"];
  readonly pruneWorktrees?: GitWorkflow.GitWorkflowService["Service"]["pruneWorktrees"];
  readonly localStatus?: GitWorkflow.GitWorkflowService["Service"]["localStatus"];
  readonly generateThreadTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
}

function makeLayer(
  threads: Map<ThreadId, OrchestrationV2ThreadShell>,
  dispatched: Array<OrchestrationV2ServerCommand>,
  options: LayerOptions = {},
) {
  return ThreadGroupService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FileSystem.layerNoop({
          exists: (path) => Effect.succeed(options.existingPaths?.has(path) ?? false),
        }),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          createWorktree: options.createWorktree ?? (() => Effect.die("unused")),
          pruneWorktrees: options.pruneWorktrees ?? (() => Effect.void),
          localStatus: options.localStatus ?? (() => Effect.die("unused")),
        }),
        RuntimeLayer.layerEventSink,
        RuntimeLayer.layerEventInfrastructure,
        ThreadGroupStore.layer,
        ProjectStore.layer,
        IdAllocator.layer,
        Layer.mock(TextGeneration.TextGeneration)({
          generateThreadTitle: options.generateThreadTitle ?? (() => Effect.die("unused")),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(threads.get(threadId) ?? null),
          listProjectThreads: (input) =>
            Effect.succeed(
              [...threads.values()].filter(
                (thread) =>
                  thread.projectId === input.projectId &&
                  thread.archivedAt === null &&
                  thread.deletedAt === null &&
                  (input.includeSubagents || thread.lineage.relationshipToParent !== "subagent"),
              ),
            ),
          getShellSnapshot: (options) =>
            Effect.sync(() => {
              const live = [...threads.values()].filter((thread) => thread.deletedAt === null);
              const archived = live.filter((thread) => thread.archivedAt !== null);
              return {
                schemaVersion: 1,
                snapshotSequence: 0,
                threads:
                  options?.location === "archive"
                    ? []
                    : live.filter((thread) => thread.archivedAt === null),
                archivedThreads: options?.location === "archive" ? archived : [],
              };
            }),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              const thread =
                command.type === "thread.metadata.update"
                  ? threads.get(command.threadId)
                  : undefined;
              if (command.type === "thread.metadata.update" && thread !== undefined) {
                threads.set(command.threadId, {
                  ...thread,
                  // Changing the group clears the order key unless the command sets one.
                  ...(command.groupId === undefined
                    ? {}
                    : { groupId: command.groupId, groupOrderKey: null }),
                  ...(command.groupOrderKey === undefined
                    ? {}
                    : { groupOrderKey: command.groupOrderKey }),
                  ...(command.handedOffFrom === undefined
                    ? {}
                    : { handedOffFrom: command.handedOffFrom }),
                  ...(command.handedOffTo === undefined
                    ? {}
                    : { handedOffTo: command.handedOffTo }),
                  ...(command.branch === undefined ? {} : { branch: command.branch }),
                  ...(command.worktreePath === undefined
                    ? {}
                    : { worktreePath: command.worktreePath }),
                });
              }
              return { sequence: dispatched.length, storedEvents: [] };
            }),
        }),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
}

const seedProjects = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  yield* projects.apply(projectCreatedEvent(projectId, 1));
  yield* projects.apply(projectCreatedEvent(otherProjectId, 2));
});

it.effect("creates a group from its threads with the first thread's workspace and title", () => {
  const threads = new Map([
    [a, shell(a, { pullRequests: [pullRequestLink] })],
    [b, shell(b, { branch: "other" })],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    const input = {
      commandId: CommandId.make("command:create"),
      groupId,
      projectId,
      threadIds: [a, b],
    };

    const group = yield* service.create(input);
    assert.deepStrictEqual(
      {
        title: group.title,
        branch: group.branch,
        worktreePath: group.worktreePath,
        pullRequest: group.pullRequest?.number,
      },
      {
        title: "Chat thread-a",
        branch: "feat/auth-refactor",
        worktreePath: "/repo-worktrees/auth",
        pullRequest: 42,
      },
    );
    assert.deepEqual(
      dispatched.map((command) => command.commandId),
      ["command:create:join:thread-a", "command:create:join:thread-b"],
    );

    const retried = yield* service.create(input);
    assert.deepStrictEqual(retried, group);
    assert.equal(dispatched.length, 2);
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("a retried create does not rejoin threads to a group that was pruned", () => {
  const threads = new Map([[a, shell(a)]]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    const input = {
      commandId: CommandId.make("command:pruned"),
      groupId,
      projectId,
      threadIds: [a],
    };
    yield* service.create(input);
    // The thread left (e.g. a crash before the join, then a restart prune removed the group).
    threads.set(a, { ...threads.get(a)!, groupId: null });
    yield* service.pruneEmptyGroups;
    const dispatchCount = dispatched.length;

    const error = yield* service.create(input).pipe(Effect.flip);
    assert.equal(error._tag, "ThreadGroupNotFoundError");
    assert.equal(dispatched.length, dispatchCount);
    assert.isNull(threads.get(a)?.groupId);
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("rejects a thread from another project and commits nothing", () => {
  const threads = new Map([
    [a, shell(a)],
    [c, shell(c, { projectId: otherProjectId })],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;
    const error = yield* service
      .create({ commandId: CommandId.make("command:mixed"), groupId, projectId, threadIds: [a, c] })
      .pipe(Effect.flip);
    assert.equal(error._tag, "ThreadGroupProjectMismatchError");
    assert.isTrue(Option.isNone(yield* groups.get(groupId, { includeDeleted: true })));
    assert.equal(dispatched.length, 0);
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("refuses to move a thread into another project's group", () => {
  const threads = new Map([
    [a, shell(a)],
    [c, shell(c, { projectId: otherProjectId })],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    yield* service.create({
      commandId: CommandId.make("command:other"),
      groupId: otherGroupId,
      projectId: otherProjectId,
      threadIds: [c],
    });
    const error = yield* service
      .moveThread({
        commandId: CommandId.make("command:cross"),
        threadId: a,
        groupId: otherGroupId,
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "ThreadGroupProjectMismatchError");
    assert.isNull(threads.get(a)?.groupId);
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("deletes the old group when its last thread moves out", () => {
  const threads = new Map([
    [a, shell(a)],
    [b, shell(b)],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;
    yield* service.create({
      commandId: CommandId.make("command:pair"),
      groupId,
      projectId,
      threadIds: [a, b],
    });

    assert.isNull(
      yield* service.moveThread({
        commandId: CommandId.make("command:detach-a"),
        threadId: a,
        groupId: null,
      }),
    );
    assert.isTrue(Option.isSome(yield* groups.getShell(groupId)));
    yield* service.moveThread({
      commandId: CommandId.make("command:detach-b"),
      threadId: b,
      groupId: null,
    });
    assert.isTrue(Option.isNone(yield* groups.getShell(groupId)));
    assert.isNotNull(
      Option.getOrThrow(yield* groups.get(groupId, { includeDeleted: true })).deletedAt,
    );
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

const groupWorktree = "/repo-worktrees/auth";
const otherWorkspace = { branch: "feat/other", worktreePath: "/repo-worktrees/other" };

/** A group made from thread a, plus thread c in another worktree. */
const createGroupOfA = Effect.gen(function* () {
  yield* seedProjects;
  const service = yield* ThreadGroupService.ThreadGroupService;
  yield* service.create({
    commandId: CommandId.make("command:group-a"),
    groupId,
    projectId,
    threadIds: [a],
  });
  return service;
});

it.effect("refuses to move a chat from another workspace without adopting the group's", () => {
  const threads = new Map([
    [a, shell(a)],
    [c, shell(c, otherWorkspace)],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    const service = yield* createGroupOfA;
    const before = dispatched.length;
    const error = yield* service
      .moveThread({ commandId: CommandId.make("command:move-c"), threadId: c, groupId })
      .pipe(Effect.flip);
    assert.deepStrictEqual(
      error,
      new ThreadGroupService.ThreadGroupWorkspaceMismatchError({ threadId: c, groupId }),
    );
    assert.equal(dispatched.length, before);
    assert.deepInclude(threads.get(c), { groupId: null, ...otherWorkspace });
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("adopting the group's workspace joins and switches in one update", () => {
  const threads = new Map([
    [a, shell(a)],
    [c, shell(c, otherWorkspace)],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    const service = yield* createGroupOfA;
    const before = dispatched.length;
    const group = yield* service.moveThread({
      commandId: CommandId.make("command:adopt-c"),
      threadId: c,
      groupId,
      adoptGroupWorkspace: true,
    });
    assert.equal(group?.id, groupId);
    assert.deepStrictEqual(dispatched.slice(before), [
      {
        type: "thread.metadata.update",
        commandId: CommandId.make("command:adopt-c:set:thread-c"),
        threadId: c,
        groupId,
        branch: "feat/auth-refactor",
        worktreePath: groupWorktree,
        expectedWorktreePath: otherWorkspace.worktreePath,
      },
    ]);
  }).pipe(
    Effect.provide(makeLayer(threads, dispatched, { existingPaths: new Set([groupWorktree]) })),
  );
});

it.effect("does not adopt a group worktree that is gone from disk", () => {
  const threads = new Map([
    [a, shell(a)],
    [c, shell(c, otherWorkspace)],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    const service = yield* createGroupOfA;
    const before = dispatched.length;
    const error = yield* service
      .moveThread({
        commandId: CommandId.make("command:adopt-missing"),
        threadId: c,
        groupId,
        adoptGroupWorkspace: true,
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "ThreadGroupWorktreeMissingError");
    assert.equal(dispatched.length, before);
    assert.deepInclude(threads.get(c), { groupId: null, ...otherWorkspace });
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("asks to stop a running chat before it adopts the group's workspace", () => {
  const threads = new Map([
    [a, shell(a)],
    [c, shell(c, { ...otherWorkspace, status: "running" })],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    const service = yield* createGroupOfA;
    const before = dispatched.length;
    const error = yield* service
      .moveThread({
        commandId: CommandId.make("command:adopt-running"),
        threadId: c,
        groupId,
        adoptGroupWorkspace: true,
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "ThreadGroupThreadBusyError");
    assert.include(
      ThreadGroupService.threadGroupMutationErrorMessage(
        { type: "thread-group.move-thread" },
        error,
      ),
      "Stop the chat first",
    );
    assert.equal(dispatched.length, before);
    assert.isNull(threads.get(c)?.groupId);
  }).pipe(
    Effect.provide(makeLayer(threads, dispatched, { existingPaths: new Set([groupWorktree]) })),
  );
});

it.effect("a chat without a worktree joins a group without one as is", () => {
  const threads = new Map([
    [a, shell(a, { branch: "main", worktreePath: null })],
    [c, shell(c, { branch: "feat/local", worktreePath: null })],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    const service = yield* createGroupOfA;
    const before = dispatched.length;
    yield* service.moveThread({ commandId: CommandId.make("command:local"), threadId: c, groupId });
    assert.deepStrictEqual(dispatched.slice(before), [
      {
        type: "thread.metadata.update",
        commandId: CommandId.make("command:local:set:thread-c"),
        threadId: c,
        groupId,
      },
    ]);
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("recreating a worktree that exists does nothing", () => {
  const threads = new Map([[a, shell(a)]]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    const service = yield* createGroupOfA;
    const group = yield* service.recreateWorktree(groupId);
    assert.equal(group.worktreePath, groupWorktree);
  }).pipe(
    // createWorktree dies if called.
    Effect.provide(makeLayer(threads, dispatched, { existingPaths: new Set([groupWorktree]) })),
  );
});

it.effect("refuses to move a chat away from a worktree with uncommitted changes", () => {
  const threads = new Map([
    [a, shell(a)],
    [c, shell(c, otherWorkspace)],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    const service = yield* createGroupOfA;
    const before = dispatched.length;
    const error = yield* service
      .moveThread({
        commandId: CommandId.make("command:adopt-dirty"),
        threadId: c,
        groupId,
        adoptGroupWorkspace: true,
      })
      .pipe(Effect.flip);
    assert.deepStrictEqual(
      error,
      new ThreadGroupService.ThreadGroupWorkspaceDirtyError({
        threadId: c,
        worktreePath: otherWorkspace.worktreePath,
      }),
    );
    assert.equal(dispatched.length, before);
    assert.deepInclude(threads.get(c), { groupId: null, ...otherWorkspace });
  }).pipe(
    Effect.provide(
      makeLayer(threads, dispatched, {
        existingPaths: new Set([groupWorktree, otherWorkspace.worktreePath]),
        localStatus: () => Effect.succeed({ hasWorkingTreeChanges: true } as never),
      }),
    ),
  );
});

it.effect("moves a chat away from a clean worktree", () => {
  const threads = new Map([
    [a, shell(a)],
    [c, shell(c, otherWorkspace)],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const statusReads: Array<string> = [];
  return Effect.gen(function* () {
    const service = yield* createGroupOfA;
    yield* service.moveThread({
      commandId: CommandId.make("command:adopt-clean"),
      threadId: c,
      groupId,
      adoptGroupWorkspace: true,
    });
    assert.deepStrictEqual(statusReads, [otherWorkspace.worktreePath]);
    assert.deepInclude(threads.get(c), { groupId, worktreePath: groupWorktree });
  }).pipe(
    Effect.provide(
      makeLayer(threads, dispatched, {
        existingPaths: new Set([groupWorktree, otherWorkspace.worktreePath]),
        localStatus: (input) =>
          Effect.sync(() => {
            statusReads.push(input.cwd);
            return { hasWorkingTreeChanges: false } as never;
          }),
      }),
    ),
  );
});

it.effect("a chat without a worktree adopts the group's without a status read", () => {
  const threads = new Map([
    [a, shell(a)],
    [c, shell(c, { branch: "main", worktreePath: null })],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    const service = yield* createGroupOfA;
    // localStatus dies if called.
    yield* service.moveThread({
      commandId: CommandId.make("command:adopt-local"),
      threadId: c,
      groupId,
      adoptGroupWorkspace: true,
    });
    assert.deepInclude(threads.get(c), { groupId, worktreePath: groupWorktree });
  }).pipe(
    Effect.provide(makeLayer(threads, dispatched, { existingPaths: new Set([groupWorktree]) })),
  );
});

it.effect("an explicit create groups chats on different workspaces, each keeping its own", () => {
  const threads = new Map([
    [a, shell(a)],
    [c, shell(c, otherWorkspace)],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    const group = yield* service.create({
      commandId: CommandId.make("command:create-mixed"),
      groupId,
      projectId,
      threadIds: [a, c],
    });
    assert.equal(group.worktreePath, groupWorktree);
    assert.deepInclude(threads.get(c), { groupId, ...otherWorkspace });
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("a create that adopts moves the other chats onto the first chat's workspace", () => {
  const threads = new Map([
    [a, shell(a)],
    [b, shell(b)],
    [c, shell(c, otherWorkspace)],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    const input = {
      commandId: CommandId.make("command:create-adopt"),
      groupId,
      projectId,
      threadIds: [a, b, c],
      adoptGroupWorkspace: true,
    };
    yield* service.create(input);
    assert.deepStrictEqual(dispatched, [
      {
        type: "thread.metadata.update",
        commandId: CommandId.make("command:create-adopt:join:thread-a"),
        threadId: a,
        groupId,
      },
      {
        type: "thread.metadata.update",
        commandId: CommandId.make("command:create-adopt:join:thread-b"),
        threadId: b,
        groupId,
      },
      {
        type: "thread.metadata.update",
        commandId: CommandId.make("command:create-adopt:join:thread-c"),
        threadId: c,
        groupId,
        branch: "feat/auth-refactor",
        worktreePath: groupWorktree,
        expectedWorktreePath: otherWorkspace.worktreePath,
      },
    ]);
    // A retry finds every chat already in the group and changes nothing.
    yield* service.create(input);
    assert.equal(dispatched.length, 3);
  }).pipe(
    Effect.provide(makeLayer(threads, dispatched, { existingPaths: new Set([groupWorktree]) })),
  );
});

it.effect("a create that adopts fails as a whole when one chat cannot move", () => {
  const threads = new Map([
    [a, shell(a)],
    [c, shell(c, { ...otherWorkspace, status: "running" })],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;
    const error = yield* service
      .create({
        commandId: CommandId.make("command:create-adopt-busy"),
        groupId,
        projectId,
        threadIds: [a, c],
        adoptGroupWorkspace: true,
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "ThreadGroupThreadBusyError");
    assert.deepEqual(dispatched, []);
    assert.isTrue(Option.isNone(yield* groups.getShell(groupId)));
  }).pipe(
    Effect.provide(makeLayer(threads, dispatched, { existingPaths: new Set([groupWorktree]) })),
  );
});

it.effect("recreates a missing worktree on the group's branch from the project root", () => {
  const threads = new Map([[a, shell(a)]]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const calls: Array<unknown> = [];
  return Effect.gen(function* () {
    const service = yield* createGroupOfA;
    const error = yield* service.recreateWorktree(groupId).pipe(Effect.flip);
    assert.deepStrictEqual(calls, [
      { prune: { cwd: `/repo/${projectId}` } },
      { create: { cwd: `/repo/${projectId}`, refName: "feat/auth-refactor", path: groupWorktree } },
    ]);
    assert.equal(error._tag, "ThreadGroupOperationError");
    assert.equal(
      error._tag === "ThreadGroupOperationError" && error.operation,
      "recreate-worktree",
    );
    const message = ThreadGroupService.threadGroupMutationErrorMessage(
      { type: "thread-group.recreate-worktree" },
      error,
    );
    assert.match(message, /^Failed to recreate the group's worktree: .*invalid reference/);
  }).pipe(
    Effect.provide(
      makeLayer(threads, dispatched, {
        pruneWorktrees: (input) => Effect.sync(() => void calls.push({ prune: input })),
        createWorktree: (input) =>
          Effect.suspend(() => {
            calls.push({ create: input });
            return Effect.fail(
              new GitCommandError({
                operation: "createWorktree",
                command: "git worktree add",
                cwd: input.cwd,
                detail: "invalid reference: feat/auth-refactor",
              }),
            );
          }),
      }),
    ),
  );
});

it.effect("a group launch holds the group's lock until the launch finishes", () => {
  const threads = new Map([
    [a, shell(a)],
    [b, shell(b)],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    yield* service.create({
      commandId: CommandId.make("command:lock"),
      groupId,
      projectId,
      threadIds: [a],
    });
    const log = yield* Ref.make<ReadonlyArray<string>>([]);
    const append = (entry: string) => Ref.update(log, (entries) => [...entries, entry]);
    const started = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();

    const launchFiber = yield* service
      .withGroupLaunch(
        groupId,
        Effect.gen(function* () {
          yield* append("launch:start");
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(gate);
          threads.set(b, { ...threads.get(b)!, groupId });
          yield* append("launch:end");
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const deleteFiber = yield* service
      .delete({ commandId: CommandId.make("command:lock:delete"), groupId })
      .pipe(Effect.andThen(append("delete")), Effect.forkChild);
    // Let the delete run as far as it can before the launch is released.
    for (let step = 0; step < 20; step++) yield* Effect.yieldNow;
    yield* append("release");
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(launchFiber);
    yield* Fiber.join(deleteFiber);

    assert.deepEqual(yield* Ref.get(log), ["launch:start", "release", "launch:end", "delete"]);
    // The delete saw the launched thread and detached it with the rest.
    assert.isNull(threads.get(b)?.groupId);
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("a group launch that reuses a thread prunes the group it left", () => {
  const threads = new Map([
    [a, shell(a)],
    [b, shell(b)],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;
    yield* service.create({
      commandId: CommandId.make("command:target"),
      groupId,
      projectId,
      threadIds: [a],
    });
    yield* service.create({
      commandId: CommandId.make("command:previous"),
      groupId: otherGroupId,
      projectId,
      threadIds: [b],
    });

    yield* service.withGroupLaunch(
      groupId,
      Effect.sync(() => threads.set(b, { ...threads.get(b)!, groupId })),
      { reusedThreadId: b },
    );

    assert.isTrue(Option.isSome(yield* groups.getShell(groupId)));
    assert.isTrue(Option.isNone(yield* groups.getShell(otherGroupId)));
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("a reuse launch that moves the thread and then fails still prunes the old group", () => {
  const threads = new Map([
    [a, shell(a)],
    [b, shell(b)],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;
    yield* service.create({
      commandId: CommandId.make("command:failed:target"),
      groupId,
      projectId,
      threadIds: [a],
    });
    yield* service.create({
      commandId: CommandId.make("command:failed:previous"),
      groupId: otherGroupId,
      projectId,
      threadIds: [b],
    });

    const error = yield* service
      .withGroupLaunch(
        groupId,
        Effect.sync(() => threads.set(b, { ...threads.get(b)!, groupId })).pipe(
          Effect.andThen(Effect.fail("dispatch-message failed" as const)),
        ),
        { reusedThreadId: b },
      )
      .pipe(Effect.flip);

    assert.equal(error, "dispatch-message failed");
    assert.isTrue(Option.isNone(yield* groups.getShell(otherGroupId)));
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("moving the parent out prunes a group whose other threads are subagents", () => {
  const liveChild = ThreadId.make("thread-a:subagent");
  const archivedChild = ThreadId.make("thread-a:subagent:archived");
  const threads = new Map([
    [a, shell(a)],
    [liveChild, subagentShell(liveChild, a, { groupId })],
    [
      archivedChild,
      subagentShell(archivedChild, a, {
        groupId,
        archivedAt: DateTime.makeUnsafe("2026-10-10T06:00:00.000Z"),
      }),
    ],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;
    yield* service.create({
      commandId: CommandId.make("command:subagent-group"),
      groupId,
      projectId,
      threadIds: [a],
    });

    yield* service.moveThread({
      commandId: CommandId.make("command:subagent-group:detach"),
      threadId: a,
      groupId: null,
    });
    assert.isTrue(Option.isNone(yield* groups.getShell(groupId)));
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect(
  "updates with absent-vs-null semantics, ungroups members and replays a retried delete",
  () => {
    const threads = new Map([
      [a, shell(a)],
      [b, shell(b)],
    ]);
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    return Effect.gen(function* () {
      yield* seedProjects;
      const service = yield* ThreadGroupService.ThreadGroupService;
      const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;
      yield* service.create({
        commandId: CommandId.make("command:ungroup:create"),
        groupId,
        projectId,
        threadIds: [a, b],
      });
      yield* service.update({
        commandId: CommandId.make("command:goal"),
        groupId,
        patch: { goal: "Ship it." },
      });
      const updated = yield* service.update({
        commandId: CommandId.make("command:rename"),
        groupId,
        patch: { goal: null, title: "Renamed" },
      });
      assert.deepStrictEqual(
        { title: updated.title, goal: updated.goal, branch: updated.branch },
        { title: "Renamed", goal: null, branch: "feat/auth-refactor" },
      );

      const remove = { commandId: CommandId.make("command:ungroup"), groupId };
      yield* service.delete(remove);
      assert.deepEqual(
        dispatched.slice(-2).map((command) => command.commandId),
        ["command:ungroup:leave:thread-a", "command:ungroup:leave:thread-b"],
      );
      assert.isNull(threads.get(a)?.groupId);
      assert.isTrue(Option.isNone(yield* groups.getShell(groupId)));
      const dispatchCount = dispatched.length;
      yield* service.delete(remove);
      assert.equal(dispatched.length, dispatchCount);
      const otherCommand = yield* service
        .delete({ commandId: CommandId.make("command:ungroup:again"), groupId })
        .pipe(Effect.flip);
      assert.equal(otherCommand._tag, "ThreadGroupNotFoundError");
    }).pipe(Effect.provide(makeLayer(threads, dispatched)));
  },
);

it.effect("keeps a group whose only threads are archived", () => {
  const threads = new Map([[a, shell(a)]]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;
    yield* service.create({
      commandId: CommandId.make("command:archived"),
      groupId,
      projectId,
      threadIds: [a],
    });
    threads.set(a, {
      ...threads.get(a)!,
      archivedAt: DateTime.makeUnsafe("2026-10-10T06:00:00.000Z"),
    });

    yield* service.pruneEmptyGroups;
    assert.isTrue(Option.isSome(yield* groups.getShell(groupId)));
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("prunes only groups without live threads", () => {
  const threads = new Map([
    [a, shell(a)],
    [b, shell(b)],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;
    yield* service.create({
      commandId: CommandId.make("command:keep"),
      groupId,
      projectId,
      threadIds: [a],
    });
    yield* service.create({
      commandId: CommandId.make("command:lose"),
      groupId: otherGroupId,
      projectId,
      threadIds: [b],
    });
    threads.set(b, {
      ...threads.get(b)!,
      deletedAt: DateTime.makeUnsafe("2026-10-10T06:00:00.000Z"),
    });

    yield* service.pruneEmptyGroups;
    assert.isTrue(Option.isSome(yield* groups.getShell(groupId)));
    assert.isTrue(Option.isNone(yield* groups.getShell(otherGroupId)));
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it("only thread group commands change membership", () => {
  const base = { commandId: CommandId.make("command:guard"), threadId: a };
  const create = {
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    ...base,
    projectId,
    title: "Chat",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  } as OrchestrationV2Command;
  assert.isFalse(ThreadGroupService.clientCommandChangesGroupMembership(create));
  assert.isTrue(
    ThreadGroupService.clientCommandChangesGroupMembership({
      ...create,
      groupId,
    } as OrchestrationV2Command),
  );
  assert.isFalse(
    ThreadGroupService.clientCommandChangesGroupMembership({
      type: "thread.metadata.update",
      ...base,
      title: "Renamed",
    }),
  );
  for (const link of [
    { groupId: null },
    { groupOrderKey: "a0" },
    { handedOffFrom: b },
    { handedOffTo: null },
  ]) {
    assert.isTrue(
      ThreadGroupService.clientCommandChangesGroupMembership({
        type: "thread.metadata.update",
        ...base,
        ...link,
      }),
    );
  }
});

it.effect("runs client mutations and reports no group after a delete", () => {
  const threads = new Map([[a, shell(a)]]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    const created = yield* ThreadGroupService.mutateThreadGroup(service, {
      type: "thread-group.create",
      commandId: CommandId.make("command:rpc:create"),
      groupId,
      projectId,
      threadIds: [a],
      title: "From the client",
    });
    assert.equal(created.group?.title, "From the client");
    const deleted = yield* ThreadGroupService.mutateThreadGroup(service, {
      type: "thread-group.delete",
      commandId: CommandId.make("command:rpc:delete"),
      groupId,
    });
    assert.isNull(deleted.group);
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

const subagent = (id: ThreadId) =>
  shell(id, { lineage: { ...shell(id).lineage, relationshipToParent: "subagent" } });

it.effect("rejects a subagent at create and commits no group", () => {
  const threads = new Map([
    [a, shell(a)],
    [b, subagent(b)],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;
    const error = yield* service
      .create({ commandId: CommandId.make("command:sub"), groupId, projectId, threadIds: [a, b] })
      .pipe(Effect.flip);
    assert.equal(error._tag, "ThreadGroupSubagentError");
    assert.isTrue(Option.isNone(yield* groups.getShell(groupId)));
    assert.equal(dispatched.length, 0);
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("rejects moving a subagent into a group or detaching it", () => {
  const threads = new Map([
    [a, shell(a)],
    [b, subagent(b)],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    yield* service.create({
      commandId: CommandId.make("command:sub:create"),
      groupId,
      projectId,
      threadIds: [a],
    });
    const into = yield* service
      .moveThread({ commandId: CommandId.make("command:sub:into"), threadId: b, groupId })
      .pipe(Effect.flip);
    assert.equal(into._tag, "ThreadGroupSubagentError");
    const out = yield* service
      .moveThread({ commandId: CommandId.make("command:sub:out"), threadId: b, groupId: null })
      .pipe(Effect.flip);
    assert.equal(out._tag, "ThreadGroupSubagentError");
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

const create = { type: "thread-group.create" } as const;
const operationError = (cause: unknown) =>
  new ThreadGroupService.ThreadGroupOperationError({ operation: "update-thread", cause });

it("passes user-facing service errors through as the mutation message", () => {
  const errors = [
    new ThreadGroupService.ThreadGroupNotFoundError({ groupId }),
    new ThreadGroupService.ThreadGroupThreadNotFoundError({ threadId: a }),
    new ThreadGroupService.ThreadGroupProjectMismatchError({
      threadId: a,
      threadProjectId: projectId,
      groupProjectId: otherProjectId,
    }),
    new ThreadGroupService.ThreadGroupSubagentError({ threadId: a }),
    new ThreadGroupService.ThreadGroupWorkspaceMismatchError({ threadId: a, groupId }),
    new ThreadGroupService.ThreadGroupThreadBusyError({ threadId: a }),
    new ThreadGroupService.ThreadGroupWorkspaceDirtyError({ threadId: a, worktreePath: "/wt" }),
    new ThreadGroupService.ThreadGroupWorktreeMissingError({
      groupId,
      worktreePath: "/repo-worktrees/auth",
    }),
  ];
  for (const error of errors) {
    assert.equal(ThreadGroupService.threadGroupMutationErrorMessage(create, error), error.message);
  }
  assert.deepStrictEqual(errors.map(ThreadGroupService.threadGroupMutationFailureReason), [
    "group-not-found",
    "thread-not-found",
    "project-mismatch",
    "subagent",
    "workspace-mismatch",
    "thread-busy",
    "workspace-dirty",
    "worktree-missing",
  ]);
  assert.isUndefined(
    ThreadGroupService.threadGroupMutationFailureReason(operationError(new Error("disk full"))),
  );
});

it("names the attempted mutation and the cause for operation failures", () => {
  const message = (type: ThreadGroupMutation["type"], cause?: unknown) =>
    ThreadGroupService.threadGroupMutationErrorMessage({ type }, operationError(cause));
  assert.equal(
    message("thread-group.create", new Error("disk full")),
    "Failed to create the thread group: disk full",
  );
  assert.equal(
    message("thread-group.update", "locked"),
    "Failed to update the thread group: locked",
  );
  assert.equal(
    message("thread-group.delete", new ThreadGroupService.ThreadGroupNotFoundError({ groupId })),
    `Failed to ungroup the thread group: Thread group ${groupId} was not found.`,
  );
  assert.equal(message("thread-group.move-thread", 42), "Failed to move the thread.");
  assert.equal(message("thread-group.move-thread"), "Failed to move the thread.");
});

it.effect("two concurrent resource changes both land", () => {
  const threads = new Map([[a, shell(a)]]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    yield* service.create({
      commandId: CommandId.make("command:res"),
      groupId,
      projectId,
      threadIds: [a],
    });
    const add = (id: string) =>
      service.updateManualResources(groupId, CommandId.make(`command:res:${id}`), (current) =>
        // Yield mid-change, so an unlocked read-modify-write would drop one add.
        Effect.yieldNow.pipe(
          Effect.as([...current, { id, name: id, url: null, kind: "server" as const }]),
        ),
      );
    yield* Effect.all([add("web"), add("api")], { concurrency: "unbounded" });
    const group = yield* service.updateManualResources(
      groupId,
      CommandId.make("command:res:none"),
      () => Effect.succeed(null),
    );
    assert.deepEqual(group.manualResources.map((resource) => resource.id).toSorted(), [
      "api",
      "web",
    ]);
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("two concurrent link changes both land", () => {
  const threads = new Map([[a, shell(a)]]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    yield* service.create({
      commandId: CommandId.make("command:links"),
      groupId,
      projectId,
      threadIds: [a],
    });
    const add = (id: string) =>
      service.updateLinks(groupId, CommandId.make(`command:links:${id}`), (current) =>
        // Yield mid-change, so an unlocked read-modify-write would drop one add.
        Effect.yieldNow.pipe(
          Effect.as([...current, { id, url: `https://linear.app/acme/issue/${id}`, label: id }]),
        ),
      );
    yield* Effect.all([add("ENG-1"), add("ENG-2")], { concurrency: "unbounded" });
    const group = yield* service.updateLinks(groupId, CommandId.make("command:links:none"), () =>
      Effect.succeed(null),
    );
    assert.deepEqual(group.links.map((link) => link.id).toSorted(), ["ENG-1", "ENG-2"]);
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("a client resource remove drops only its id, and a missing id is a no-op", () => {
  const threads = new Map([[a, shell(a)]]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    yield* service.create({
      commandId: CommandId.make("command:rm"),
      groupId,
      projectId,
      threadIds: [a],
    });
    yield* service.updateManualResources(groupId, CommandId.make("command:rm:seed"), () =>
      Effect.succeed(
        ["web", "api", "db"].map((id) => ({ id, name: id, url: null, kind: "server" as const })),
      ),
    );
    const remove = (commandId: string, resourceId: string) =>
      ThreadGroupService.mutateThreadGroup(service, {
        type: "thread-group.remove-resource",
        commandId: CommandId.make(commandId),
        groupId,
        resourceId,
      });
    // Two removes sent from the same stale view both land.
    yield* Effect.all([remove("command:rm:web", "web"), remove("command:rm:api", "api")], {
      concurrency: "unbounded",
    });
    const missing = yield* remove("command:rm:gone", "gone");
    assert.deepEqual(
      missing.group?.manualResources.map((resource) => resource.id),
      ["db"],
    );
    // A retried remove replays.
    const retried = yield* remove("command:rm:web", "web");
    assert.deepEqual(
      retried.group?.manualResources.map((resource) => resource.id),
      ["db"],
    );
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("a create with a goal names the group from the goal once generated", () => {
  const threads = new Map([[a, shell(a)]]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const prompts: Array<string> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const afterSequence = yield* events.latestApplicationSequence;
    const renamed = yield* events.streamApplicationEvents({ afterSequence }).pipe(
      Stream.filter((stored) => "type" in stored && stored.type === "thread-group.meta-updated"),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkChild,
    );

    const group = yield* service.create({
      commandId: CommandId.make("command:goal-create"),
      groupId,
      projectId,
      threadIds: [a],
      goal: "Ship passkey login",
    });
    assert.equal(group.title, "Chat thread-a");
    yield* Fiber.join(renamed);

    assert.deepEqual(prompts, ["Ship passkey login"]);
    const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;
    assert.equal(Option.getOrThrow(yield* groups.getShell(groupId)).title, "Passkey login");
  }).pipe(
    Effect.provide(
      makeLayer(threads, dispatched, {
        generateThreadTitle: (input) =>
          Effect.sync(() => {
            prompts.push(input.message);
            return { title: "  Passkey login " };
          }),
      }),
    ),
  );
});

it.effect("a failed goal title leaves the chat title", () => {
  const threads = new Map([[a, shell(a)]]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const attempted = Deferred.makeUnsafe<void>();
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    const group = yield* service.create({
      commandId: CommandId.make("command:goal-fail"),
      groupId,
      projectId,
      threadIds: [a],
      goal: "Ship passkey login",
    });
    assert.equal(group.title, "Chat thread-a");
    yield* Deferred.await(attempted);
    const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;
    assert.equal(Option.getOrThrow(yield* groups.getShell(groupId)).title, "Chat thread-a");
  }).pipe(
    Effect.provide(
      makeLayer(threads, dispatched, {
        generateThreadTitle: () =>
          Deferred.succeed(attempted, undefined).pipe(Effect.andThen(Effect.die("offline"))),
      }),
    ),
  );
});

it.effect("a chat joining a keyed group lands first", () => {
  const threads = new Map([
    [a, shell(a)],
    [b, shell(b)],
    [c, shell(c)],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    yield* service.create({
      commandId: CommandId.make("command:keyed"),
      groupId,
      projectId,
      threadIds: [a, b],
    });
    threads.set(a, { ...threads.get(a)!, groupOrderKey: "m" });
    threads.set(b, { ...threads.get(b)!, groupOrderKey: "t" });

    yield* service.moveThread({ commandId: CommandId.make("command:join"), threadId: c, groupId });

    const join = dispatched.at(-1);
    assert.equal(join?.type === "thread.metadata.update" && join.groupId, groupId);
    // A keyless chat would also show first; the key keeps it there after the next reorder.
    assert.isString(threads.get(c)?.groupOrderKey);
    assert.deepEqual(displayOrder(threads), [c, a, b]);
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("a chat joining an unordered group stays keyless", () => {
  const threads = new Map([
    [a, shell(a)],
    [c, shell(c)],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    const service = yield* createGroupOfA;
    yield* service.moveThread({ commandId: CommandId.make("command:join"), threadId: c, groupId });
    assert.isNull(threads.get(c)?.groupOrderKey);
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

const successor = ThreadId.make("thread-successor");

/** The group's members, in the order the clients show them. */
const displayOrder = (threads: Map<ThreadId, OrchestrationV2ThreadShell>) =>
  orderGroupMembers(
    [...threads.values()]
      .filter((thread) => thread.groupId === groupId)
      .map((thread) => ({
        id: thread.id,
        createdAtMs: DateTime.toEpochMillis(thread.createdAt),
        handedOffFrom: thread.handedOffFrom,
        groupOrderKey: thread.groupOrderKey,
      })),
  );

/** A group of a, b and c with the given keys, plus a new successor chat in it. */
const handoffGroup = (keys: Partial<Record<ThreadId, string>>) => {
  const at = (minute: number) => DateTime.makeUnsafe(`2026-10-10T00:0${minute}:00.000Z`);
  return new Map(
    [
      shell(a, { createdAt: at(1) }),
      shell(b, { createdAt: at(2) }),
      shell(c, { createdAt: at(3) }),
      shell(successor, { createdAt: at(4) }),
    ].map((thread) => [thread.id, { ...thread, groupId, groupOrderKey: keys[thread.id] ?? null }]),
  );
};

const handOff = (from: ThreadId) =>
  Effect.gen(function* () {
    const service = yield* createGroupOfA;
    yield* service.setHandoffLinks({
      commandId: CommandId.make("command:handoff"),
      fromThreadId: from,
      toThreadId: successor,
    });
  });

it.effect("a handoff in a keyed group lands directly above its source", () => {
  const threads = handoffGroup({ [a]: "d", [b]: "m", [c]: "t" });
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* handOff(b);
    assert.deepEqual(displayOrder(threads), [a, successor, b, c]);
    assert.equal(threads.get(successor)?.handedOffFrom, b);
    assert.equal(threads.get(b)?.handedOffTo, successor);
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("a handoff from the first chat of a keyed group lands first", () => {
  const threads = handoffGroup({ [a]: "d", [b]: "m", [c]: "t" });
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* handOff(a);
    assert.deepEqual(displayOrder(threads), [successor, a, b, c]);
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("a handoff in a partly keyed group materializes keys around its source", () => {
  const threads = handoffGroup({ [a]: "m" });
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* handOff(b);
    assert.deepEqual(displayOrder(threads), [successor, b, c, a]);
    for (const id of [a, b, c, successor]) assert.isString(threads.get(id)?.groupOrderKey);
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("a handoff over corrupt keys still lands above its source", () => {
  const threads = handoffGroup({ [a]: "Q!", [b]: "zz", [c]: "zzz" });
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* handOff(b);
    assert.deepEqual(displayOrder(threads), [a, successor, b, c]);
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("a handoff in an unordered group writes no keys", () => {
  const threads = handoffGroup({});
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* handOff(b);
    assert.isNull(threads.get(successor)?.groupOrderKey);
    assert.deepEqual(displayOrder(threads), [successor, b, c, a]);
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});

it.effect("archiving a group down to one live chat clears its pin, snooze and settle", () => {
  const threads = new Map([
    [a, shell(a)],
    [b, shell(b)],
  ]);
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* ThreadGroupService.ThreadGroupService;
    const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;
    yield* service.create({
      commandId: CommandId.make("command:solo"),
      groupId,
      projectId,
      threadIds: [a, b],
    });
    const state = {
      pinnedAt: "2026-10-10T01:00:00.000Z",
      snoozedUntil: "2026-10-11T01:00:00.000Z",
      settledAt: "2026-10-10T02:00:00.000Z",
    };
    yield* service.update({ commandId: CommandId.make("command:solo:pin"), groupId, patch: state });

    // Two live chats keep the group's state.
    yield* service.pruneIfEmpty(groupId);
    assert.deepInclude(Option.getOrThrow(yield* groups.getShell(groupId)), state);

    threads.set(b, {
      ...threads.get(b)!,
      archivedAt: DateTime.makeUnsafe("2026-10-10T06:00:00.000Z"),
    });
    yield* service.pruneIfEmpty(groupId);
    assert.deepInclude(Option.getOrThrow(yield* groups.getShell(groupId)), {
      pinnedAt: null,
      snoozedUntil: null,
      settledAt: null,
    });
  }).pipe(Effect.provide(makeLayer(threads, dispatched)));
});
