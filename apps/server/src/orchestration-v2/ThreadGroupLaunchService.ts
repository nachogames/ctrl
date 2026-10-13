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
    operation: Schema.Literals(["read-settings"]),
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Handoff from thread ${this.threadId} failed during ${this.operation.replaceAll("-", " ")}.`;
  }
}

/** Matches the bound of `HandoffContextRecord.summary`. */
export const HANDOFF_SUMMARY_MAX_CHARS = 16_000;

export class ThreadGroupHandoffSummaryError extends Schema.TaggedError<ThreadGroupHandoffSummaryError>()(
  "ThreadGroupHandoffSummaryError",
  { reason: Schema.Literals(["empty", "too-long"]) },
) {
  override get message(): string {
    return this.reason === "empty"
      ? "A handoff needs a summary. Summarize where this chat got to and what is left, then hand off again."
      : `The handoff summary is longer than ${HANDOFF_SUMMARY_MAX_CHARS} characters. Shorten it and hand off again.`;
  }
}

export type ThreadGroupLaunchServiceError =
  | ThreadGroupService.ThreadGroupServiceError
  | ThreadLaunch.ThreadLaunchError
  | ThreadManagement.ThreadManagementProviderInstanceDisabledError
  | ThreadGroupLaunchOperationError
  | ThreadGroupHandoffSummaryError;

export interface ThreadGroupNewThreadInput {
  readonly commandId: CommandId;
  readonly groupId: ThreadGroupId;
  readonly title?: string;
  readonly prompt?: string;
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
  /** "failed" means the handoff happened but settling the source did not; it was logged. */
  readonly sourceSettle: "settled" | "settles-when-turn-ends" | "skipped" | "failed";
}

export class ThreadGroupLaunchService extends Context.Service<
  ThreadGroupLaunchService,
  {
    /** Creates a chat in the group's workspace; starts its first turn when `prompt` is supplied. */
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
        ...(input.prompt === undefined
          ? {}
          : {
              initialMessage: {
                text: input.prompt,
                attachments: [],
                ...(input.senderThreadId === undefined
                  ? {}
                  : { senderThreadId: input.senderThreadId }),
              },
            }),
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      }),
    );
    return { group: yield* readGroup(group.id), threadId: launched.threadId };
  });

  const handoff: ThreadGroupLaunchService["Service"]["handoff"] = Effect.fn(
    "ThreadGroupLaunchService.handoff",
  )(function* (input) {
    const summary = input.summary.trim();
    if (summary === "") return yield* new ThreadGroupHandoffSummaryError({ reason: "empty" });
    if (summary.length > HANDOFF_SUMMARY_MAX_CHARS) {
      return yield* new ThreadGroupHandoffSummaryError({ reason: "too-long" });
    }
    const source = yield* readSource(input.sourceThreadId);
    // Everything that can fail before a write is read up front, so a failed
    // handoff leaves the source as it was.
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
    const environmentId = yield* environment.getEnvironmentId;
    const derivedGroupId = ThreadGroupId.make(`${input.commandId}:group`);
    // A retry finds the source in the group its first attempt created, and
    // replays the same steps.
    const existingGroup =
      source.groupId == null || source.groupId === derivedGroupId
        ? null
        : yield* readGroup(source.groupId);

    const sourceTitle = clampTitle(source.title);
    const record: HandoffContextRecord = {
      version: 1,
      contextId: ComposerContextId.make("handoff"),
      label: sourceTitle,
      kind: "handoff",
      environmentId,
      threadId: source.id,
      title: sourceTitle,
      summary,
    };
    const launchInput: ThreadLaunch.ThreadLaunchInput = {
      commandId: CommandId.make(`${input.commandId}:launch`),
      projectId: source.projectId,
      title: input.title ?? clampTitle(`Continue: ${source.title}`),
      modelSelection: source.modelSelection,
      runtimeMode: source.runtimeMode,
      interactionMode: source.interactionMode,
      workspaceStrategy: workspaceOf(existingGroup ?? source),
      ...(existingGroup === null ? {} : { groupId: existingGroup.id }),
      initialMessage: {
        text: input.prompt ?? HANDOFF_DEFAULT_PROMPT,
        attachments: [],
        context: { version: 1, records: [record] },
      },
      createdBy: input.createdBy,
      creationSource: input.creationSource,
    };
    // An ungrouped source gets its group only once the new chat exists, so a
    // failed launch changes nothing. The source comes first and gives the
    // group its workspace, pull request and title.
    const launched =
      existingGroup === null
        ? yield* launcher.launch(launchInput)
        : yield* groupService.withGroupLaunch(existingGroup.id, launcher.launch(launchInput));
    const group =
      existingGroup ??
      (yield* groupService.create({
        commandId: CommandId.make(`${input.commandId}:group`),
        groupId: derivedGroupId,
        projectId: source.projectId,
        threadIds: [source.id, launched.threadId],
      }));
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

    const autoSettleOff =
      source.autoSettleDisabledAt != null ||
      resolveProjectSettings(settings, source.projectId).settings.sidebarAutoSettleAfterDays ===
        null;
    // The handoff has happened by now, so a settle that fails is reported, not raised.
    const sourceSettle: ThreadGroupHandoffResult["sourceSettle"] = autoSettleOff
      ? "skipped"
      : yield* threads
          .settleThread({
            threadId: source.id,
            commandId: CommandId.make(`${input.commandId}:settle`),
            // The source's own agent usually asks mid-turn; it settles once that turn ends.
            byOwnAgent: true,
          })
          .pipe(
            Effect.map((settled) =>
              "settlesWhenTurnEnds" in settled
                ? ("settles-when-turn-ends" as const)
                : ("settled" as const),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.thread-group.handoff-settle-failed", {
                threadId: source.id,
                cause,
              }).pipe(Effect.as("failed" as const)),
            ),
          );
    return {
      group: updated,
      threadId: launched.threadId,
      createdGroup: existingGroup === null,
      sourceSettle,
    };
  });

  return ThreadGroupLaunchService.of({ newThread, handoff });
});

export const layer = Layer.effect(ThreadGroupLaunchService, make);
