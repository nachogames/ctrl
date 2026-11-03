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
import * as SecureRandom from "effect/crypto/SecureRandom";
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
    SecureRandom.SecureRandom,
  ],
};

const groupIdParameter = Schema.optional(ThreadGroupId).annotate({
  description: "Omit for your own chat's group.",
});
const clientRequestId = Schema.optional(
  TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
).annotate({
  description: "Idempotency key: reuse it on a retry so the change happens once.",
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
    "Read a chat group: title, goal, branch, worktree, pull request, last handoff, its chats (oldest first, with handoff links and isCaller), ticket links, and what runs for it now: servers its chats or worktree started, its worktree's docker compose containers, and hand-registered resources (source \"registered\", never health-checked). With your chat in no group the result is { group: null, threadIds: [your chat] }. A group's chats work toward one goal in one project.",
  parameters: Schema.Struct({ groupId: groupIdParameter }),
  success: Schema.Union([
    Schema.Struct({
      group: OrchestrationThreadGroupShell,
      chats: Schema.Array(GroupChat),
      running: Schema.Struct({ resources: Schema.Array(ThreadGroupRunningResource) }),
    }),
    // The calling chat, in no group.
    Schema.Struct({ group: Schema.Null, threadIds: Schema.Array(ThreadId) }),
  ]),
})
  .annotate(Tool.Title, "Read a chat group")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const GroupCreateTool = Tool.make("t3_group_create", {
  ...groupTool,
  description:
    "Group chats working toward one goal, such as a planning chat and the build chat it launched. No threadIds groups just your chat; threadIds: [id] groups your chat with those (includeCaller: false leaves yours out). The first listed chat (yours when none) gives the group its project, branch, worktree, pull request and default title; every chat must be in that project. Each chat keeps its own worktree unless adoptGroupWorkspace; then each other chat must be idle with no uncommitted changes. A chat in another group moves here. To add to an existing group, use t3_group_move_thread.",
  parameters: Schema.Struct({
    threadIds: Schema.optional(Schema.Array(ThreadId).check(Schema.isMinLength(1))).annotate({
      description: "The first supplies the workspace; your chat is added after them.",
    }),
    includeCaller: Schema.optional(Schema.Boolean).annotate({
      description: "Defaults to true.",
    }),
    title: Schema.optional(TrimmedNonEmptyString).annotate({
      description: "Defaults to the first chat's title or branch, or one generated from goal.",
    }),
    goal: Schema.optional(TrimmedNonEmptyString).annotate({
      description: "One or two sentences.",
    }),
    adoptGroupWorkspace: Schema.optional(Schema.Boolean).annotate({
      description: "Move every other chat onto the first chat's worktree and branch.",
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
    "Rename a chat group, set or clear (null) its goal, link or unlink tickets, pin, or settle it. Omitted fields stay. With your chat in no group, a goal or new links first make a group of your chat; other changes need a group. settled: true settles the group and its chats (yours when your turn ends; a chat running, waiting on a question, or in broader modes than yours stays and is listed in unchangedChats); false unsettles them.",
  parameters: Schema.Struct({
    groupId: groupIdParameter,
    title: Schema.optional(TrimmedNonEmptyString),
    goal: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    pinned: Schema.optional(Schema.Boolean),
    settled: Schema.optional(Schema.Boolean),
    links: Schema.optional(
      Schema.Struct({
        add: Schema.optional(
          Schema.Array(
            Schema.Struct({
              url: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
              label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
            }),
          ),
        ),
        remove: Schema.optional(
          Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
        ),
      }),
    ).annotate({
      description:
        "add: http(s) URLs (Linear issues show their key, GitHub issues #N, unless label); linked URLs are skipped. remove: link ids or URLs.",
    }),
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
    "Start a new chat in a group, in its worktree and branch (else the project root), with prompt as its first message. Model and modes default to yours and may not be broader. Omit title to generate one. Follow the returned threadId with t3_thread_read or t3_thread_wait.",
  parameters: Schema.Struct({
    groupId: groupIdParameter,
    prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
      description: "The whole task.",
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
    "Hand your chat off to a new chat that continues the work, when this one has grown long or the next phase deserves a fresh start. The new chat starts in your group (made from your workspace if you have none) with your model and modes, starts from your summary, and can read this chat with t3_thread_read. Your chat is linked to it and settles when your turn ends, unless auto-settle is off. Stop working once this succeeds.",
  parameters: Schema.Struct({
    summary: Schema.String.check(
      Schema.isMaxLength(ThreadGroupLaunchService.HANDOFF_SUMMARY_MAX_CHARS),
    ).annotate({
      description: `The goal, what is done, decisions, what is left, and where to look. At most ${ThreadGroupLaunchService.HANDOFF_SUMMARY_MAX_CHARS} characters.`,
    }),
    title: Schema.optional(TrimmedNonEmptyString).annotate({
      description: 'Defaults to "Continue: <your title>".',
    }),
    prompt: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120_000))).annotate({
      description: `The new chat's visible first message. Defaults to "${ThreadGroupLaunchService.HANDOFF_DEFAULT_PROMPT}"`,
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
    "Move a chat (omit threadId for yours) into a group of its project, or out with groupId: null (it keeps its branch and worktree). A chat in another worktree than the group's fails unless adoptGroupWorkspace, which switches the idle chat to the group's worktree and branch. A group left with no chats is removed.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    groupId: Schema.NullOr(ThreadGroupId).annotate({
      description: "null takes the chat out of its group.",
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
    'Register a resource you started, such as a dev server or container, on a group so the user and its other chats can find it, or remove one. When you start a server for the group, add it with a clear name ("Web app", "API") and its http://localhost:<port> url; the Group panel shows that name. Registered resources are never health-checked: remove one when you stop it. add needs name (kind defaults to "other", id is generated unless given); remove needs id and returns removed: false when absent.',
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
