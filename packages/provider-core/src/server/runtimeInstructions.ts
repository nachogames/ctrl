/** App-owned review entry point, available independently of repository skill files. */
export const T3_CODE_REVIEW_INSTRUCTIONS = `<pull_request_review>
When the user asks to review a GitHub pull request, triage its feedback, or apply a review round, use Ctrl's persistent review workspace whenever the t3-code review_* tools are available. This applies to every registered project; no repository-installed review-pr skill is required. Ctrl automatically discovers linked GitHub PRs and displays existing and future feedback in the Review tab without an agent turn. Use the review tools to enrich that feedback, discuss it, or change decisions. If you are already assigned a local or side-review role, follow that assignment instead of opening another session.
1. Identify the requested PR and its current head with gh pr view --json url,headRefOid,state. Link it with link_pull_request. Do not start a review for a closed PR.
2. Call t3_group_read. If the calling chat has no group, call t3_group_create with no arguments. Preserve an existing group.
3. Call review_session_open with url and headSha. If it refuses, report the error and stop. The review belongs to the group: any ordinary chat in that group may read, import, annotate, and record authorized decisions in the same panel. A different session.reviewThreadId is not a write restriction; it is the destination for panel-triggered automation. Continue in the calling chat using the returned session; do not create a duplicate review. Dedicated point-side chats and independent local-review chats keep their scoped roles.
4. Follow the returned brief. Call review_session_read and triage finished sources with review_items_import so the panel receives the findings. For an independent review requested by the user, use review_local_review_start; its review chat submits with review_source_submit.
5. If a review was already posted to GitHub, open the session and triage the imported feedback; do not rerun that review merely to populate the panel. Preserve decisions on refresh. Use the project's review and verification instructions within this workflow.
Questions do not change decisions. Applying fixes, pushing, replying, resolving, and submitting reviews still require the user's authorization and the brief's checks. If review tools are unavailable, say the panel could not be populated; do not claim a plain chat or GitHub review was saved to Ctrl.
</pull_request_review>`;

const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Link each PR you create, take over, or push to: one link_pull_request per PR, full URL, every stack layer, as your next call. Host tools do not link for you. If linking fails, say so. Skip PRs you only read or review, and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. Never wait with sleep, loops, gh --watch, Monitor, or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch.
</pull_request_linking>`;

/** Omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images, video, and audio in your response using Markdown image syntax with absolute file paths. Link any other file you produce using its absolute path so the user can open it in T3 Code's files viewer.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${T3_CODE_REVIEW_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
