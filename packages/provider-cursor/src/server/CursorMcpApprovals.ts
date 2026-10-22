/**
 * Ctrl: approval cards for Cursor MCP tool calls. Cursor's SDK cannot ask the
 * user anything and ignores Cursor's allowlist, but it runs the user's
 * `beforeMCPExecution` hooks. Ctrl installs one hook that asks this server; the
 * server checks the allowlist in `~/.cursor/cli-config.json` and, for a call it
 * does not cover, shows an approval card in the thread and answers the hook
 * with the user's decision.
 */

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

type JsonObject = Record<string, unknown>;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Where the hook reaches this server, set in the server's environment at startup. */
export const CURSOR_HOOK_URL_ENV = "CTRL_CURSOR_HOOK_URL";
export const CURSOR_HOOK_TOKEN_ENV = "CTRL_CURSOR_HOOK_TOKEN";
export const CURSOR_HOOK_PATH = "/api/cursor-hooks/before-mcp";

/** MCP servers Ctrl itself gives Cursor agents; their calls never need approval. */
const CTRL_OWN_SERVERS = new Set(["t3-code", "custom-user-tools"]);

export type McpPermission = "allow" | "deny" | "ask";

export interface McpPermissionRules {
  readonly allow: ReadonlyArray<string>;
  readonly deny: ReadonlyArray<string>;
}

const MCP_RULE_PATTERN = /^Mcp\(\s*([^:)]+?)\s*:\s*([^)]+?)\s*\)$/;

const globMatches = (pattern: string, value: string) =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
    "i",
  ).test(value);

const ruleMatches = (rule: string, server: string, tool: string) => {
  const match = MCP_RULE_PATTERN.exec(rule.trim());
  return match !== null && globMatches(match[1]!, server) && globMatches(match[2]!, tool);
};

/**
 * Cursor's own rule semantics for `Mcp(server:tool)` entries: a deny wins, an
 * allow runs, and anything else asks.
 */
export function mcpPermission(
  rules: McpPermissionRules,
  server: string,
  tool: string,
): McpPermission {
  if (rules.deny.some((rule) => ruleMatches(rule, server, tool))) return "deny";
  if (rules.allow.some((rule) => ruleMatches(rule, server, tool))) return "allow";
  return "ask";
}

const readRules = Effect.fn("CursorMcpApprovals.readRules")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const text = yield* fileSystem
    .readFileString(path.join(homeDirectory, ".cursor", "cli-config.json"))
    .pipe(Effect.option);
  const parsed = Option.isSome(text) ? decodeJson(text.value) : Option.none();
  const permissions =
    Option.isSome(parsed) && isJsonObject(parsed.value) && isJsonObject(parsed.value.permissions)
      ? parsed.value.permissions
      : {};
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  return {
    allow: strings(permissions.allow),
    deny: strings(permissions.deny),
  } satisfies McpPermissionRules;
});

export interface CursorMcpCall {
  readonly server: string;
  readonly tool: string;
  /** The tool's arguments as Cursor sent them, a JSON string. */
  readonly input: string;
  readonly toolCallId: string | null;
}

export type CursorMcpApprovalDecision = "allow_once" | "allow_for_session" | "deny";

export interface CursorApprovalSession {
  /** Whether this session's Cursor instance turned on approvals; others are never held. */
  readonly enforced: boolean;
  /** The Cursor agent the session has open, which hooks report as `conversation_id`. */
  readonly agentId: () => string | null;
  readonly cwd: string | null;
  readonly hasActiveTurn: () => boolean;
  /** Shows a card in the session's thread and waits; deny when the turn ends first. */
  readonly requestApproval: (call: CursorMcpCall) => Effect.Effect<CursorMcpApprovalDecision>;
}

const sessions = new Set<CursorApprovalSession>();

/** Adds a Cursor session to the ones a hook call can be matched to, until the scope closes. */
export const registerCursorApprovalSession = (session: CursorApprovalSession) =>
  Effect.acquireRelease(
    Effect.sync(() => sessions.add(session)),
    () => Effect.sync(() => sessions.delete(session)),
  ).pipe(Effect.asVoid);

/** Test-only reset of the process-wide session registry. */
export function resetCursorApprovalSessionsForTest(): void {
  sessions.clear();
}

/**
 * The session a hook call came from: the one whose agent matches the hook's
 * conversation, else the only session with a running turn in that folder.
 */
function sessionForHook(conversationId: string | null, cwd: string | null) {
  if (conversationId !== null) {
    for (const session of sessions) {
      if (session.agentId() === conversationId) return session;
    }
  }
  const running = [...sessions].filter(
    (session) => session.hasActiveTurn() && (cwd === null || session.cwd === cwd),
  );
  return running.length === 1 ? running[0]! : null;
}

export interface CursorHookResponse {
  readonly permission: "allow" | "deny";
  readonly user_message?: string;
  readonly agent_message?: string;
}

const deny = (reason: string): CursorHookResponse => ({
  permission: "deny",
  user_message: reason,
  agent_message: `${reason} Tell the user the call was not made.`,
});

const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

