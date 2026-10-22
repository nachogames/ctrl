/**
 * Ctrl: approval cards for Cursor MCP tool calls. Cursor's SDK cannot ask the
 * user anything and ignores Cursor's allowlist, but it runs the user's
 * `beforeMCPExecution` hooks. Ctrl installs one hook that asks this server; the
 * server checks the allowlist in `~/.cursor/cli-config.json` and, for a call it
 * does not cover, shows an approval card in the thread and answers the hook
 * with the user's decision.
 */

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

type JsonObject = Record<string, unknown>;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Where the hook reaches this server, set in the server's environment at
 * startup. The `T3CODE_` prefix keeps them out of user terminals.
 */
export const CURSOR_HOOK_URL_ENV = "T3CODE_CURSOR_HOOK_URL";
export const CURSOR_HOOK_TOKEN_ENV = "T3CODE_CURSOR_HOOK_TOKEN";
export const CURSOR_HOOK_PATH = "/api/cursor-hooks/before-mcp";

export type McpPermission = "allow" | "deny" | "ask";

export interface McpPermissionRules {
  readonly allow: ReadonlyArray<string>;
  readonly deny: ReadonlyArray<string>;
}

const MCP_RULE_PATTERN = /^Mcp\(\s*([^:)]+?)\s*:\s*([^)]+?)\s*\)$/;

const globMatches = (pattern: string, value: string, ignoreCase: boolean) =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
    ignoreCase ? "i" : "",
  ).test(value);

// Deny rules ignore case so a renamed server cannot slip past them; allow rules
// must match exactly.
const ruleMatches = (rule: string, server: string, tool: string, ignoreCase: boolean) => {
  const match = MCP_RULE_PATTERN.exec(rule.trim());
  return (
    match !== null &&
    globMatches(match[1]!, server, ignoreCase) &&
    globMatches(match[2]!, tool, ignoreCase)
  );
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
  if (rules.deny.some((rule) => ruleMatches(rule, server, tool, true))) return "deny";
  if (rules.allow.some((rule) => ruleMatches(rule, server, tool, false))) return "allow";
  return "ask";
}

/** The `mcpAllowedTools` list anywhere in a stored settings object. */
export function findMcpAllowedTools(value: unknown, depth = 0): ReadonlyArray<string> | null {
  if (depth > 8 || typeof value !== "object" || value === null) return null;
  if (!Array.isArray(value)) {
    const record = value as JsonObject;
    if (Array.isArray(record.mcpAllowedTools)) {
      // With MCP auto-run off, the app asks before every tool, whatever the list says.
      if (record.yoloMcpToolsDisabled === true) return [];
      return record.mcpAllowedTools.filter((entry): entry is string => typeof entry === "string");
    }
  }
  for (const child of Object.values(value)) {
    const found = findMcpAllowedTools(child, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The Cursor app's MCP allowlist, `server:tool` entries it keeps in its own
 * settings database. Undocumented, so any surprise reads as an empty list,
 * which only makes calls ask.
 */
const readCursorAppAllowedTools = Effect.fn("CursorMcpApprovals.readAppAllowedTools")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const userDirectory =
    platform === "darwin"
      ? path.join(homeDirectory, "Library", "Application Support", "Cursor", "User")
      : platform === "linux"
        ? path.join(homeDirectory, ".config", "Cursor", "User")
        : null;
  if (userDirectory === null) return [];
  const database = path.join(userDirectory, "globalStorage", "state.vscdb");
  if (!(yield* fileSystem.exists(database).pipe(Effect.orElseSucceed(() => false)))) return [];
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Cursor holds the writer while it runs; fail fast instead of waiting on it.
    yield* sql.unsafe("PRAGMA busy_timeout = 100");
    const rows = yield* sql.unsafe<{ readonly value: unknown }>(
      "SELECT value FROM ItemTable WHERE key LIKE '%reactivestorage%'",
    );
    for (const row of rows) {
      const raw =
        typeof row.value === "string"
          ? row.value
          : row.value instanceof Uint8Array
            ? new TextDecoder().decode(row.value)
            : null;
      if (raw === null || !raw.includes("mcpAllowedTools")) continue;
      const parsed = decodeJson(raw);
      const found = Option.isSome(parsed) ? findMcpAllowedTools(parsed.value) : null;
      if (found !== null) return found;
    }
    return [];
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: database, readonly: true })),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not read the Cursor app's MCP allowlist.", { cause }).pipe(
        Effect.as([]),
      ),
    ),
  );
});

