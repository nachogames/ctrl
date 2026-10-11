import {
  ModelSelection,
  OrchestrationThreadGroupShell,
  OrchestrationV2ShellThreadStatus,
  OrchestratorMcpFailure,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadGroupId,
  ThreadGroupManualResource,
  ThreadGroupManualResourceKind,
  ThreadGroupRunningResource,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadGroupLaunchService from "../../../orchestration-v2/ThreadGroupLaunchService.ts";
import * as ThreadGroupService from "../../../orchestration-v2/ThreadGroupService.ts";
import * as ThreadGroupStore from "../../../orchestration-v2/ThreadGroupStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as GroupResourceScanner from "../../../threadGroups/GroupResourceScanner.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const groupTool = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadGroupService.ThreadGroupService,
    ThreadGroupStore.ThreadGroupStoreV2,
    Crypto.Crypto,
  ],
};

const groupIdParameter = Schema.optional(ThreadGroupId).annotate({
  description: "The group. Omit it for the group your own chat is in.",
});
const clientRequestId = Schema.optional(
  TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
).annotate({
  description:
    "Idempotency key. Reuse it when retrying a call whose result was lost, so the change happens once.",
});

const GroupResult = Schema.Struct({ group: OrchestrationThreadGroupShell });

const GroupChat = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  status: OrchestrationV2ShellThreadStatus,
  isCaller: Schema.Boolean,
  handedOffFrom: Schema.NullOr(ThreadId),
  handedOffTo: Schema.NullOr(ThreadId),
  archived: Schema.Boolean,
});

const GroupReadTool = Tool.make("t3_group_read", {
  ...groupTool,
  dependencies: [...groupTool.dependencies, GroupResourceScanner.GroupResourceScanner],
  description:
    'Read a chat group: its title, goal, branch, worktree, pull request, last handoff, its chats (oldest first, with handoff links and which one is you), and what is running for it right now: local servers started by its chats or from its worktree, its worktree\'s docker compose containers, and resources registered by hand (source "registered", never health-checked). Omit groupId to read the group your chat is in. Chats in one group share a project and a workspace and work toward one goal.',
  parameters: Schema.Struct({ groupId: groupIdParameter }),
  success: Schema.Struct({
    group: OrchestrationThreadGroupShell,
    chats: Schema.Array(GroupChat),
    running: Schema.Struct({ resources: Schema.Array(ThreadGroupRunningResource) }),
  }),
})
  .annotate(Tool.Title, "Read a chat group")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const GroupCreateTool = Tool.make("t3_group_create", {
  ...groupTool,
  description:
    "Group chats that work toward one goal, for example a planning chat and the build chat it launched. threadIds defaults to just your own chat; list your chat first and then the others to group them together. The first chat supplies the group's branch, worktree, pull request and default title, and the group belongs to that chat's project; every chat must be in that project. A chat already in another group moves to this one. Use t3_group_move_thread to add a chat to an existing group.",
  parameters: Schema.Struct({
    threadIds: Schema.optional(Schema.Array(ThreadId).check(Schema.isMinLength(1))).annotate({
      description: "Chats to group, first one supplying the workspace. Defaults to [your chat].",
    }),
    title: Schema.optional(TrimmedNonEmptyString).annotate({
      description:
        "Group title. Defaults to the first chat's pull request, branch, or title, in that order.",
    }),
    goal: Schema.optional(TrimmedNonEmptyString).annotate({
      description: "One or two sentences on what the group is working toward.",
    }),
    clientRequestId,
  }),
  success: GroupResult,
})
  .annotate(Tool.Title, "Create a chat group")
  .annotate(Tool.Destructive, false);

const GroupUpdateTool = Tool.make("t3_group_update", {
  ...groupTool,
  description:
    "Rename a chat group, set or clear its goal (goal: null clears it), pin or unpin it, or settle or unsettle it. Omit groupId for the group your chat is in. Omitted fields stay as they are. settled: true settles the group and every chat in it that is not settled yet (your own chat settles when your turn ends; a chat that is running, waiting on a question, or running in broader modes than yours stays as it is and is listed in unchangedChats). settled: false unsettles the group and its settled chats.",
  parameters: Schema.Struct({
    groupId: groupIdParameter,
    title: Schema.optional(TrimmedNonEmptyString),
    goal: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    pinned: Schema.optional(Schema.Boolean),
    settled: Schema.optional(Schema.Boolean),
    clientRequestId,
  }),
  success: Schema.Struct({
    group: OrchestrationThreadGroupShell,
    unchangedChats: Schema.optional(
      Schema.Array(Schema.Struct({ threadId: ThreadId, reason: Schema.String })),
    ),
  }),
})
  .annotate(Tool.Title, "Update a chat group")
  .annotate(Tool.Destructive, false);

