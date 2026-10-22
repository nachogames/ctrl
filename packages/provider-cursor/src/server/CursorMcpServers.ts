/**
 * Cursor's MCP servers as Cursor itself sees them: entries in `~/.cursor/mcp.json`
 * and `<folder>/.cursor/mcp.json`, with status and sign-in from Cursor's own
 * `cursor-agent` CLI. Ctrl never reads or copies the saved sign-ins; Cursor keeps
 * them under `~/.cursor/projects/<folder>/`, one set per folder.
 */

import {
  CursorMcpOperationError,
  type CursorMcpSaveServerInput,
  type CursorMcpServer,
  type CursorMcpServerSource,
  type CursorMcpServerStatus,
  type CursorMcpServerTransport,
  type CursorMcpStatusResult,
} from "@t3tools/contracts";
import {
  type CommandResult,
  isCommandMissingCause,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { CursorSettings } from "../settings.ts";

export const CURSOR_CLI_INSTALL_COMMAND = "curl https://cursor.com/install -fsS | bash";

const LIST_TIMEOUT = Duration.seconds(60);
// Sign-in waits for the user to finish in the browser.
const SIGN_IN_TIMEOUT = Duration.minutes(5);
// oxlint-disable-next-line no-control-regex -- strips the CLI's ANSI color codes.
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;
// `cursor-agent mcp login` sometimes stops after receiving the OAuth code and
// asks to be run again to finish the token exchange.
const SIGN_IN_RERUN_PATTERN = /re-?run/i;

type JsonObject = Record<string, unknown>;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface CursorMcpListEntry {
  readonly name: string;
  readonly status: CursorMcpServerStatus;
  readonly detail: string | null;
}

/** Parses `cursor-agent mcp list`, whose lines read `name: status`. */
export function parseCursorMcpList(output: string): ReadonlyArray<CursorMcpListEntry> {
  const entries: CursorMcpListEntry[] = [];
  for (const rawLine of output.replace(ANSI_PATTERN, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const separator = line.indexOf(": ");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const detail = line.slice(separator + 2).trim();
    if (name.length === 0 || detail.length === 0) continue;
    const normalized = detail.toLowerCase();
    const status: CursorMcpServerStatus =
      normalized === "ready"
        ? "ready"
        : normalized.includes("auth") || normalized.includes("login")
          ? "needs_sign_in"
          : normalized.startsWith("error") || normalized.includes("failed")
            ? "error"
            : "unknown";
    entries.push({ name, status, detail: status === "ready" ? null : detail });
  }
  return entries;
}

interface CursorMcpConfigEntry {
  readonly name: string;
  readonly transport: CursorMcpServerTransport | null;
}

function cursorMcpTransport(value: unknown): CursorMcpServerTransport | null {
  if (!isJsonObject(value)) return null;
  if (typeof value.url === "string" && value.url.trim().length > 0) {
    return { _tag: "url", url: value.url.trim() };
  }
  if (typeof value.command === "string" && value.command.trim().length > 0) {
    const args = Array.isArray(value.args)
      ? value.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    return { _tag: "command", command: value.command.trim(), args };
  }
  return null;
}

function cursorMcpConfigEntries(config: unknown): ReadonlyArray<CursorMcpConfigEntry> {
  if (!isJsonObject(config) || !isJsonObject(config.mcpServers)) return [];
  return Object.entries(config.mcpServers).map(([name, value]) => ({
    name,
    transport: cursorMcpTransport(value),
  }));
}

/**
 * Writes one entry into a parsed `mcp.json`, keeping every other key and the
 * entry's own extra fields (headers, env, ...) that the new transport allows.
 */
function saveCursorMcpEntry(
  config: JsonObject,
  input: CursorMcpSaveServerInput,
): JsonObject | "server_exists" | "server_not_found" {
  const servers = isJsonObject(config.mcpServers) ? config.mcpServers : {};
  const previousName = input.previousName ?? input.name;
  const renaming = previousName !== input.name;
  if (input.previousName !== undefined && !Object.hasOwn(servers, previousName)) {
    return "server_not_found";
  }
  if ((renaming || input.previousName === undefined) && Object.hasOwn(servers, input.name)) {
    return "server_exists";
  }
  const existing = isJsonObject(servers[previousName]) ? servers[previousName] : {};
  const { url: _url, command: _command, args: _args, type, ...kept } = existing;
  // `type` names the URL protocol (sse, http), so it survives only a URL-to-URL edit.
  const keepType =
    input.transport._tag === "url" && typeof existing.url === "string" && type !== undefined;
  const entry: JsonObject =
    input.transport._tag === "url"
      ? { ...kept, ...(keepType ? { type } : {}), url: input.transport.url }
      : { ...kept, command: input.transport.command, args: [...input.transport.args] };
  if (input.transport._tag === "url") {
    delete entry.env;
    delete entry.cwd;
  } else {
    delete entry.headers;
    delete entry.auth;
  }
  const nextServers: JsonObject = {};
  let placed = false;
  for (const [name, value] of Object.entries(servers)) {
    if (name === previousName) {
      nextServers[input.name] = entry;
      placed = true;
    } else {
      nextServers[name] = value;
    }
  }
  if (!placed) nextServers[input.name] = entry;
  return { ...config, mcpServers: nextServers };
}

function removeCursorMcpEntry(config: JsonObject, name: string): JsonObject | "server_not_found" {
  const servers = isJsonObject(config.mcpServers) ? config.mcpServers : {};
  if (!Object.hasOwn(servers, name)) return "server_not_found";
  const { [name]: _removed, ...rest } = servers;
  return { ...config, mcpServers: rest };
}

const decodeCursorSettings = Schema.decodeUnknownOption(CursorSettings);

/** Whether a Cursor provider instance's saved config opted into sharing sign-ins. */
export function cursorSharesMcpSignIns(config: unknown): boolean {
  const settings = decodeCursorSettings(config ?? {});
  return Option.isSome(settings) && settings.value.shareMcpSignInsWithWorktrees;
}

/** Cursor's per-folder data directory, named the way its SDK names it. */
function cursorFolderDataDirectory(
  path: Path.Path,
  cursorDataDirectory: string,
  folder: string,
): string {
  const slug = folder
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return path.join(cursorDataDirectory, "projects", slug);
}

const hasTokens = (entry: unknown): entry is JsonObject =>
  isJsonObject(entry) &&
  (isJsonObject(entry.tokens) || "access_token" in entry || "refresh_token" in entry);

// Older Cursor builds stored bare tokens per server. The SDK converts a file
// only when it is all one shape, so a copied entry always takes the new shape.
const normalizedAuthEntry = (entry: JsonObject): JsonObject =>
  "tokens" in entry || "clientInfo" in entry ? entry : { tokens: entry };

/**
 * Every checkout of the git repository holding `folder`: the main checkout and
 * its worktrees, read from git's own metadata so nothing outside the repository
 * is considered.
 */
const repositoryCheckouts = Effect.fn("CursorMcpServers.repositoryCheckouts")(function* (
  folder: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readText = (file: string) =>
    fileSystem.readFileString(file).pipe(
      Effect.map((text) => text.trim()),
      Effect.option,
    );
  const dotGit = path.join(folder, ".git");
  const info = yield* fileSystem.stat(dotGit).pipe(Effect.option);
  if (Option.isNone(info)) return [];
  let commonDirectory = dotGit;
  if (info.value.type === "File") {
    const pointer = yield* readText(dotGit);
    if (Option.isNone(pointer) || !pointer.value.startsWith("gitdir:")) return [];
    const gitDirectory = path.resolve(folder, pointer.value.slice("gitdir:".length).trim());
    const common = yield* readText(path.join(gitDirectory, "commondir"));
    commonDirectory = Option.isSome(common)
      ? path.resolve(gitDirectory, common.value)
      : gitDirectory;
  }
  const checkouts = new Set<string>();
  if (path.basename(commonDirectory) === ".git") checkouts.add(path.dirname(commonDirectory));
  const worktreesDirectory = path.join(commonDirectory, "worktrees");
  const names = yield* fileSystem
    .readDirectory(worktreesDirectory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  for (const name of names) {
    const gitFile = yield* readText(path.join(worktreesDirectory, name, "gitdir"));
    if (Option.isSome(gitFile) && gitFile.value.length > 0) {
      checkouts.add(path.dirname(path.resolve(worktreesDirectory, name, gitFile.value)));
    }
  }
  checkouts.delete(folder);
  return [...checkouts];
});

/**
 * Before Cursor first opens `folder`, gives it the newest saved sign-in for each
 * MCP server from the other checkouts of the same repository, so a new worktree
 * starts signed in. Sign-ins stay in this user's Cursor data directory and never
 * cross repositories. Does nothing once the folder is loaded: Cursor would not
 * read the change until restart, and its own copy may be newer.
 */
export const shareCursorMcpSignIns = Effect.fn("CursorMcpServers.shareSignIns")(function* (
  folder: string,
) {
  if (cursorFolders.get(folder)?.loaded === true) return;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const cursorDataDirectory =
    environment.CURSOR_DATA_DIR?.trim() || path.join(homeDirectory, ".cursor");
  const authFile = (checkout: string) =>
    path.join(cursorFolderDataDirectory(path, cursorDataDirectory, checkout), "mcp-auth.json");

  const readAuth = Effect.fn("CursorMcpServers.readAuth")(function* (file: string) {
    const info = yield* fileSystem.stat(file).pipe(Effect.option);
    if (Option.isNone(info)) return null;
    const text = yield* fileSystem.readFileString(file).pipe(Effect.option);
    const parsed = Option.isSome(text) ? decodeJson(text.value) : Option.none();
    if (Option.isNone(parsed) || !isJsonObject(parsed.value)) return null;
    const modifiedAt = Option.match(info.value.mtime, {
      onNone: () => 0,
      onSome: (mtime) => mtime.getTime(),
    });
    return { entries: parsed.value, modifiedAt };
  });

  const checkouts = yield* repositoryCheckouts(folder);
  if (checkouts.length === 0) return;
  const targetFile = authFile(folder);
  const target = yield* readAuth(targetFile);
  const sources = [];
  for (const checkout of checkouts) {
    const source = yield* readAuth(authFile(checkout));
    if (source !== null) sources.push(source);
  }
  // The most recently written file holds the freshest tokens for its servers.
  const ranked = [...sources, ...(target === null ? [] : [target])].toSorted(
    (left, right) => right.modifiedAt - left.modifiedAt,
  );
  const next: JsonObject = { ...target?.entries };
  let changed = false;
  const taken = new Set<string>();
  for (const file of ranked) {
    for (const [server, entry] of Object.entries(file.entries)) {
      if (taken.has(server) || !hasTokens(entry)) continue;
      taken.add(server);
      if (file === target) continue;
      next[server] = normalizedAuthEntry(entry);
      changed = true;
    }
  }
  if (!changed) return;
  const temporaryFile = `${targetFile}.ctrl.tmp`;
  yield* fileSystem.makeDirectory(path.dirname(targetFile), { recursive: true, mode: 0o700 });
  // @effect-diagnostics-next-line preferSchemaOverJson:off - Cursor's own file format.
  yield* fileSystem.writeFileString(temporaryFile, JSON.stringify(next), { mode: 0o600 });
  yield* fileSystem.rename(temporaryFile, targetFile);
});

interface CursorFolderState {
  loaded: boolean;
  /** Servers needing sign-in at the last check before the folder loaded. */
  needsSignInBeforeLoad: ReadonlySet<string>;
  /** Servers that needed sign-in when the folder loaded. */
  needsSignInAtLoad: ReadonlySet<string> | null;
  readonly signedInAfterLoad: Set<string>;
}

/**
 * The Cursor SDK caches each folder's MCP sign-ins in a process-wide map the
 * first time an agent opens there, and never re-reads them. This mirrors that
 * cache's lifetime, so it is process-wide too: a sign-in finished after the
 * folder loaded only reaches Cursor threads after Ctrl restarts.
 */
const cursorFolders = new Map<string, CursorFolderState>();

const folderState = (folder: string): CursorFolderState => {
  let state = cursorFolders.get(folder);
  if (state === undefined) {
    state = {
      loaded: false,
      needsSignInBeforeLoad: new Set(),
      needsSignInAtLoad: null,
      signedInAfterLoad: new Set(),
    };
    cursorFolders.set(folder, state);
  }
  return state;
};

/** Called when a Cursor agent opens in a folder. */
export function markCursorFolderLoaded(folder: string): void {
  const state = folderState(folder);
  if (state.loaded) return;
  state.loaded = true;
  state.needsSignInAtLoad = state.needsSignInBeforeLoad;
}

const recordCursorFolderCheck = (
  folder: string,
  entries: ReadonlyArray<CursorMcpListEntry>,
): void => {
  const state = folderState(folder);
  if (state.loaded) return;
  state.needsSignInBeforeLoad = new Set(
    entries.filter((entry) => entry.status === "needs_sign_in").map((entry) => entry.name),
  );
};

const cursorServerNeedsRelaunch = (folder: string, name: string): boolean => {
  const state = cursorFolders.get(folder);
  if (state === undefined || !state.loaded) return false;
  return state.signedInAfterLoad.has(name) || (state.needsSignInAtLoad?.has(name) ?? false);
};

/** Test-only reset of the process-wide folder cache. */
export function resetCursorMcpFolderCacheForTest(): void {
  cursorFolders.clear();
}

/** Status as Cursor sees it; the server adds whether it can restart itself. */
export type CursorMcpFolderStatus = Omit<CursorMcpStatusResult, "canRestartServer">;

export class CursorMcpServers extends Context.Service<
  CursorMcpServers,
  {
    /** `folder` is null for user-level servers only. */
    readonly status: (
      folder: string | null,
      options?: { readonly shareSignIns?: boolean },
    ) => Effect.Effect<CursorMcpFolderStatus, CursorMcpOperationError>;
    readonly signIn: (
      folder: string | null,
      name: string,
    ) => Effect.Effect<CursorMcpFolderStatus, CursorMcpOperationError>;
    readonly saveServer: (
      input: CursorMcpSaveServerInput,
    ) => Effect.Effect<void, CursorMcpOperationError>;
    readonly removeServer: (name: string) => Effect.Effect<void, CursorMcpOperationError>;
  }
>()("@t3tools/provider-cursor/server/CursorMcpServers") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;

  const userConfigPath = path.join(homeDirectory, ".cursor", "mcp.json");
  // The installer drops the CLI in ~/.local/bin, which a GUI app's PATH often lacks.
  const cliCandidates = ["cursor-agent", path.join(homeDirectory, ".local", "bin", "cursor-agent")];

  const runCli = Effect.fn("CursorMcpServers.runCli")(function* (
    args: ReadonlyArray<string>,
    cwd: string,
    timeout: Duration.Duration,
  ) {
    for (const binary of cliCandidates) {
      const result: Option.Option<CommandResult | "missing"> = yield* Effect.gen(function* () {
        const spawnCommand = yield* resolveSpawnCommand(binary, args, { env: environment });
        return yield* spawnAndCollect(
          binary,
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd,
            env: environment,
            shell: spawnCommand.shell,
          }),
        );
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.timeoutOption(timeout),
        Effect.catch((cause) =>
          isCommandMissingCause(cause)
            ? Effect.succeedSome("missing" as const)
            : Effect.fail(new CursorMcpOperationError({ reason: "command_failed", cause })),
        ),
      );
      if (Option.isNone(result)) {
        return yield* new CursorMcpOperationError({ reason: "command_failed" });
      }
      if (result.value !== "missing") return Option.some(result.value);
    }
    return Option.none();
  });

  const shareSignInsQuietly = (folder: string) =>
    shareCursorMcpSignIns(folder).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Environment, environment),
      Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
      Effect.catch((cause) =>
        Effect.logWarning("Could not share Cursor MCP sign-ins with this folder.", { cause }),
      ),
    );

  const readConfig = Effect.fn("CursorMcpServers.readConfig")(function* (configPath: string) {
    const text = yield* fileSystem.readFileString(configPath).pipe(Effect.option);
    if (Option.isNone(text)) return { config: null, invalid: false } as const;
    const parsed = decodeJson(text.value);
    return Option.isSome(parsed) && isJsonObject(parsed.value)
      ? ({ config: parsed.value, invalid: false } as const)
      : ({ config: null, invalid: true } as const);
  });

  const writeUserConfig = Effect.fn("CursorMcpServers.writeUserConfig")(function* (
    config: JsonObject,
  ) {
    const temporaryPath = `${userConfigPath}.ctrl.tmp`;
    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(path.dirname(userConfigPath), { recursive: true });
      // @effect-diagnostics-next-line preferSchemaOverJson:off - a hand-edited file keeps Cursor's indentation.
      yield* fileSystem.writeFileString(temporaryPath, `${JSON.stringify(config, null, 2)}\n`);
      yield* fileSystem.rename(temporaryPath, userConfigPath);
    }).pipe(
      Effect.mapError((cause) => new CursorMcpOperationError({ reason: "command_failed", cause })),
    );
  });

  const editUserConfig = Effect.fn("CursorMcpServers.editUserConfig")(function* (
    edit: (config: JsonObject) => JsonObject | "server_exists" | "server_not_found",
  ) {
    const current = yield* readConfig(userConfigPath);
    if (current.invalid) {
      return yield* new CursorMcpOperationError({ reason: "config_invalid" });
    }
    const next = edit(current.config ?? {});
    if (typeof next === "string") {
      return yield* new CursorMcpOperationError({ reason: next });
    }
    yield* writeUserConfig(next);
  });

  const status = Effect.fn("CursorMcpServers.status")(function* (
    folder: string | null,
    options?: { readonly shareSignIns?: boolean },
  ) {
    if (folder !== null && options?.shareSignIns === true) {
      yield* shareSignInsQuietly(folder);
    }
    const user = yield* readConfig(userConfigPath);
    const project =
      folder === null
        ? { config: null, invalid: false }
        : yield* readConfig(path.join(folder, ".cursor", "mcp.json"));
    const listed = yield* runCli(["mcp", "list"], folder ?? homeDirectory, LIST_TIMEOUT);
    // A failed list (logged out, crashed) prints errors shaped like entries.
    const listSucceeded = Option.isSome(listed) && listed.value.code === 0;
    const listEntries =
      Option.isSome(listed) && listSucceeded ? parseCursorMcpList(listed.value.stdout) : [];
    if (folder !== null && listSucceeded) recordCursorFolderCheck(folder, listEntries);

    const servers = new Map<string, CursorMcpServer>();
    const addConfigured = (
      entries: ReadonlyArray<CursorMcpConfigEntry>,
      source: CursorMcpServerSource,
    ) => {
      for (const entry of entries) {
        servers.set(entry.name, {
          name: entry.name,
          source,
          transport: entry.transport,
          status: "unknown",
          statusDetail: null,
          needsRelaunch: false,
        });
      }
    };
    addConfigured(cursorMcpConfigEntries(user.config), "user");
    addConfigured(cursorMcpConfigEntries(project.config), "project");
    for (const entry of listEntries) {
      const configured = servers.get(entry.name);
      const needsRelaunch =
        folder !== null &&
        entry.status === "ready" &&
        cursorServerNeedsRelaunch(folder, entry.name);
      servers.set(entry.name, {
        name: entry.name,
        source: configured?.source ?? null,
        transport: configured?.transport ?? null,
        status: entry.status,
        statusDetail: entry.detail,
        needsRelaunch,
      });
    }
    return {
      cliAvailable: Option.isSome(listed),
      installCommand: CURSOR_CLI_INSTALL_COMMAND,
      folder,
      folderLoaded: folder !== null && (cursorFolders.get(folder)?.loaded ?? false),
      servers: [...servers.values()],
      userConfigError: user.invalid ? "~/.cursor/mcp.json is not valid JSON." : null,
    } satisfies CursorMcpFolderStatus;
  });

  const signIn = Effect.fn("CursorMcpServers.signIn")(function* (
    folder: string | null,
    name: string,
  ) {
    const cwd = folder ?? homeDirectory;
    let attempts = 0;
    while (attempts < 2) {
      attempts += 1;
      const result = yield* runCli(["mcp", "login", name], cwd, SIGN_IN_TIMEOUT);
      if (Option.isNone(result)) {
        return yield* new CursorMcpOperationError({ reason: "cli_missing" });
      }
      if (result.value.code !== 0) {
        return yield* new CursorMcpOperationError({ reason: "sign_in_failed" });
      }
      if (!SIGN_IN_RERUN_PATTERN.test(`${result.value.stdout}\n${result.value.stderr}`)) break;
    }
    if (folder !== null) {
      const state = cursorFolders.get(folder);
      if (state?.loaded) state.signedInAfterLoad.add(name);
    }
    return yield* status(folder);
  });

  return CursorMcpServers.of({
    status,
    signIn,
    saveServer: (input) => editUserConfig((config) => saveCursorMcpEntry(config, input)),
    removeServer: (name) => editUserConfig((config) => removeCursorMcpEntry(config, name)),
  });
});

export const layer = Layer.effect(CursorMcpServers, make);
