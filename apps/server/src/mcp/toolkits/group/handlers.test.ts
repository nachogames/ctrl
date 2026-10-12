import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadGroupId,
  ThreadId,
  type OrchestrationThreadGroupShell,
  type OrchestrationV2ThreadShell,
  type ThreadGroupLink,
  type ThreadGroupManualResource,
  type ThreadGroupRunningResource,
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
import * as GroupResourceScanner from "../../../threadGroups/GroupResourceScanner.ts";
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
  links: [],
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
  readonly callerFields?: Partial<OrchestrationV2ThreadShell>;
  readonly manualResources?: ReadonlyArray<ThreadGroupManualResource>;
  readonly scan?: GroupResourceScanner.GroupResourceScanner["Service"]["scan"];
}) =>
  Effect.gen(function* () {
    const caller = thread(callerId, { groupId: options.callerGroupId, ...options.callerFields });
    const shells = new Map([
      [callerId, caller],
      [buildId, thread(buildId, { status: "idle", ...options.buildFields })],
    ]);
    let resources: ReadonlyArray<ThreadGroupManualResource> = options.manualResources ?? [];
    let links: ReadonlyArray<ThreadGroupLink> = [];
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
            id === groupId
              ? Option.some({ ...group, manualResources: resources, links })
              : Option.none(),
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
              return { ...group, manualResources: resources, links };
            }),
          ),
        updateLinks: (_groupId, _commandId, change) =>
          change(links).pipe(
            Effect.map((next) => {
              if (next !== null) links = next;
              return { ...group, manualResources: resources, links };
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
      Layer.mock(GroupResourceScanner.GroupResourceScanner)({
        scan: options.scan ?? (() => Effect.succeed([])),
      }),
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

it.effect("reads the newest pull request a chat linked when the group has none", () =>
  Effect.gen(function* () {
    const { handle } = yield* makeHarness({
      callerGroupId: groupId,
      buildFields: {
        pullRequests: [
          {
            host: "github.com",
            repository: "t3tools/t3code",
            number: 12,
            url: "https://github.com/t3tools/t3code/pull/12",
            source: "manual",
            linkedAt: "2026-10-10T01:00:00.000Z",
            snapshot: null,
            stack: null,
          },
        ],
      },
    });
    expect(yield* handle("t3_group_read", {})).toMatchObject({
      group: { id: groupId, pullRequest: { number: 12 } },
    });
  }),
);

it.effect("reads what is running for the group from the scanner", () =>
  Effect.gen(function* () {
    const running: ReadonlyArray<ThreadGroupRunningResource> = [
      {
        id: "server:5173",
        kind: "server",
        name: "vite :5173",
        detail: ":5173",
        url: "http://localhost:5173",
        source: "terminal",
        tier: "known",
        terminal: null,
        startedByThreadId: null,
        scriptId: null,
        port: 5173,
      },
    ];
    const scanned: Array<GroupResourceScanner.GroupResourceTarget> = [];
    const { handle } = yield* makeHarness({
      callerGroupId: groupId,
      scan: (target) => {
        scanned.push(target);
        return Effect.succeed(running);
      },
    });
    expect(yield* handle("t3_group_read", {})).toMatchObject({ running: { resources: running } });
    expect(scanned).toEqual([{ groupId }]);
  }),
);

it.effect("falls back to the registered resources when the scan fails", () =>
  Effect.gen(function* () {
    const { handle } = yield* makeHarness({
      callerGroupId: groupId,
      manualResources: [
        { id: "staging", name: "Staging API", kind: "server", url: "https://staging.example.com" },
      ],
      scan: () =>
        Effect.fail(
          new ThreadGroup.ThreadGroupOperationError({
            operation: "read-group",
            groupId,
            cause: new Error("store down"),
          }),
        ),
    });
    expect(yield* handle("t3_group_read", {})).toMatchObject({
      running: {
        resources: [
          {
            id: "manual:staging",
            kind: "manual",
            name: "Staging API",
            url: "https://staging.example.com",
            source: "registered",
          },
        ],
      },
    });
  }),
);

it.effect("reads a chat outside any group as a group of one", () =>
  Effect.gen(function* () {
    const { handle } = yield* makeHarness({ callerGroupId: null });
    expect(yield* handle("t3_group_read", {})).toEqual({ group: null, threadIds: [callerId] });
  }),
);

it.effect("setting a goal on a chat outside any group creates its group", () =>
  Effect.gen(function* () {
    const { handle, recorded } = yield* makeHarness({ callerGroupId: null });
    const result = yield* handle("t3_group_update", { goal: "Ship the auth refactor" });
    expect(recorded.created).toMatchObject([
      { projectId, threadIds: [callerId], goal: "Ship the auth refactor" },
    ]);
    expect(recorded.created[0]?.title).toBeUndefined();
    expect(recorded.created[0]?.groupId).toMatch(/^group:/);
    // The goal is set by the create itself.
    expect(recorded.updates).toEqual([]);
    expect(result).toMatchObject({ group: { id: recorded.created[0]?.groupId } });
  }),
);

it.effect("linking a ticket from a chat outside any group creates its group first", () =>
  Effect.gen(function* () {
    const { handle, recorded } = yield* makeHarness({ callerGroupId: null });
    const result = yield* handle("t3_group_update", {
      links: { add: [{ url: "https://github.com/t3tools/t3code/issues/88" }] },
      pinned: true,
    });
    expect(recorded.created).toMatchObject([{ threadIds: [callerId] }]);
    expect(recorded.created[0]?.goal).toBeUndefined();
    expect(recorded.updates).toMatchObject([
      { groupId: recorded.created[0]?.groupId, patch: { pinnedAt: expect.any(String) } },
    ]);
    expect(result).toMatchObject({ group: { title: "Auth refactor" } });
    expect(
      yield* handle("t3_group_update", { links: { add: [{ url: "not a url" }] } }),
    ).toMatchObject({ code: "invalid_request" });
    expect(recorded.created).toHaveLength(1);
  }),
);

it.effect("pinning or settling a chat outside any group still asks for a group", () =>
  Effect.gen(function* () {
    const { handle, recorded } = yield* makeHarness({ callerGroupId: null });
    expect(yield* handle("t3_group_update", { settled: true })).toMatchObject({
      code: "target_required",
    });
    expect(yield* handle("t3_group_update", { pinned: true, title: "Auth" })).toMatchObject({
      code: "target_required",
    });
    expect(yield* handle("t3_group_update", { goal: null })).toMatchObject({
      code: "target_required",
    });
    expect(recorded.created).toEqual([]);
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

it.effect(
  "groups the caller with the chats it names, the named first chat supplying the workspace",
  () =>
    Effect.gen(function* () {
      const { handle, recorded } = yield* makeHarness({ callerGroupId: null });
      yield* handle("t3_group_create", { threadIds: [buildId] });
      yield* handle("t3_group_create", { threadIds: [callerId, buildId] });
      yield* handle("t3_group_create", { threadIds: [buildId], includeCaller: false });
      expect(recorded.created.map((input) => input.threadIds)).toEqual([
        [buildId, callerId],
        [callerId, buildId],
        [buildId],
      ]);
    }),
);

it.effect("does not add a subagent caller to the chats it names", () =>
  Effect.gen(function* () {
    const { handle, recorded } = yield* makeHarness({
      callerGroupId: null,
      callerFields: {
        lineage: {
          parentThreadId: buildId,
          relationshipToParent: "subagent",
          rootThreadId: buildId,
        },
      },
    });
    yield* handle("t3_group_create", { threadIds: [buildId] });
    expect(recorded.created.map((input) => input.threadIds)).toEqual([[buildId]]);
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

it.effect("links tickets to a group, skips a URL it already links, and removes one", () =>
  Effect.gen(function* () {
    const { handle } = yield* makeHarness({ callerGroupId: groupId });
    const linear = "https://linear.app/acme/issue/ENG-123/fix-login";
    const added = (yield* handle("t3_group_update", {
      links: { add: [{ url: linear }, { url: "https://github.com/t3tools/t3code/issues/88" }] },
    })) as { group: OrchestrationThreadGroupShell };
    expect(added.group.links.map((link) => [link.url, link.label])).toEqual([
      [linear, "ENG-123"],
      ["https://github.com/t3tools/t3code/issues/88", "#88"],
    ]);
    const again = (yield* handle("t3_group_update", {
      links: { add: [{ url: linear, label: "Login bug" }] },
    })) as { group: OrchestrationThreadGroupShell };
    expect(again.group.links).toHaveLength(2);

    const removed = yield* handle("t3_group_update", {
      links: { remove: [added.group.links[0]!.id] },
    });
    expect(removed).toMatchObject({ group: { links: [{ label: "#88" }] } });
    expect(
      yield* handle("t3_group_update", { links: { add: [{ url: "not a url" }] } }),
    ).toMatchObject({ code: "invalid_request" });
    expect(yield* handle("t3_group_read", {})).toMatchObject({
      group: { links: [{ label: "#88" }] },
    });
  }),
);
