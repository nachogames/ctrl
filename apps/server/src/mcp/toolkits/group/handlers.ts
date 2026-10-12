import {
  CommandId,
  OrchestratorMcpFailure,
  ThreadGroupId,
  type OrchestrationThreadGroupShell,
  type OrchestrationV2ThreadShell,
  type ThreadGroupLink,
  type ThreadGroupManualResource,
  type ThreadGroupUpdatePayload,
  type ThreadId,
} from "@t3tools/contracts";
import { groupLinkLabel } from "@t3tools/shared/threadGroups";
import { resolveNewestCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { OrchestratorV2Error } from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadGroupLaunch from "../../../orchestration-v2/ThreadGroupLaunchService.ts";
import * as ThreadGroup from "../../../orchestration-v2/ThreadGroupService.ts";
import * as ThreadGroupStore from "../../../orchestration-v2/ThreadGroupStore.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as GroupResourceScanner from "../../../threadGroups/GroupResourceScanner.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { stableCommandId } from "../../OrchestratorMcpService.ts";
import {
  assertTargetWithinLimits,
  type Caller,
  dispatchFailure,
  newCommandId,
  readCaller,
  unavailable,
} from "../../threadAccess.ts";
import { GroupToolkit } from "./tools.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const isOrchestratorError = (cause: unknown): cause is OrchestratorV2Error =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  (cause._tag === "OrchestratorDispatchError" || cause._tag === "OrchestratorCommandRejectedError");

/** Errors the agent can act on keep their message; storage and launch internals do not leak. */
function groupFailure(error: ThreadGroupLaunch.ThreadGroupLaunchServiceError) {
  switch (error._tag) {
    case "ThreadGroupThreadNotFoundError":
      return new OrchestratorMcpFailure({ code: "thread_not_found", message: error.message });
    case "ThreadGroupWorkspaceMismatchError":
      return invalid(
        `${error.message} Pass adoptGroupWorkspace: true to switch it to the group's worktree and branch.`,
      );
    case "ThreadGroupOperationError":
      return isOrchestratorError(error.cause) ? dispatchFailure(error.cause) : unavailable();
    case "ThreadLaunchError":
      return new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: typeof error.cause === "string" ? error.cause : error.message,
      });
    case "ThreadGroupLaunchOperationError":
      return unavailable();
    default:
      return invalid(error.message);
  }
}

/** Fresh per call, or derived from `clientRequestId` so a retry replays. */
const commandIdFor = (operation: string, clientRequestId: string | undefined) =>
  clientRequestId === undefined
    ? newCommandId()
    : McpInvocationContext.McpInvocationContext.pipe(
        Effect.map((scope) =>
          stableCommandId({ scope, requestKey: clientRequestId, operation: `group-${operation}` }),
        ),
      );

/** A random id, or one derived from the command so a retried create replays. */
const newGroupId = (commandId: CommandId, clientRequestId: string | undefined) =>
  clientRequestId === undefined
    ? Crypto.Crypto.pipe(
        Effect.flatMap((crypto) => crypto.randomUUIDv4),
        Effect.orDie,
        Effect.map((uuid) => ThreadGroupId.make(`group:${uuid}`)),
      )
    : Effect.succeed(ThreadGroupId.make(`group:${commandId}`));

/** The group passed, else the one the calling chat is in. */
const resolveGroupId = (context: Caller, groupId: ThreadGroupId | undefined) => {
  if (groupId !== undefined) return Effect.succeed(groupId);
  if (context.caller === undefined)
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "target_required",
        message: "Pass groupId: this MCP client is not running inside a T3 thread.",
      }),
    );
  return context.caller.groupId == null
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "target_required",
          message:
            "Your chat is not in a group. Pass groupId, or group your chat with t3_group_create.",
        }),
      )
    : Effect.succeed(context.caller.groupId);
};

const readGroup = Effect.fn("mcp.group.readGroup")(function* (groupId: ThreadGroupId) {
  const store = yield* ThreadGroupStore.ThreadGroupStoreV2;
  const shell = yield* store.getShell(groupId).pipe(Effect.mapError(unavailable));
  if (Option.isNone(shell)) return yield* invalid(`Thread group ${groupId} was not found.`);
  return shell.value;
});

