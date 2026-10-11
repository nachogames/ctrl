import {
  CommandId,
  COMPOSER_CONTEXT_LABEL_MAX_CHARS,
  ComposerContextId,
  type HandoffContextRecord,
  type ModelSelection,
  type OrchestrationThreadGroupShell,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadGroupId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadGroupService from "./ThreadGroupService.ts";
import * as ThreadGroupStore from "./ThreadGroupStore.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export class ThreadGroupLaunchOperationError extends Schema.TaggedError<ThreadGroupLaunchOperationError>()(
  "ThreadGroupLaunchOperationError",
  {
    operation: Schema.Literals(["read-settings", "settle-source"]),
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Handoff from thread ${this.threadId} failed during ${this.operation.replaceAll("-", " ")}.`;
  }
}

export type ThreadGroupLaunchServiceError =
  | ThreadGroupService.ThreadGroupServiceError
  | ThreadLaunch.ThreadLaunchError
  | ThreadGroupLaunchOperationError;

export interface ThreadGroupNewThreadInput {
  readonly commandId: CommandId;
  readonly groupId: ThreadGroupId;
  readonly title?: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly senderThreadId?: ThreadId;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export interface ThreadGroupNewThreadResult {
  readonly group: OrchestrationThreadGroupShell;
  readonly threadId: ThreadId;
}

export interface ThreadGroupHandoffInput {
  readonly commandId: CommandId;
  readonly sourceThreadId: ThreadId;
  readonly summary: string;
  readonly title?: string;
  /** Visible text of the new chat's first message; defaults to a plain continue. */
  readonly prompt?: string;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export interface ThreadGroupHandoffResult {
  readonly group: OrchestrationThreadGroupShell;
  readonly threadId: ThreadId;
  readonly createdGroup: boolean;
  readonly sourceSettle: "settled" | "settles-when-turn-ends" | "skipped";
}

export class ThreadGroupLaunchService extends Context.Service<
  ThreadGroupLaunchService,
  {
    /** Starts a chat in the group, in the group's workspace, with `prompt` as its first message. */
    readonly newThread: (
      input: ThreadGroupNewThreadInput,
    ) => Effect.Effect<ThreadGroupNewThreadResult, ThreadGroupLaunchServiceError>;
    /**
     * Hands a chat off to a new chat in its group, creating the group from the
     * chat's workspace when it has none. Links the two chats, records the
     * group's last handoff, then settles the source unless auto-settle is off
     * for it. Every step commits under an id derived from `commandId`, so a
     * retry replays instead of launching again.
     */
    readonly handoff: (
      input: ThreadGroupHandoffInput,
    ) => Effect.Effect<ThreadGroupHandoffResult, ThreadGroupLaunchServiceError>;
  }
>()("t3/orchestration-v2/ThreadGroupLaunchService") {}

export const HANDOFF_DEFAULT_PROMPT = "Continue from the handoff.";

/** Thread titles have no hard limit; this keeps derived ones as short as a context label. */
const clampTitle = (title: string) => title.trim().slice(0, COMPOSER_CONTEXT_LABEL_MAX_CHARS);

const workspaceOf = (
  group: Pick<OrchestrationThreadGroupShell, "worktreePath" | "branch">,
): ThreadLaunch.ThreadLaunchWorkspaceStrategy =>
  group.worktreePath === null
    ? { type: "root" }
    : {
        type: "existing_worktree",
        worktreePath: group.worktreePath,
        ...(group.branch === null ? {} : { branch: group.branch }),
      };

export const make = Effect.gen(function* () {
  const groupService = yield* ThreadGroupService.ThreadGroupService;
  const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;
  const launcher = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;

  const readGroup = Effect.fn("ThreadGroupLaunchService.readGroup")(function* (
    groupId: ThreadGroupId,
  ) {
    const shell = yield* groups.getShell(groupId).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadGroupService.ThreadGroupOperationError({
            operation: "read-group",
            groupId,
            cause,
          }),
      ),
    );
    if (Option.isNone(shell)) {
      return yield* new ThreadGroupService.ThreadGroupNotFoundError({ groupId });
    }
    return shell.value;
  });

  const readSource = Effect.fn("ThreadGroupLaunchService.readSource")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* threads.getThreadShell(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadGroupService.ThreadGroupOperationError({
            operation: "read-threads",
            threadId,
            cause,
          }),
      ),
    );
    if (shell === null || shell.deletedAt !== null) {
      return yield* new ThreadGroupService.ThreadGroupThreadNotFoundError({ threadId });
    }
    if (shell.lineage.relationshipToParent === "subagent") {
      return yield* new ThreadGroupService.ThreadGroupSubagentError({ threadId });
    }
    return shell;
  });

  const newThread: ThreadGroupLaunchService["Service"]["newThread"] = Effect.fn(
    "ThreadGroupLaunchService.newThread",
  )(function* (input) {
    const group = yield* readGroup(input.groupId);
    const launched = yield* groupService.withGroupLaunch(
      group.id,
      launcher.launch({
        commandId: input.commandId,
        projectId: group.projectId,
        title: input.title ?? "New chat",
        ...(input.title === undefined ? { generateTitle: true } : {}),
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        workspaceStrategy: workspaceOf(group),
        groupId: group.id,
        initialMessage: {
          text: input.prompt,
          attachments: [],
          ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
        },
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      }),
    );
    return { group: yield* readGroup(group.id), threadId: launched.threadId };
  });

  const handoff: ThreadGroupLaunchService["Service"]["handoff"] = Effect.fn(
    "ThreadGroupLaunchService.handoff",
  )(function* (input) {
    const source = yield* readSource(input.sourceThreadId);
    const summary = input.summary.trim();
    // A retry finds the source already in the group its first attempt created.
    const derivedGroupId = ThreadGroupId.make(`${input.commandId}:group`);
    const group =
      source.groupId == null
        ? yield* groupService.create({
            commandId: CommandId.make(`${input.commandId}:group`),
            groupId: derivedGroupId,
            projectId: source.projectId,
            threadIds: [source.id],
          })
        : yield* readGroup(source.groupId);

    const sourceTitle = clampTitle(source.title);
    const record: HandoffContextRecord = {
      version: 1,
      contextId: ComposerContextId.make("handoff"),
      label: sourceTitle,
      kind: "handoff",
      environmentId: yield* environment.getEnvironmentId,
      threadId: source.id,
      title: sourceTitle,
      summary,
    };
    // Launching locks the group, so group writes wait until it has returned.
    const launched = yield* groupService.withGroupLaunch(
      group.id,
      launcher.launch({
        commandId: CommandId.make(`${input.commandId}:launch`),
        projectId: source.projectId,
        title: input.title ?? clampTitle(`Continue: ${source.title}`),
        modelSelection: source.modelSelection,
        runtimeMode: source.runtimeMode,
        interactionMode: source.interactionMode,
        workspaceStrategy: workspaceOf(group),
        groupId: group.id,
        initialMessage: {
          text: input.prompt ?? HANDOFF_DEFAULT_PROMPT,
          attachments: [],
          context: { version: 1, records: [record] },
        },
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      }),
    );
    yield* groupService.setHandoffLinks({
      commandId: input.commandId,
      fromThreadId: source.id,
      toThreadId: launched.threadId,
    });
    const updated = yield* groupService.update({
      commandId: CommandId.make(`${input.commandId}:handoff`),
      groupId: group.id,
      patch: {
        lastHandoff: {
          summary,
          fromThreadId: source.id,
          toThreadId: launched.threadId,
          at: DateTime.formatIso(yield* DateTime.now),
        },
      },
    });

    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ThreadGroupLaunchOperationError({
            operation: "read-settings",
            threadId: source.id,
            cause,
          }),
      ),
    );
    const autoSettleOff =
      source.autoSettleDisabledAt != null ||
      resolveProjectSettings(settings, source.projectId).settings.sidebarAutoSettleAfterDays ===
        null;
    let sourceSettle: ThreadGroupHandoffResult["sourceSettle"] = "skipped";
    if (!autoSettleOff) {
      // The source's own agent usually asks mid-turn; it settles once that turn ends.
      const settled = yield* threads
        .settleThread({
          threadId: source.id,
          commandId: CommandId.make(`${input.commandId}:settle`),
          byOwnAgent: true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ThreadGroupLaunchOperationError({
                operation: "settle-source",
                threadId: source.id,
                cause,
              }),
          ),
        );
      sourceSettle = "settlesWhenTurnEnds" in settled ? "settles-when-turn-ends" : "settled";
    }
    return {
      group: updated,
      threadId: launched.threadId,
      createdGroup: group.id === derivedGroupId,
      sourceSettle,
    };
  });

  return ThreadGroupLaunchService.of({ newThread, handoff });
});

export const layer = Layer.effect(ThreadGroupLaunchService, make);
