import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadGroupId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

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
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  }) as OrchestrationV2ThreadShell;

function makeLayer(
  threads: Map<ThreadId, OrchestrationV2ThreadShell>,
  dispatched: Array<OrchestrationV2ServerCommand>,
) {
  return ThreadGroupService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
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
                  thread.deletedAt === null,
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
              if (command.type === "thread.metadata.update" && command.groupId !== undefined) {
                const thread = threads.get(command.threadId);
                if (thread !== undefined) {
                  threads.set(command.threadId, { ...thread, groupId: command.groupId });
                }
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
