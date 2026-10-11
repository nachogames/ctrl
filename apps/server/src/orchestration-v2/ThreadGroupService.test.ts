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

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
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
        ThreadGroupStore.layer,
        ProjectStore.layer,
        IdAllocator.layer,
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
                  ...(command.groupId === undefined ? {} : { groupId: command.groupId }),
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

it.effect("creates a group from its threads with the first thread's workspace", () => {
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
        title: "Chat groups",
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
  for (const link of [{ groupId: null }, { handedOffFrom: b }, { handedOffTo: null }]) {
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