/** `server:tool` from the Cursor app as a `Mcp(server:tool)` rule. */
const appAllowRule = (entry: string) => {
  const separator = entry.indexOf(":");
  return separator <= 0 ? null : `Mcp(${entry.slice(0, separator)}:${entry.slice(separator + 1)})`;
};

/** Rules from `~/.cursor/cli-config.json` plus the Cursor app's MCP allowlist. */
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
  const appRules = (yield* readCursorAppAllowedTools()).flatMap((entry) => {
    const rule = appAllowRule(entry);
    return rule === null ? [] : [rule];
  });
  return {
    allow: [...strings(permissions.allow), ...appRules],
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
  /** The URL of the Ctrl MCP server this session gave its agent, if any. */
  readonly ctrlMcpUrl: () => string | null;
  /**
   * Shows a card in the session's thread and waits; deny when the turn ends
   * first. A call matched only by folder cannot be allowed for the whole chat.
   */
  readonly requestApproval: (
    call: CursorMcpCall,
    options: { readonly matchedByAgent: boolean },
  ) => Effect.Effect<CursorMcpApprovalDecision>;
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
      if (session.agentId() === conversationId) return { session, matchedByAgent: true };
    }
  }
  const running = [...sessions].filter(
    (session) => session.hasActiveTurn() && (cwd === null || session.cwd === cwd),
  );
  return running.length === 1 ? { session: running[0]!, matchedByAgent: false } : null;
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
  const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
  const matched = sessionForHook(text(payload.conversation_id), text(roots[0]));
  const session = matched?.session ?? null;
  // A hook left installed must not hold sessions that never opted in.
  if (session !== null ? !session.enforced : ![...sessions].some((each) => each.enforced)) {
    return allow;
  }
  // Ctrl's own servers are known by address, not just by a name a project could reuse.
  const serverUrl = text(payload.mcp_server_url) ?? text(payload.url);
  const ownServer =
    (server === "t3-code" && serverUrl !== null && session?.ctrlMcpUrl() === serverUrl) ||
    (server === "custom-user-tools" &&
      serverUrl === null &&
      text(payload.command) === "custom-user-tools");
  if (ownServer) return allow;

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
  const decision = yield* session.requestApproval(
    {
      server,
      tool,
      input: text(payload.tool_input) ?? "{}",
      toolCallId: text(payload.tool_use_id),
    },
    { matchedByAgent: matched?.matchedByAgent === true },
  );
  return decision === "deny" ? deny(`The user declined ${server} ${tool}.`) : allow;
});

const HOOK_SCRIPT_NAME = "ctrl-mcp-approval.sh";

// Outside Ctrl (the Cursor app, cursor-agent) the variables are unset and the
// hook makes no decision, so Cursor's own approval flow applies there.
const HOOK_SCRIPT = `#!/bin/sh
# Installed by Ctrl: asks Ctrl to approve Cursor MCP tool calls outside your allowlist.
# Remove it from Ctrl's Cursor settings.
cat_input() { cat >/dev/null; }
if [ -z "$${CURSOR_HOOK_TOKEN_ENV}" ]; then
  cat_input
  echo '{}'
  exit 0
fi
if [ -z "$${CURSOR_HOOK_URL_ENV}" ]; then
  cat_input
  echo '{"permission":"deny","user_message":"Ctrl is not listening for approvals yet."}'
  exit 0
fi
curl -sS --fail --max-time 3600 -X POST \\
  -H "Authorization: Bearer $${CURSOR_HOOK_TOKEN_ENV}" \\
  -H "Content-Type: application/json" \\
  --data-binary @- "$${CURSOR_HOOK_URL_ENV}" ||
  echo '{"permission":"deny","user_message":"Ctrl could not be reached to approve this MCP call."}'
`;

// The command runs through a shell, so the path is quoted for homes with spaces.
const hookCommand = (scriptPath: string) => `'${scriptPath.replaceAll("'", "'\\''")}'`;
const hookEntryFor = (scriptPath: string) => ({
  command: hookCommand(scriptPath),
  timeout: 3600,
  failClosed: true,
});