const isSubagent = (thread: OrchestrationV2ThreadShell) =>
  thread.lineage.relationshipToParent === "subagent";

/**
 * The chats a create groups: the listed ones, then the calling chat unless it is listed, left
 * out, or a subagent (which cannot join a group), so the first listed chat still supplies the
 * workspace. Defaults to the calling chat alone; undefined with neither a list nor a caller.
 */
const groupCreateThreadIds = (
  threadIds: ReadonlyArray<ThreadId> | undefined,
  caller: OrchestrationV2ThreadShell | undefined,
  includeCaller: boolean,
): ReadonlyArray<ThreadId> | undefined => {
  if (threadIds === undefined) return caller === undefined ? undefined : [caller.id];
  if (!includeCaller || caller === undefined || isSubagent(caller) || threadIds.includes(caller.id))
    return threadIds;
  return [...threadIds, caller.id];
};

/** The group's chats, archived ones included, oldest first. */
const readMembers = Effect.fn("mcp.group.readMembers")(function* (
  context: Caller,
  group: OrchestrationThreadGroupShell,
) {
  const active = yield* context.threads
    .listProjectThreads({ projectId: group.projectId, includeSubagents: false })
    .pipe(Effect.mapError(unavailable));
  const archive = yield* context.threads
    .getShellSnapshot({ location: "archive" })
    .pipe(Effect.mapError(unavailable));
  const byId = new Map<ThreadId, OrchestrationV2ThreadShell>();
  for (const thread of [...active, ...archive.archivedThreads]) {
    if (
      thread.groupId === group.id &&
      thread.projectId === group.projectId &&
      thread.deletedAt === null &&
      !isSubagent(thread) &&
      !byId.has(thread.id)
    ) {
      byId.set(thread.id, thread);
    }
  }
  return [...byId.values()].toSorted(
    (left, right) =>
      DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
  );
});

/**
 * Settles or unsettles every live chat of the group that is not already so.
 * A chat running in broader modes than the caller is left as it is, the same
 * rule t3_thread_organize applies to one chat; the orchestrator re-checks it
 * under the chat's lock through the DispatchModeLimit `writesThreads` provides.
 */
const setMembersSettled = Effect.fn("mcp.group.setMembersSettled")(function* (
  context: Caller,
  group: OrchestrationThreadGroupShell,
  commandId: CommandId,
  settled: boolean,
) {
  const active = yield* context.threads
    .listProjectThreads({ projectId: group.projectId, includeSubagents: false })
    .pipe(Effect.mapError(unavailable));
  const pending = active.filter(
    (thread) =>
      thread.groupId === group.id &&
      thread.deletedAt === null &&
      thread.archivedAt === null &&
      !isSubagent(thread) &&
      (thread.settledOverride === "settled") !== settled,
  );
  const unchanged: Array<{ threadId: ThreadId; reason: string }> = [];
  yield* Effect.forEach(
    pending,
    (thread) =>
      assertTargetWithinLimits(context.limits, thread).pipe(
        Effect.andThen(() =>
          settled
            ? context.threads.settleThread({
                threadId: thread.id,
                commandId: CommandId.make(`${commandId}:settle:${thread.id}`),
                byOwnAgent: context.caller?.id === thread.id,
              })
            : context.threads.dispatch({
                type: "thread.unsettle",
                commandId: CommandId.make(`${commandId}:unsettle:${thread.id}`),
                threadId: thread.id,
                reason: "user",
              }),
        ),
        Effect.asVoid,
        Effect.catch((error) =>
          Effect.sync(() => {
            unchanged.push({
              threadId: thread.id,
              reason:
                error._tag === "OrchestratorMcpFailure"
                  ? error.message
                  : dispatchFailure(error).message,
            });
          }),
        ),
      ),
    { concurrency: 1, discard: true },
  );
  return unchanged;
});