const GroupNewThreadTool = Tool.make("t3_group_new_thread", {
  ...groupTool,
  description:
    "Start a new chat in a group, in the group's worktree and branch (the project root when the group has no worktree), with prompt as its first message. Omit groupId for the group your chat is in. The model and runtime and interaction modes default to your own chat's; the new chat may not run with broader modes than yours. Omit title to have one generated from the prompt. Returns the new chat's threadId; follow it with t3_thread_read or t3_thread_wait.",
  parameters: Schema.Struct({
    groupId: groupIdParameter,
    prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
      description: "The new chat's first message: the whole task.",
    }),
    title: Schema.optional(TrimmedNonEmptyString),
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    clientRequestId,
  }),
  success: Schema.Struct({
    group: OrchestrationThreadGroupShell,
    threadId: ThreadId,
    title: Schema.String,
  }),
  dependencies: [
    ...groupTool.dependencies,
    ThreadGroupLaunchService.ThreadGroupLaunchService,
    ProjectService.ProjectService,
  ],
})
  .annotate(Tool.Title, "Start a chat in a group")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const GroupHandoffTool = Tool.make("t3_group_handoff", {
  ...groupTool,
  description:
    "Hand your chat off to a new chat that continues the work, when this chat has grown long or the next phase deserves a fresh start. Write summary for the new chat: the goal, what is done, decisions made, what is left, and where to look. The new chat starts in your chat's group (one is created from your chat's workspace when it has none), with your model and modes, and sees your summary as its starting context; it can read this chat with t3_thread_read. Afterwards your chat is linked to the new one and settles when your turn ends, unless auto-settle is off for it. Stop working once this succeeds.",
  parameters: Schema.Struct({
    summary: Schema.String.check(
      Schema.isMaxLength(ThreadGroupLaunchService.HANDOFF_SUMMARY_MAX_CHARS),
    ).annotate({
      description: `The handoff summary the new chat starts from, at most ${ThreadGroupLaunchService.HANDOFF_SUMMARY_MAX_CHARS} characters.`,
    }),
    title: Schema.optional(TrimmedNonEmptyString).annotate({
      description: 'Title of the new chat. Defaults to "Continue: <your chat\'s title>".',
    }),
    prompt: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120_000))).annotate({
      description: `Visible first message of the new chat. Defaults to "${ThreadGroupLaunchService.HANDOFF_DEFAULT_PROMPT}"`,
    }),
    clientRequestId,
  }),
  success: Schema.Struct({
    group: OrchestrationThreadGroupShell,
    threadId: ThreadId,
    title: Schema.String,
    createdGroup: Schema.Boolean,
    sourceSettle: Schema.Literals(["settled", "settles-when-turn-ends", "skipped", "failed"]),
    note: Schema.String,
  }),
  dependencies: [...groupTool.dependencies, ThreadGroupLaunchService.ThreadGroupLaunchService],
})
  .annotate(Tool.Title, "Hand off to a new chat")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const GroupMoveThreadTool = Tool.make("t3_group_move_thread", {
  ...groupTool,
  description:
    "Move a chat into a group, or out of its group with groupId: null (it keeps its branch and worktree). Omit threadId to move your own chat. The chat and group must be in the same project. A chat working in a different worktree than the group fails with invalid_request unless adoptGroupWorkspace is true, which switches the chat to the group's worktree and branch; that needs the chat to be idle and the group's worktree to exist. A group left with no chats is removed.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    groupId: Schema.NullOr(ThreadGroupId).annotate({
      description: "The group to move the chat into, or null to take it out of its group.",
    }),
    adoptGroupWorkspace: Schema.optional(Schema.Boolean),
    clientRequestId,
  }),
  success: Schema.Struct({
    group: Schema.NullOr(OrchestrationThreadGroupShell),
    threadId: ThreadId,
  }),
})
  .annotate(Tool.Title, "Move a chat to a group")
  .annotate(Tool.Destructive, false);

const GroupResourceTool = Tool.make("t3_group_resource", {
  ...groupTool,
  description:
    'Register a running resource on a group, such as a dev server or a container you started, so the user and the group\'s other chats can find it; or remove one. Omit groupId for the group your chat is in. action "add" needs name, and kind defaults to "other"; pass url when it has one. id is generated for add unless you pass one; action "remove" needs the id and succeeds with removed: false when the id is not there. Registered resources are shown as registered, never health-checked, so remove one when you stop it.',
  parameters: Schema.Struct({
    groupId: groupIdParameter,
    action: Schema.Literals(["add", "remove"]),
    id: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
    name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
    url: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
    kind: Schema.optional(ThreadGroupManualResourceKind),
    clientRequestId,
  }),
  success: Schema.Struct({
    group: OrchestrationThreadGroupShell,
    resources: Schema.Array(ThreadGroupManualResource),
    removed: Schema.optional(Schema.Boolean).annotate({
      description: "For remove: false when the group had no resource with that id.",
    }),
  }),
})
  .annotate(Tool.Title, "Register a group resource")
  .annotate(Tool.Destructive, false);

export const GroupToolkit = Toolkit.make(
  GroupReadTool,
  GroupCreateTool,
  GroupUpdateTool,
  GroupNewThreadTool,
  GroupHandoffTool,
  GroupMoveThreadTool,
  GroupResourceTool,
);
