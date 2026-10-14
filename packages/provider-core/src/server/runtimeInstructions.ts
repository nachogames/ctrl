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
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.
</pull_request_linking>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
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
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${T3_CODE_REVIEW_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
