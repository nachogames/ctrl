import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadGroupId,
  ThreadId,
  type OrchestrationThreadGroupShell,
  type OrchestrationV2ThreadShell,
  type ThreadGroupManualResource,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ThreadGroupLaunch from "../../../orchestration-v2/ThreadGroupLaunchService.ts";
import * as ThreadGroup from "../../../orchestration-v2/ThreadGroupService.ts";
import * as ThreadGroupStore from "../../../orchestration-v2/ThreadGroupStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as GroupHandlers from "./handlers.ts";
import { GroupToolkit } from "./tools.ts";

const projectId = ProjectId.make("project");
const groupId = ThreadGroupId.make("group:auth");
const callerId = ThreadId.make("caller");
const buildId = ThreadId.make("build");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };

const group: OrchestrationThreadGroupShell = {
  id: groupId,
  projectId,
  title: "Auth refactor",
  goal: null,
  branch: "auth",
  worktreePath: "/work/auth",
  pullRequest: null,
  lastHandoff: null,
  pinnedAt: null,
  snoozedUntil: null,
  settledAt: null,
  manualResources: [],
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
};

const thread = (
  id: ThreadId,
  fields: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell =>
  ({
    id,
    projectId,
    title: id === callerId ? "Plan auth" : "Write auth tests",
    status: "running",
    groupId,
    handedOffFrom: null,
    handedOffTo: null,
    providerInstanceId,
    modelSelection,
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    activeRunId: "active-run",
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    lineage: { relationshipToParent: null },
    createdAt: DateTime.makeUnsafe(id === callerId ? 1 : 2),
    ...fields,
  }) as OrchestrationV2ThreadShell;

interface Recorded {
  readonly created: Array<ThreadGroup.ThreadGroupCreateInput>;
  readonly moved: Array<ThreadGroup.ThreadGroupMoveThreadInput>;
  readonly newThreads: Array<ThreadGroupLaunch.ThreadGroupNewThreadInput>;
  readonly handoffs: Array<ThreadGroupLaunch.ThreadGroupHandoffInput>;
  readonly updates: Array<ThreadGroup.ThreadGroupUpdateInput>;
  readonly settled: Array<{ threadId: ThreadId; commandId: string; byOwnAgent: boolean }>;
}

/** The group toolkit for a caller in or out of the group, against mocked services. */
const makeHarness = (options: {
  readonly callerGroupId: ThreadGroupId | null;
  readonly createError?: ThreadGroup.ThreadGroupServiceError;
  readonly buildFields?: Partial<OrchestrationV2ThreadShell>;
}) =>
  Effect.gen(function* () {
    const caller = thread(callerId, { groupId: options.callerGroupId });
    const shells = new Map([
      [callerId, caller],
      [buildId, thread(buildId, { status: "idle", ...options.buildFields })],
    ]);
    let resources: ReadonlyArray<ThreadGroupManualResource> = [];
    const recorded: Recorded = {
      created: [],
      moved: [],
      newThreads: [],
      handoffs: [],
      updates: [],
      settled: [],
    };
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: { threadId: callerId, providerSessionId: "session", providerInstanceId },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
        listProjectThreads: () =>
          Effect.succeed([...shells.values()].filter((shell) => shell.groupId === groupId)),
        settleThread: (input) => {
          recorded.settled.push(input);
          return Effect.succeed({ sequence: 1 });
        },
        getShellSnapshot: () => Effect.succeed({ archivedThreads: [] } as never),
      }),
      Layer.mock(ThreadGroupStore.ThreadGroupStoreV2)({
        getShell: (id) =>
          Effect.succeed(
            id === groupId ? Option.some({ ...group, manualResources: resources }) : Option.none(),
          ),
      }),
      Layer.mock(ThreadGroup.ThreadGroupService)({
        create: (input) => {
          recorded.created.push(input);
          return options.createError === undefined
            ? Effect.succeed({ ...group, id: input.groupId })
            : Effect.fail(options.createError);
        },
        update: (input) => {
          recorded.updates.push(input);
          return Effect.succeed({
            ...group,
            settledAt: input.patch.settledAt ?? group.settledAt,
          });
        },
        moveThread: (input) => {
          recorded.moved.push(input);
          return Effect.succeed(input.groupId === null ? null : group);
        },
        updateManualResources: (_groupId, _commandId, change) =>
          change(resources).pipe(
            Effect.map((next) => {
              if (next !== null) resources = next;
              return { ...group, manualResources: resources };
            }),
          ),
      }),
      Layer.mock(ThreadGroupLaunch.ThreadGroupLaunchService)({
        newThread: (input) => {
          recorded.newThreads.push(input);
          return Effect.succeed({ group, threadId: buildId });
        },
        handoff: (input) => {
          recorded.handoffs.push(input);
          return Effect.succeed({
            group,
            threadId: buildId,
            createdGroup: false,
            sourceSettle: "settles-when-turn-ends" as const,
          });
        },
      }),
      Layer.mock(Project.ProjectService)({}),
    );
    const toolkit = yield* GroupToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(GroupHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const handle = <Name extends keyof typeof GroupToolkit.tools>(
      name: Name,
      params: Parameters<typeof toolkit.handle<Name>>[1],
    ) =>
      toolkit.handle(name, params).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((parts) => parts.at(-1)?.result),
        Effect.provide(dependencies),
      );
    return { handle, recorded };
  });