/** A new group of just the calling chat, for an update that needs one. */
const createSoloGroup = Effect.fn("mcp.group.createSoloGroup")(function* (
  caller: OrchestrationV2ThreadShell,
  input: {
    readonly title?: string | undefined;
    readonly goal?: string | null | undefined;
    readonly clientRequestId?: string | undefined;
  },
) {
  const commandId = yield* commandIdFor("update-create", input.clientRequestId);
  const groupId = yield* newGroupId(commandId, input.clientRequestId);
  const service = yield* ThreadGroup.ThreadGroupService;
  return yield* service
    .create({
      commandId,
      groupId,
      projectId: caller.projectId,
      threadIds: [caller.id],
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.goal == null ? {} : { goal: input.goal }),
    })
    .pipe(Effect.mapError(groupFailure));
});

const readTitle = (context: Caller, threadId: ThreadId) =>
  context.threads.getThreadShell(threadId).pipe(
    Effect.map((shell) => shell?.title ?? ""),
    Effect.orElseSucceed(() => ""),
  );

const settleNote = (outcome: ThreadGroupLaunch.ThreadGroupHandoffResult["sourceSettle"]) => {
  switch (outcome) {
    case "settled":
      return "This chat is now settled.";
    case "settles-when-turn-ends":
      return "This chat settles when your turn ends.";
    case "skipped":
      return "Auto-settle is off for this chat, so it stays active.";
    case "failed":
      return "Settling this chat failed, so it stays active.";
  }
};