/** Answers one `beforeMCPExecution` hook call. */
export const decideCursorMcpHook = Effect.fn("CursorMcpApprovals.decide")(function* (
  payload: unknown,
) {
  if (!isJsonObject(payload)) return deny("Ctrl could not read the tool call.");
  const server = text(payload.mcp_server_name);
  const tool = text(payload.tool_name);
  if (server === null || tool === null) return deny("Ctrl could not read the tool call.");
  const allow = { permission: "allow" } satisfies CursorHookResponse;
  if (CTRL_OWN_SERVERS.has(server)) return allow;
  const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
  const session = sessionForHook(text(payload.conversation_id), text(roots[0]));
  // A hook left installed must not hold sessions that never opted in.
  if (session !== null ? !session.enforced : ![...sessions].some((each) => each.enforced)) {
    return allow;
  }

  const permission = mcpPermission(yield* readRules(), server, tool);
  if (permission === "allow") return allow;
  if (permission === "deny") return deny(`Your Cursor allowlist denies ${server} ${tool}.`);
  if (session === null) {
    yield* Effect.logWarning("No Ctrl thread matched a Cursor MCP approval hook.", {
      server,
      tool,
    });
    return deny(`Ctrl could not tell which chat asked to use ${server} ${tool}.`);
  }
  const decision = yield* session.requestApproval({
    server,
    tool,
    input: text(payload.tool_input) ?? "{}",
    toolCallId: text(payload.tool_use_id),
  });
  return decision === "deny" ? deny(`The user declined ${server} ${tool}.`) : allow;
});

const HOOK_SCRIPT_NAME = "ctrl-mcp-approval.sh";

// Outside Ctrl (the Cursor app, cursor-agent) the variables are unset and the
// hook makes no decision, so Cursor's own approval flow applies there.
const HOOK_SCRIPT = `#!/bin/sh
# Installed by Ctrl: asks Ctrl to approve Cursor MCP tool calls outside your allowlist.
# Remove it from Ctrl's Cursor settings.
if [ -z "$${CURSOR_HOOK_URL_ENV}" ] || [ -z "$${CURSOR_HOOK_TOKEN_ENV}" ]; then
  cat >/dev/null
  echo '{}'
  exit 0
fi
curl -sS --fail --max-time 3600 -X POST \\
  -H "Authorization: Bearer $${CURSOR_HOOK_TOKEN_ENV}" \\
  -H "Content-Type: application/json" \\
  --data-binary @- "$${CURSOR_HOOK_URL_ENV}" ||
  echo '{"permission":"deny","user_message":"Ctrl could not be reached to approve this MCP call."}'
`;

const hookEntryFor = (scriptPath: string) => ({
  command: scriptPath,
  timeout: 3600,
  failClosed: true,
});

/**
 * Adds or removes Ctrl's `beforeMCPExecution` entry in `~/.cursor/hooks.json`,
 * keeping every other hook. Does nothing on Windows, which has no `sh`.
 */
export const setCursorApprovalHookInstalled = Effect.fn("CursorMcpApprovals.setHookInstalled")(
  function* (installed: boolean) {
    if ((yield* HostProcess.Platform) === "win32") return;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const cursorDirectory = path.join(homeDirectory, ".cursor");
    const configPath = path.join(cursorDirectory, "hooks.json");
    const scriptPath = path.join(cursorDirectory, "hooks", HOOK_SCRIPT_NAME);

    const existingText = yield* fileSystem.readFileString(configPath).pipe(Effect.option);
    const parsed = Option.isSome(existingText) ? decodeJson(existingText.value) : Option.none();
    if (Option.isSome(existingText) && (Option.isNone(parsed) || !isJsonObject(parsed.value))) {
      return yield* Effect.logWarning(
        "~/.cursor/hooks.json is not valid JSON, so Ctrl left its approval hook unchanged.",
      );
    }
    const config: JsonObject =
      Option.isSome(parsed) && isJsonObject(parsed.value) ? parsed.value : {};
    const hooks = isJsonObject(config.hooks) ? config.hooks : {};
    const entries = Array.isArray(hooks.beforeMCPExecution) ? hooks.beforeMCPExecution : [];
    const isOurs = (entry: unknown) => isJsonObject(entry) && entry.command === scriptPath;
    const others = entries.filter((entry) => !isOurs(entry));
    const nextEntries = installed ? [...others, hookEntryFor(scriptPath)] : others;
    const { beforeMCPExecution: _previous, ...otherSteps } = hooks;
    const nextHooks =
      nextEntries.length > 0 ? { ...otherSteps, beforeMCPExecution: nextEntries } : otherSteps;
    const next = { ...config, version: config.version ?? 1, hooks: nextHooks };

    if (installed) {
      yield* fileSystem.makeDirectory(path.dirname(scriptPath), { recursive: true });
      yield* fileSystem.writeFileString(scriptPath, HOOK_SCRIPT, { mode: 0o755 });
      yield* fileSystem.chmod(scriptPath, 0o755);
    } else {
      yield* fileSystem.remove(scriptPath).pipe(Effect.ignore);
      // Leave a file Ctrl never added to exactly as the user wrote it.
      if (!entries.some(isOurs)) return;
    }
    // @effect-diagnostics-next-line preferSchemaOverJson:off - Cursor's own file, kept readable.
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    if (Option.isSome(existingText) && existingText.value === serialized) return;
    const temporaryPath = `${configPath}.ctrl.tmp`;
    yield* fileSystem.writeFileString(temporaryPath, serialized);
    yield* fileSystem.rename(temporaryPath, configPath);
  },
);