it.effect("reads the caller's group by default and names its chats", () =>
  Effect.gen(function* () {
    const { handle } = yield* makeHarness({ callerGroupId: groupId });
    const result = yield* handle("t3_group_read", {});
    expect(result).toMatchObject({
      group: { id: groupId, title: "Auth refactor" },
      chats: [
        { threadId: callerId, isCaller: true, archived: false },
        { threadId: buildId, isCaller: false, status: "idle" },
      ],
      running: { resources: [] },
    });
  }),
);

it.effect("asks for a group when the caller has none", () =>
  Effect.gen(function* () {
    const { handle } = yield* makeHarness({ callerGroupId: null });
    expect(yield* handle("t3_group_read", {})).toMatchObject({ code: "target_required" });
  }),
);

it.effect("creates a group from the caller's chat by default", () =>
  Effect.gen(function* () {
    const { handle, recorded } = yield* makeHarness({ callerGroupId: null });
    const result = yield* handle("t3_group_create", { title: "Auth refactor" });
    expect(recorded.created).toMatchObject([
      { projectId, threadIds: [callerId], title: "Auth refactor" },
    ]);
    expect(recorded.created[0]?.groupId).toMatch(/^group:/);
    expect(result).toMatchObject({ group: { title: "Auth refactor" } });
  }),
);

it.effect("starts a chat in the caller's group with the caller's modes", () =>
  Effect.gen(function* () {
    const { handle, recorded } = yield* makeHarness({ callerGroupId: groupId });
    const result = yield* handle("t3_group_new_thread", { prompt: "Write auth tests" });
    expect(recorded.newThreads).toMatchObject([
      {
        groupId,
        prompt: "Write auth tests",
        modelSelection,
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
        senderThreadId: callerId,
      },
    ]);
    expect(result).toMatchObject({
      group: { title: "Auth refactor" },
      threadId: buildId,
      title: "Write auth tests",
    });

    const escalated = yield* handle("t3_group_new_thread", {
      prompt: "Deploy",
      runtimeMode: "full-access",
    });
    expect(escalated).toMatchObject({ code: "runtime_mode_escalation_denied" });
    expect(recorded.newThreads).toHaveLength(1);
  }),
);

it.effect("hands the caller's chat off with its summary and tells it to stop", () =>
  Effect.gen(function* () {
    const { handle, recorded } = yield* makeHarness({ callerGroupId: groupId });
    const result = yield* handle("t3_group_handoff", { summary: "Plan is done; build it." });
    expect(recorded.handoffs).toMatchObject([
      { sourceThreadId: callerId, summary: "Plan is done; build it." },
    ]);
    expect(result).toMatchObject({
      group: { title: "Auth refactor" },
      threadId: buildId,
      sourceSettle: "settles-when-turn-ends",
    });
    const note = (result as { note: string }).note;
    expect(note).toContain('handed off to "Write auth tests" in Auth refactor');
    expect(note).toContain("Stop working here");
  }),
);

