/**
 * ClaudeSkills — filesystem discovery of Claude Code skills for the `$` picker.
 *
 * Claude Code loads skills from `<config dir>/skills` (user scope),
 * `<cwd>/.claude/skills` (project scope), and every enabled installed plugin,
 * one directory per skill with a `SKILL.md` carrying YAML frontmatter. The
 * user root wins on name collisions, matching the CLI. Plugin skills are
 * namespaced `<plugin>:<skill>`, so they never collide. `.agents/skills` is a
 * Codex location: verified against the CLI, a skill that lives only there is
 * answered with `Unknown command`, so it is not scanned here.
 * The Agent SDK init handshake surfaces skills only as slash commands without
 * their filesystem paths, so the provider snapshot scans the same locations
 * directly, mirroring how the Codex app-server reports its skills.
 *
 * @module provider/Drivers/ClaudeSkills
 */

import type { ClaudeSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

type ClaudeSkillScope = "user" | "project" | "plugin";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | {
      readonly kind: "parsed";
      readonly description?: string;
      readonly userInvocationOnly?: boolean;
      readonly userInvocable?: boolean;
    };

/**
 * Claude Code accepts the YAML 1.1 boolean spellings (`yes`/`no`, `on`/`off`,
 * `1`/`0`), which the 1.2 core schema this parser uses leaves as strings and
 * numbers. Verified against the CLI: a skill carrying `user-invocable: no` is
 * absent from its published slash commands, so a strict `=== false` here would
 * offer a command the CLI rejects.
 */
function parseFrontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return value === 1 ? true : value === 0 ? false : undefined;
  }
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
    case "y":
      return true;
    case "false":
    case "no":
    case "off":
    case "n":
      return false;
    default:
      return undefined;
  }
}

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  const frontmatter = match[1] ?? "";
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(frontmatter);
  } catch {
    // Claude Code accepts plain scalars containing `: `. Repair only those,
    // leaving comments and YAML structure for the full-document parser.
    const repaired = frontmatter.replace(
      /^([\w-]+:[ \t]*)([^\r\n]*)/gm,
      (line, prefix: string, value: string) => {
        const scalar = value.split(/[ \t]+#/)[0] ?? "";
        if (!/:[ \t]/.test(scalar) || /^(?:["'[\]{}|>&*!#%@`]|[-?:](?:[ \t]|$))/.test(scalar)) {
          return line;
        }
        return `${prefix}${JSON.stringify(scalar)}${value.slice(scalar.length)}`;
      },
    );
    try {
      parsed = parseYamlDocument(repaired);
    } catch {
      return { kind: "malformed" };
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    ...(description ? { description } : {}),
    ...(parseFrontmatterBoolean(record["disable-model-invocation"]) === true
      ? { userInvocationOnly: true }
      : {}),
    ...(parseFrontmatterBoolean(record["user-invocable"]) === false
      ? { userInvocable: false }
      : {}),
  };
}

/**
 * Where an administrator installs the policy file whose settings outrank every
 * user and project one. Absent on almost every machine, which is why a missing
 * file is the normal case rather than an error.
 */
function claudeManagedSettingsPath(
  path: Path.Path,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  if (platform === "win32") {
    const programData = environment.PROGRAMDATA?.trim();
    return programData ? path.join(programData, "ClaudeCode", "managed-settings.json") : undefined;
  }
  return "/etc/claude-code/managed-settings.json";
}

/**
 * Settings files Claude Code merges for `skillOverrides`, in increasing
 * precedence: user, project, project-local, then the administrator's managed
 * policy, which wins outright. When the workspace sits inside a git
 * repository, the repository root's `settings.local.json` is read too and
 * outranks the workspace's own local file. Verified against the CLI from a
 * nested cwd: a root local file switching a skill off wins over a cwd one
 * switching it on, the root's plain `settings.json` is not consulted, and
 * without a `.git` above the cwd no root file is read. A skill the user
 * switched off is reported disabled rather than dropped, so the picker can
 * grey it out instead of silently losing it.
 */
export function skillOverrideSettingsPaths(
  path: Path.Path,
  configDirPath: string,
  cwd: string | undefined,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  repositoryRoot?: string,
): ReadonlyArray<string> {
  const managedPath = claudeManagedSettingsPath(path, platform, environment);
  const root = repositoryRoot !== undefined && repositoryRoot !== cwd ? repositoryRoot : undefined;
  return [
    path.join(configDirPath, "settings.json"),
    ...(cwd
      ? [
          path.join(cwd, ".claude", "settings.json"),
          path.join(cwd, ".claude", "settings.local.json"),
        ]
      : []),
    ...(root ? [path.join(root, ".claude", "settings.local.json")] : []),
    ...(managedPath ? [managedPath] : []),
  ];
}

/**
 * Nearest ancestor of `cwd` (inclusive) holding a `.git` entry, which is the
 * boundary Claude Code walks up to for project settings. `undefined` outside
 * a repository.
 */
const findRepositoryRoot = Effect.fn("findRepositoryRoot")(function* (
  cwd: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.resolve(cwd);
  while (true) {
    const isRoot = yield* fileSystem
      .exists(path.join(current, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (isRoot) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
});

/**
 * The four states Claude Code accepts. The CLI validates the whole map, not
 * each entry: verified against it, one entry with an unknown value (or a
 * boolean) makes it drop every override in that file, so this schema does the
 * same rather than applying the valid siblings the CLI ignores.
 */
const SkillOverrideValue = Schema.Literals(["on", "name-only", "user-invocable-only", "off"]);

// Lenient because these settings files are hand-edited and Claude Code itself
// tolerates comments and trailing commas in them.
const SkillOverrideSettings = fromLenientJson(
  Schema.Struct({
    skillOverrides: Schema.optional(Schema.Record(Schema.String, SkillOverrideValue)),
  }),
);
const decodeSkillOverrideSettings = Schema.decodeUnknownEffect(SkillOverrideSettings);

// Decoded apart from `skillOverrides` so one bad override never hides the
// user's plugins. Only a literal `true` enables a plugin.
const EnabledPluginsSettings = fromLenientJson(
  Schema.Struct({
    enabledPlugins: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const decodeEnabledPluginsSettings = Schema.decodeUnknownEffect(EnabledPluginsSettings);

/**
 * What a `skillOverrides` entry says about one skill. `"user-invocable-only"`
 * hides it from the agent exactly as `disable-model-invocation` does, so it is
 * kept apart from a plain on/off decision rather than collapsed into one.
 */
type SkillOverride = {
  readonly enabled: boolean;
  readonly userInvocationOnly: boolean;
};

function parseSkillOverride(value: typeof SkillOverrideValue.Type): SkillOverride {
  switch (value) {
    case "off":
      return { enabled: false, userInvocationOnly: false };
    case "user-invocable-only":
      return { enabled: true, userInvocationOnly: true };
    case "on":
    case "name-only":
      return { enabled: true, userInvocationOnly: false };
  }
}

interface ClaudeSkillSettings {
  readonly skillOverrides: ReadonlyMap<string, SkillOverride>;
  /** `enabledPlugins` merged across the same files, later files winning per key. */
  readonly enabledPlugins: ReadonlyMap<string, boolean>;
  readonly repositoryRoot: string | undefined;
}

const readSkillSettings = Effect.fn("readSkillSettings")(function* (
  configDirPath: string,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ClaudeSkillSettings, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const overridesByName = new Map<string, SkillOverride>();
  const enabledPlugins = new Map<string, boolean>();
  const repositoryRoot = cwd === undefined ? undefined : yield* findRepositoryRoot(cwd);

  for (const settingsPath of skillOverrideSettingsPaths(
    path,
    configDirPath,
    cwd,
    platform,
    environment,
    repositoryRoot,
  )) {
    const contents = yield* fileSystem
      .readFileString(settingsPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) {
      continue;
    }

    const plugins = yield* decodeEnabledPluginsSettings(contents).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    for (const [pluginKey, value] of Object.entries(plugins?.enabledPlugins ?? {})) {
      enabledPlugins.set(pluginKey, value === true);
    }

    const parsed = yield* decodeSkillOverrideSettings(contents).pipe(
      Effect.tapError((cause) =>
        Effect.logDebug("claude settings file is unreadable; ignoring skillOverrides", {
          path: settingsPath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    const overrides = parsed?.skillOverrides;
    if (!overrides) {
      continue;
    }

    for (const [name, value] of Object.entries(overrides)) {
      overridesByName.set(name, parseSkillOverride(value));
    }
  }

  return { skillOverrides: overridesByName, enabledPlugins, repositoryRoot };
});

const InstalledPluginEntry = Schema.Struct({
  installPath: Schema.String,
  projectPath: Schema.optional(Schema.String),
});

/**
 * `<config dir>/plugins/installed_plugins.json`, keyed `<plugin>@<marketplace>`.
 * Version 2 holds an array of installs per key (one per user/project scope);
 * version 1 held a single install, so both shapes are accepted.
 */
const InstalledPlugins = fromLenientJson(
  Schema.Struct({
    plugins: Schema.Record(
      Schema.String,
      Schema.Union([Schema.Array(InstalledPluginEntry), InstalledPluginEntry]),
    ),
  }),
);
const decodeInstalledPlugins = Schema.decodeUnknownEffect(InstalledPlugins);

/** A manifest's `skills`: one path or several, relative to the plugin root. */
const PluginSkillPaths = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

const PluginManifest = fromLenientJson(
  Schema.Struct({
    name: Schema.optional(Schema.String),
    skills: Schema.optional(PluginSkillPaths),
  }),
);
const decodePluginManifest = Schema.decodeUnknownEffect(PluginManifest);

const KnownMarketplaces = fromLenientJson(
  Schema.Record(Schema.String, Schema.Struct({ installLocation: Schema.optional(Schema.String) })),
);
const decodeKnownMarketplaces = Schema.decodeUnknownEffect(KnownMarketplaces);

const MarketplaceManifest = fromLenientJson(
  Schema.Struct({
    plugins: Schema.Array(
      Schema.Struct({ name: Schema.String, skills: Schema.optional(PluginSkillPaths) }),
    ),
  }),
);
const decodeMarketplaceManifest = Schema.decodeUnknownEffect(MarketplaceManifest);

/** A directory holding a `SKILL.md`, with the name Claude Code publishes it under. */
interface SkillCandidate {
  readonly directory: string;
  readonly name: string;
  readonly scope: ClaudeSkillScope;
}

const readJsonFile = <A, E>(
  filePath: string,
  decode: (contents: string) => Effect.Effect<A, E>,
): Effect.Effect<A | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const contents = yield* fileSystem
      .readFileString(filePath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) return undefined;
    return yield* decode(contents).pipe(Effect.orElseSucceed(() => undefined));
  });

/** Skill directories one level below `directory`, named by their directory. */
const listSkillDirectories = Effect.fn("listSkillDirectories")(function* (
  directory: string,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  return [...entries]
    .sort()
    .filter((entry) => entry.trim().length > 0)
    .map((entry) => path.join(directory, entry));
});

/**
 * The `skills` paths a plugin declares, from its own manifest or, for a
 * marketplace entry marked `strict: false`, from the marketplace listing.
 * Verified against the CLI: `example-skills@anthropic-agent-skills` installs
 * the whole repository but publishes only the twelve skills its marketplace
 * entry lists, so declared paths replace the default `skills/` scan.
 */
const readDeclaredPluginSkillPaths = Effect.fn("readDeclaredPluginSkillPaths")(function* (
  configDirPath: string,
  pluginKey: string,
  manifestSkills: typeof PluginSkillPaths.Type | undefined,
): Effect.fn.Return<ReadonlyArray<string> | undefined, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const toArray = (value: typeof PluginSkillPaths.Type) =>
    typeof value === "string" ? [value] : value;
  if (manifestSkills !== undefined) {
    return toArray(manifestSkills);
  }
  const atIndex = pluginKey.lastIndexOf("@");
  if (atIndex <= 0) {
    return undefined;
  }
  const pluginName = pluginKey.slice(0, atIndex);
  const marketplaceName = pluginKey.slice(atIndex + 1);
  const knownMarketplaces = yield* readJsonFile(
    path.join(configDirPath, "plugins", "known_marketplaces.json"),
    decodeKnownMarketplaces,
  );
  const marketplaceLocation =
    knownMarketplaces?.[marketplaceName]?.installLocation ??
    path.join(configDirPath, "plugins", "marketplaces", marketplaceName);
  const marketplace = yield* readJsonFile(
    path.join(marketplaceLocation, ".claude-plugin", "marketplace.json"),
    decodeMarketplaceManifest,
  );
  const entrySkills = marketplace?.plugins.find((entry) => entry.name === pluginName)?.skills;
  return entrySkills === undefined ? undefined : toArray(entrySkills);
});

/**
 * Skills of installed plugins enabled for `cwd`. An install recorded with a
 * `projectPath` only applies inside that project. Skills are published as
 * `<plugin>:<skill>`, where `<plugin>` is the manifest's `name`, falling back
 * to the plugin part of the `<plugin>@<marketplace>` key.
 */
const discoverClaudePluginSkillCandidates = Effect.fn("discoverClaudePluginSkillCandidates")(
  function* (
    configDirPath: string,
    cwd: string | undefined,
    settings: ClaudeSkillSettings,
  ): Effect.fn.Return<ReadonlyArray<SkillCandidate>, never, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const contents = yield* fileSystem
      .readFileString(path.join(configDirPath, "plugins", "installed_plugins.json"))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) {
      return [];
    }
    const installed = yield* decodeInstalledPlugins(contents).pipe(
      Effect.tapError((cause) =>
        Effect.logDebug("claude installed_plugins.json is unreadable; ignoring plugins", { cause }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    if (!installed) {
      return [];
    }

    const projectPaths = new Set(
      [cwd, settings.repositoryRoot].flatMap((value) => (value ? [path.resolve(value)] : [])),
    );
    const hasSkillFile = (directory: string) =>
      fileSystem.exists(path.join(directory, "SKILL.md")).pipe(Effect.orElseSucceed(() => false));
    const candidates: Array<SkillCandidate> = [];
    for (const [pluginKey, installs] of Object.entries(installed.plugins)) {
      if (settings.enabledPlugins.get(pluginKey) !== true) {
        continue;
      }
      const install = (Array.isArray(installs) ? installs : [installs]).find(
        (entry) =>
          entry.projectPath === undefined || projectPaths.has(path.resolve(entry.projectPath)),
      );
      if (!install) {
        continue;
      }
      const root = install.installPath;
      const manifest = yield* readJsonFile(
        path.join(root, ".claude-plugin", "plugin.json"),
        decodePluginManifest,
      );
      const atIndex = pluginKey.lastIndexOf("@");
      const pluginName = (
        manifest?.name ?? (atIndex > 0 ? pluginKey.slice(0, atIndex) : pluginKey)
      ).trim();
      if (!pluginName) {
        continue;
      }

      const declaredPaths = yield* readDeclaredPluginSkillPaths(
        configDirPath,
        pluginKey,
        manifest?.skills,
      );
      // Each declared path is either one skill directory or a directory of them.
      const skillDirectories: Array<string> = [];
      for (const declared of declaredPaths ?? ["skills"]) {
        const directory = path.resolve(root, declared);
        if (declaredPaths !== undefined && (yield* hasSkillFile(directory))) {
          skillDirectories.push(directory);
        } else {
          skillDirectories.push(...(yield* listSkillDirectories(directory)));
        }
      }
      for (const directory of skillDirectories) {
        candidates.push({
          directory,
          name: `${pluginName}:${path.basename(directory)}`,
          scope: "plugin",
        });
      }
      // A plugin that is a single skill keeps its `SKILL.md` at the root and is
      // published under the plugin's own name (`humanizer:humanizer`).
      if (skillDirectories.length === 0 && (yield* hasSkillFile(root))) {
        candidates.push({ directory: root, name: `${pluginName}:${pluginName}`, scope: "plugin" });
      }
    }
    return candidates;
  },
);

/**
 * Resolve the Claude config directory the CLI would use, matching the
 * precedence the spawned CLI sees: the instance's `homePath` (exported as
 * `CLAUDE_CONFIG_DIR` by `makeClaudeEnvironment`), then a `CLAUDE_CONFIG_DIR`
 * already present in the process environment, then `~/.claude`.
 */
const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath, home));
  }
  // No tilde expansion here: the spawned CLI receives this env var verbatim
  // (env vars are never shell-expanded), so a literal `~` must stay literal
  // for discovery to scan the same directory the runtime would. A relative
  // value is resolved against the workspace cwd — the subprocess's own cwd —
  // for the same reason.
  const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir);
  }
  return path.join(home, ".claude");
});

/**
 * Enumerate Claude Code skills from the user config dir, the workspace
 * `.claude/skills`, and enabled installed plugins. Discovery is best-effort:
 * unreadable roots and malformed skill entries are skipped so a broken skill
 * never degrades the provider snapshot. Roots are listed highest precedence first and the first hit for a
 * name wins, matching Claude Code: verified against the CLI with the same
 * skill name in both scopes, the user copy is the one that runs. Reporting the
 * project copy instead would attach its invocation metadata to a command
 * Claude Code resolves elsewhere.
 */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment ?? process.env, cwd);
  const settings = yield* readSkillSettings(configDirPath, cwd, environment ?? process.env);
  const skillOverrides = settings.skillOverrides;
  const directoryCandidates = (directory: string, scope: ClaudeSkillScope) =>
    listSkillDirectories(directory).pipe(
      Effect.map((directories) =>
        directories.map((skillDirectory) => ({
          directory: skillDirectory,
          name: path.basename(skillDirectory).trim(),
          scope,
        })),
      ),
    );

  // Claude Code identifies a skill by its directory, not by the frontmatter
  // `name`: verified against the CLI, a skill in `probe-alias/` declaring
  // `name: probe-alias-frontmatter` is published as `probe-alias`, and only
  // `skillOverrides["probe-alias"]` switches it off. Keying off the
  // frontmatter name would report a command that does not exist and miss the
  // override that disables it.
  const candidates: ReadonlyArray<SkillCandidate> = [
    ...(yield* directoryCandidates(path.join(configDirPath, "skills"), "user")),
    ...(cwd ? yield* directoryCandidates(path.join(cwd, ".claude", "skills"), "project") : []),
    ...(yield* discoverClaudePluginSkillCandidates(configDirPath, cwd, settings)),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const candidate of candidates) {
    const name = candidate.name;
    // First root wins, so a later root never displaces a higher-precedence
    // skill of the same name.
    if (!name || skillsByName.has(name)) {
      continue;
    }

    const skillPath = path.join(candidate.directory, "SKILL.md");
    const contents = yield* fileSystem
      .readFileString(skillPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) {
      continue;
    }

    const frontmatter = parseSkillFrontmatter(contents);
    // Malformed frontmatter means the skill won't load in Claude Code
    // either — skip it rather than surfacing a broken entry under its
    // directory name.
    if (frontmatter.kind === "malformed") {
      continue;
    }

    const override = skillOverrides.get(name);
    const userInvocationOnly =
      (frontmatter.kind === "parsed" && frontmatter.userInvocationOnly === true) ||
      override?.userInvocationOnly === true;
    skillsByName.set(name, {
      name,
      path: skillPath,
      enabled: override?.enabled ?? true,
      scope: candidate.scope,
      ...(frontmatter.kind === "parsed" && frontmatter.description
        ? { description: frontmatter.description }
        : {}),
      ...(userInvocationOnly ? { userInvocationOnly: true } : {}),
      ...(frontmatter.kind === "parsed" && frontmatter.userInvocable === false
        ? { userInvocable: false }
        : {}),
    });
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