export const layer = McpToolAccess.toLayer(GroupToolkit, {
  t3_group_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      // A chat outside any group is a group of one.
      if (input.groupId === undefined && context.caller != null && context.caller.groupId == null)
        return { group: null, threadIds: [context.caller.id] };
      const group = yield* readGroup(yield* resolveGroupId(context, input.groupId));
      const members = yield* readMembers(context, group);
      const scanner = yield* GroupResourceScanner.GroupResourceScanner;
      // Best effort: when the scan fails, the registered resources still show.
      const resources = yield* scanner.scan({ groupId: group.id }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("group resource scan failed; returning registered resources", {
            groupId: group.id,
            cause: error,
          }).pipe(
            Effect.as(
              GroupResourceScanner.mergeGroupResources({
                servers: [],
                containers: [],
                manual: group.manualResources,
              }),
            ),
          ),
        ),
      );
      return {
        // A group usually forms before its pull request exists; show the newest one a chat linked since.
        group: {
          ...group,
          pullRequest: group.pullRequest ?? resolveNewestCurrentPullRequestLink(members),
        },
        chats: members.map((thread) => ({
          threadId: thread.id,
          title: thread.title,
          status: thread.status,
          isCaller: context.caller?.id === thread.id,
          handedOffFrom: thread.handedOffFrom ?? null,
          handedOffTo: thread.handedOffTo ?? null,
          archived: thread.archivedAt !== null,
        })),
        running: { resources },
      };
    }),
  ),
  t3_group_create: McpToolAccess.writesThreads(
    (input) => input.threadIds ?? [],
    (input) =>
      Effect.gen(function* () {
        const context = yield* readCaller();
        const threadIds = groupCreateThreadIds(
          input.threadIds,
          context.caller,
          input.includeCaller ?? true,
        );
        const firstId = threadIds?.[0];
        if (threadIds === undefined || firstId === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "target_required",
            message: "Pass threadIds: this MCP client is not running inside a T3 thread.",
          });
        const first = yield* context.threads
          .getThreadShell(firstId)
          .pipe(Effect.mapError(unavailable));
        if (first === null || first.deletedAt !== null)
          return yield* new OrchestratorMcpFailure({
            code: "thread_not_found",
            message: `Thread ${firstId} was not found.`,
          });
        const commandId = yield* commandIdFor("create", input.clientRequestId);
        const groupId = yield* newGroupId(commandId, input.clientRequestId);
        const service = yield* ThreadGroup.ThreadGroupService;
        const group = yield* service
          .create({
            commandId,
            groupId,
            projectId: first.projectId,
            threadIds,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.goal === undefined ? {} : { goal: input.goal }),
            ...(input.adoptGroupWorkspace === undefined
              ? {}
              : { adoptGroupWorkspace: input.adoptGroupWorkspace }),
          })
          .pipe(Effect.mapError(groupFailure));
        return { group };
      }),
  ),
  // No thread is named up front; members are checked as they are settled.
  t3_group_update: McpToolAccess.writesThreads(
    () => [],
    (input) =>
      Effect.gen(function* () {
        const context = yield* readCaller();
        const adds = yield* Effect.forEach(input.links?.add ?? [], (entry) => {
          const label = groupLinkLabel(entry.url);
          return label === null
            ? Effect.fail(invalid(`${entry.url} is not an http(s) URL.`))
            : Effect.succeed({ url: entry.url, label: entry.label ?? label });
        });
        const remove = new Set(input.links?.remove ?? []);
        if (input.links !== undefined && adds.length === 0 && remove.size === 0)
          return yield* invalid("Pass links.add or links.remove.");
        // A goal or a ticket on a chat outside any group creates its group first.
        const created =
          input.groupId === undefined &&
          context.caller != null &&
          context.caller.groupId == null &&
          (typeof input.goal === "string" || adds.length > 0)
            ? yield* createSoloGroup(context.caller, input)
            : undefined;
        const groupId = created?.id ?? (yield* resolveGroupId(context, input.groupId));
        const now = DateTime.formatIso(yield* DateTime.now);
        const patch: ThreadGroupUpdatePayload = {
          // The create already set the title and goal of a new group.
          ...(input.title === undefined || created !== undefined ? {} : { title: input.title }),
          ...(input.goal === undefined || created !== undefined ? {} : { goal: input.goal }),
          ...(input.pinned === undefined ? {} : { pinnedAt: input.pinned ? now : null }),
          ...(input.settled === undefined ? {} : { settledAt: input.settled ? now : null }),
        };
        let group: OrchestrationThreadGroupShell | undefined;
        if (input.links !== undefined) {
          const ids = yield* Effect.forEach(adds, () =>
            Crypto.Crypto.pipe(
              Effect.flatMap((crypto) => crypto.randomUUIDv4),
              Effect.orDie,
            ),
          );
          const service = yield* ThreadGroup.ThreadGroupService;
          group = yield* service
            .updateLinks(
              groupId,
              yield* commandIdFor("update-links", input.clientRequestId),
              (current) => {
                const kept = current.filter(
                  (link) => !remove.has(link.id) && !remove.has(link.url),
                );
                const linked = new Set(kept.map((link) => link.url));
                const added: Array<ThreadGroupLink> = [];
                adds.forEach((entry, index) => {
                  if (linked.has(entry.url)) return;
                  linked.add(entry.url);
                  added.push({ id: `link:${ids[index]}`, ...entry });
                });
                // A retried add or a remove of nothing changes nothing.
                return Effect.succeed(
                  added.length === 0 && kept.length === current.length ? null : [...kept, ...added],
                );
              },
            )
            .pipe(Effect.mapError(groupFailure));
        }
        if (Object.keys(patch).length === 0) {
          const changed = group ?? created;
          if (changed !== undefined) return { group: changed };
          return yield* invalid("Pass at least one of title, goal, pinned, settled, or links.");
        }
        const commandId = yield* commandIdFor("update", input.clientRequestId);
        const service = yield* ThreadGroup.ThreadGroupService;
        const updated = yield* service
          .update({ commandId, groupId, patch })
          .pipe(Effect.mapError(groupFailure));
        const unchanged =
          input.settled === undefined
            ? []
            : yield* setMembersSettled(context, updated, commandId, input.settled);
        return {
          group: updated,
          ...(unchanged.length === 0 ? {} : { unchangedChats: unchanged }),
        };
      }),
  ),
  t3_group_new_thread: McpToolAccess.startsThreads(
    (input) => input,
    (input, { runtimeMode, interactionMode }) =>
      Effect.gen(function* () {
        const context = yield* readCaller();
        const group = yield* readGroup(yield* resolveGroupId(context, input.groupId));
        const modelSelection =
          input.modelSelection ??
          context.caller?.modelSelection ??
          (yield* Project.ProjectService.pipe(
            Effect.flatMap((projects) => projects.getById(group.projectId)),
            Effect.mapError(unavailable),
            Effect.map(Option.getOrUndefined),
          ))?.defaultModelSelection ??
          undefined;
        if (modelSelection === undefined)
          return yield* invalid(
            "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
          );
        const launches = yield* ThreadGroupLaunch.ThreadGroupLaunchService;
        const result = yield* launches
          .newThread({
            commandId: yield* commandIdFor("new-thread", input.clientRequestId),
            groupId: group.id,
            prompt: input.prompt,
            ...(input.title === undefined ? {} : { title: input.title }),
            modelSelection,
            runtimeMode,
            interactionMode,
            ...(context.caller === undefined ? {} : { senderThreadId: context.caller.id }),
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.mapError(groupFailure));
        return {
          group: result.group,
          threadId: result.threadId,
          title: yield* readTitle(context, result.threadId),
        };
      }),
  ),
  t3_group_handoff: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      // actsAsCaller has checked for a live calling thread.
      if (context.caller === undefined) return yield* unavailable();
      const launches = yield* ThreadGroupLaunch.ThreadGroupLaunchService;
      const result = yield* launches
        .handoff({
          commandId: yield* commandIdFor("handoff", input.clientRequestId),
          sourceThreadId: context.caller.id,
          summary: input.summary,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(groupFailure));
      const title = yield* readTitle(context, result.threadId);
      return {
        group: result.group,
        threadId: result.threadId,
        title,
        createdGroup: result.createdGroup,
        sourceSettle: result.sourceSettle,
        note: `This chat is handed off to "${title}" in ${result.group.title}. Stop working here; the new chat continues from your summary. ${settleNote(result.sourceSettle)}`,
      };
    }),
  ),
  t3_group_move_thread: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const context = yield* readCaller();
        const threadId = input.threadId ?? context.caller?.id;
        if (threadId === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "target_required",
            message: "Pass threadId: this MCP client is not running inside a T3 thread.",
          });
        const service = yield* ThreadGroup.ThreadGroupService;
        const group = yield* service
          .moveThread({
            commandId: yield* commandIdFor("move-thread", input.clientRequestId),
            threadId,
            groupId: input.groupId,
            ...(input.adoptGroupWorkspace === undefined
              ? {}
              : { adoptGroupWorkspace: input.adoptGroupWorkspace }),
          })
          .pipe(Effect.mapError(groupFailure));
        return { group, threadId };
      }),
  ),
  t3_group_resource: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const groupId = yield* resolveGroupId(context, input.groupId);
      const commandId = yield* commandIdFor("resource", input.clientRequestId);
      let removed: boolean | undefined;
      let change: (
        current: ReadonlyArray<ThreadGroupManualResource>,
      ) => Effect.Effect<ReadonlyArray<ThreadGroupManualResource> | null, OrchestratorMcpFailure>;
      if (input.action === "add") {
        if (input.name === undefined) return yield* invalid('action "add" needs a name.');
        const resource: ThreadGroupManualResource = {
          id:
            input.id ??
            `res:${yield* Crypto.Crypto.pipe(
              Effect.flatMap((crypto) => crypto.randomUUIDv4),
              Effect.orDie,
            )}`,
          name: input.name,
          url: input.url ?? null,
          kind: input.kind ?? "other",
        };
        change = (current) => {
          const existing = current.find((entry) => entry.id === resource.id);
          if (existing === undefined) return Effect.succeed([...current, resource]);
          // A retry of the same add changes nothing.
          return existing.name === resource.name &&
            existing.url === resource.url &&
            existing.kind === resource.kind
            ? Effect.succeed(null)
            : Effect.fail(
                invalid(
                  `The group already has a resource with id ${resource.id}. Remove it first or pick another id.`,
                ),
              );
        };
      } else {
        const id = input.id;
        if (id === undefined) return yield* invalid('action "remove" needs the resource id.');
        // A missing id is already removed, so a retried remove succeeds.
        change = (current) => {
          removed = current.some((entry) => entry.id === id);
          return Effect.succeed(removed ? current.filter((entry) => entry.id !== id) : null);
        };
      }
      const service = yield* ThreadGroup.ThreadGroupService;
      const group = yield* service
        .updateManualResources(groupId, commandId, change)
        .pipe(
          Effect.mapError((error) =>
            error._tag === "OrchestratorMcpFailure" ? error : groupFailure(error),
          ),
        );
      return {
        group,
        resources: group.manualResources,
        ...(removed === undefined ? {} : { removed }),
      };
    }),
  ),
});