export class CursorApprovalHookError extends Schema.TaggedError<CursorApprovalHookError>()(
  "CursorApprovalHookError",
  { detail: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Adds or removes Ctrl's `beforeMCPExecution` entry in `~/.cursor/hooks.json`,
 * keeping every other hook. Fails rather than leaving calls unguarded when it
 * cannot install, including on Windows, which has no `sh`.
 */
export const setCursorApprovalHookInstalled = Effect.fn("CursorMcpApprovals.setHookInstalled")(
  function* (installed: boolean) {
    if ((yield* HostProcess.Platform) === "win32") {
      if (!installed) return;
      return yield* new CursorApprovalHookError({
        detail: "Approving Cursor MCP calls is not supported on Windows yet.",
      });
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const cursorDirectory = path.join(homeDirectory, ".cursor");
    const linkPath = path.join(cursorDirectory, "hooks.json");
    // Write through a symlink, such as one a dotfile manager keeps, instead of replacing it.
    const configPath = yield* fileSystem
      .realPath(linkPath)
      .pipe(Effect.orElseSucceed(() => linkPath));
    const scriptPath = path.join(cursorDirectory, "hooks", HOOK_SCRIPT_NAME);
    const failed = (detail: string) => (cause: unknown) =>
      new CursorApprovalHookError({ detail, cause });

    const existingText = yield* fileSystem.readFileString(configPath).pipe(Effect.option);
    const parsed = Option.isSome(existingText) ? decodeJson(existingText.value) : Option.none();
    if (Option.isSome(existingText) && (Option.isNone(parsed) || !isJsonObject(parsed.value))) {
      return yield* new CursorApprovalHookError({
        detail: "~/.cursor/hooks.json is not plain JSON, so Ctrl could not add its approval hook.",
      });
    }
    const config: JsonObject =
      Option.isSome(parsed) && isJsonObject(parsed.value) ? parsed.value : {};
    const hooks = isJsonObject(config.hooks) ? config.hooks : {};
    if (hooks.beforeMCPExecution !== undefined && !Array.isArray(hooks.beforeMCPExecution)) {
      return yield* new CursorApprovalHookError({
        detail: "beforeMCPExecution in ~/.cursor/hooks.json is not a list, so Ctrl left it alone.",
      });
    }
    const entries = Array.isArray(hooks.beforeMCPExecution) ? hooks.beforeMCPExecution : [];
    const isOurs = (entry: unknown) =>
      isJsonObject(entry) &&
      (entry.command === scriptPath || entry.command === hookCommand(scriptPath));
    const others = entries.filter((entry) => !isOurs(entry));
    const nextEntries = installed ? [...others, hookEntryFor(scriptPath)] : others;
    const { beforeMCPExecution: _previous, ...otherSteps } = hooks;
    const nextHooks =
      nextEntries.length > 0 ? { ...otherSteps, beforeMCPExecution: nextEntries } : otherSteps;
    const next = { ...config, version: config.version ?? 1, hooks: nextHooks };

    if (installed) {
      yield* fileSystem
        .makeDirectory(path.dirname(scriptPath), { recursive: true })
        .pipe(
          Effect.andThen(fileSystem.writeFileString(scriptPath, HOOK_SCRIPT, { mode: 0o755 })),
          Effect.andThen(fileSystem.chmod(scriptPath, 0o755)),
          Effect.mapError(failed("Ctrl could not write its Cursor approval hook script.")),
        );
    } else {
      yield* fileSystem.remove(scriptPath).pipe(Effect.ignore);
      // Leave a file Ctrl never added to exactly as the user wrote it.
      if (!entries.some(isOurs)) return;
    }
    // @effect-diagnostics-next-line preferSchemaOverJson:off - Cursor's own file, kept readable.
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    if (Option.isSome(existingText) && existingText.value === serialized) return;
    const temporaryPath = `${configPath}.ctrl.tmp`;
    yield* fileSystem
      .makeDirectory(path.dirname(configPath), { recursive: true })
      .pipe(
        Effect.andThen(fileSystem.writeFileString(temporaryPath, serialized)),
        Effect.andThen(fileSystem.rename(temporaryPath, configPath)),
        Effect.mapError(failed("Ctrl could not update ~/.cursor/hooks.json.")),
      );
  },
);

// Cursor instances in this server that turned approvals on. The hook is
// global, so one instance turning the setting off must not remove it while
// another still relies on it.
const enforcingInstances = new Set<string>();

/** Records an instance's setting, then installs the hook if any instance wants it, else removes it. */
export const syncCursorApprovalHook = Effect.fn("CursorMcpApprovals.syncHook")(function* (
  instanceId: string,
  enforced: boolean,
) {
  if (enforced) enforcingInstances.add(instanceId);
  else enforcingInstances.delete(instanceId);
  yield* setCursorApprovalHookInstalled(enforcingInstances.size > 0);
});