it.effect("detaches a chat with groupId null", () =>
  Effect.gen(function* () {
    const { handle, recorded } = yield* makeHarness({ callerGroupId: groupId });
    const result = yield* handle("t3_group_move_thread", { groupId: null });
    expect(recorded.moved).toMatchObject([{ threadId: callerId, groupId: null }]);
    expect(result).toEqual({ group: null, threadId: callerId });
  }),
);

it.effect("adds and removes a registered resource", () =>
  Effect.gen(function* () {
    const { handle } = yield* makeHarness({ callerGroupId: groupId });
    const added = yield* handle("t3_group_resource", {
      action: "add",
      name: "Dev server",
      url: "http://localhost:5173",
      kind: "server",
    });
    expect(added).toMatchObject({
      group: { title: "Auth refactor" },
      resources: [{ name: "Dev server", url: "http://localhost:5173", kind: "server" }],
    });
    const id = (added as { resources: ReadonlyArray<ThreadGroupManualResource> }).resources[0]!.id;
    expect(id).toMatch(/^res:/);

    const removed = yield* handle("t3_group_resource", { action: "remove", id });
    expect(removed).toMatchObject({ resources: [] });
    // A retried remove finds nothing to remove and still succeeds.
    expect(yield* handle("t3_group_resource", { action: "remove", id })).toMatchObject({
      resources: [],
      removed: false,
    });
  }),
);

it.effect("reports a subagent as an invalid request", () =>
  Effect.gen(function* () {
    const { handle } = yield* makeHarness({
      callerGroupId: null,
      createError: new ThreadGroup.ThreadGroupSubagentError({ threadId: callerId }),
    });
    const result = yield* handle("t3_group_create", {});
    expect(result).toMatchObject({ code: "invalid_request" });
    expect((result as { message: string }).message).toContain("subagent");
  }),
);

it.effect("settling a group settles its unsettled chats, the caller's after its turn", () =>
  Effect.gen(function* () {
    const { handle, recorded } = yield* makeHarness({ callerGroupId: groupId });
    const result = yield* handle("t3_group_update", { settled: true, clientRequestId: "wrap-up" });
    expect(recorded.updates[0]?.patch.settledAt).toEqual(expect.any(String));
    const commandId = recorded.updates[0]!.commandId;
    expect(recorded.settled).toEqual([
      { threadId: callerId, commandId: `${commandId}:settle:${callerId}`, byOwnAgent: true },
      { threadId: buildId, commandId: `${commandId}:settle:${buildId}`, byOwnAgent: false },
    ]);
    expect(result).toMatchObject({ group: { title: "Auth refactor" } });
    expect(yield* handle("t3_group_update", {})).toMatchObject({ code: "invalid_request" });
  }),
);

it.effect("settling a group leaves a chat above the caller's modes as it is", () =>
  Effect.gen(function* () {
    const { handle, recorded } = yield* makeHarness({
      callerGroupId: groupId,
      buildFields: { runtimeMode: "full-access" },
    });
    const result = yield* handle("t3_group_update", { settled: true });
    expect(recorded.settled.map((input) => input.threadId)).toEqual([callerId]);
    expect(result).toMatchObject({ unchangedChats: [{ threadId: buildId }] });
  }),
);

it.effect("refuses to move another chat that runs above the caller's modes", () =>
  Effect.gen(function* () {
    const { handle, recorded } = yield* makeHarness({
      callerGroupId: groupId,
      buildFields: { runtimeMode: "full-access" },
    });
    const result = yield* handle("t3_group_move_thread", { threadId: buildId, groupId: null });
    expect(result).toMatchObject({ code: "runtime_mode_escalation_denied" });
    expect(recorded.moved).toEqual([]);
  }),
);
