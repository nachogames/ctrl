import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import {
  AuthEnvironmentMaintainScope,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  // Stopping a server signals its processes, as closing a terminal does.
  [WS_METHODS.previewStopLocalServer]: AuthTerminalOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.remoteMcpAdd]: AuthSettingsWriteScope,
  [WS_METHODS.remoteMcpAuthorize]: AuthSettingsWriteScope,
  [WS_METHODS.remoteMcpReconnect]: AuthSettingsWriteScope,
  [WS_METHODS.remoteMcpRemove]: AuthSettingsWriteScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCreateFromThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlStar]: AuthSourceControlWriteScope,
  // Signing in replaces the server's GitHub credential, as saving a token in Settings does.
  [WS_METHODS.sourceControlSignInStart]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInWait]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInCancel]: AuthSettingsWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  // Starts an agent session on this environment that can read its logs and database.
  [WS_METHODS.serverPrepareTriage]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  // Each changes the review, and the last three start an agent turn or a chat.
  [WS_METHODS.reviewSessionsDecide]: AuthOrchestrationOperateScope,
  [WS_METHODS.reviewSessionsSetViewed]: AuthOrchestrationOperateScope,
  [WS_METHODS.reviewSessionsEditReply]: AuthOrchestrationOperateScope,
  [WS_METHODS.reviewSessionsRequest]: AuthOrchestrationOperateScope,
  [WS_METHODS.reviewSessionsStartFromPullRequest]: AuthOrchestrationOperateScope,
  [WS_METHODS.reviewSessionsRunLocalReview]: AuthOrchestrationOperateScope,
  [WS_METHODS.reviewSessionsDiscussInSideChat]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  // Home acts with the user's reach, which orchestration:operate already grants.
  [WS_METHODS.homeEnable]: AuthOrchestrationOperateScope,
  [WS_METHODS.homeDisable]: AuthOrchestrationOperateScope,
  [WS_METHODS.homeStartFresh]: AuthOrchestrationOperateScope,
  [WS_METHODS.homeReportWatchEvents]: AuthOrchestrationOperateScope,
  [WS_METHODS.dictationInstall]: AuthOrchestrationOperateScope,
  [WS_METHODS.dictationRemove]: AuthOrchestrationOperateScope,
  [WS_METHODS.dictationStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.dictationWarm]: AuthOrchestrationOperateScope,
  [WS_METHODS.dictationAppend]: AuthOrchestrationOperateScope,
  [WS_METHODS.dictationFinish]: AuthOrchestrationOperateScope,
  [WS_METHODS.dictationCancel]: AuthOrchestrationOperateScope,
  [WS_METHODS.speechInstall]: AuthOrchestrationOperateScope,
  [WS_METHODS.speechRemove]: AuthOrchestrationOperateScope,
  [WS_METHODS.speechSynthesize]: AuthOrchestrationOperateScope,
  [WS_METHODS.voiceFrontRespond]: AuthOrchestrationOperateScope,
  [WS_METHODS.voiceFrontEnd]: AuthOrchestrationOperateScope,
  [WS_METHODS.voiceFrontSetGeminiKey]: AuthSettingsWriteScope,
  // Turning a plugin on runs its code on the host, like changing a setting would.
  [WS_METHODS.pluginsSetEnabled]: AuthSettingsWriteScope,
  [WS_METHODS.pluginsReload]: AuthSettingsWriteScope,
  // Each reaches plugin code, which may act on the host.
  [WS_METHODS.pluginsBandPress]: AuthOrchestrationOperateScope,
  [WS_METHODS.pluginsViewCall]: AuthOrchestrationOperateScope,
  [WS_METHODS.pluginsCommandRun]: AuthOrchestrationOperateScope,
  // Each edits Cursor's MCP config or its saved sign-ins on this machine.
  [WS_METHODS.cursorMcpSignIn]: AuthProvidersManageScope,
  [WS_METHODS.cursorMcpSaveServer]: AuthProvidersManageScope,
  [WS_METHODS.cursorMcpRemoveServer]: AuthProvidersManageScope,
  // Restarting interrupts every running turn, like a server update.
  [WS_METHODS.cursorMcpRestartServer]: AuthEnvironmentMaintainScope,
  // Force stop kills agent processes, as Stop on a terminal does.
  [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: AuthOrchestrationOperateScope,
  // A guest link hands thread access to someone outside, like a pairing link.
  [WS_METHODS.guestShareCreate]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksLink]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksUnlink]: AuthAccessWriteScope,
  // A link lets every agent here reach the other environment: Settings' bar.
  [WS_METHODS.peerLinksAnswerRequest]: AuthAccessWriteScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.reviewSessionsStartFromPullRequest)
    return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
