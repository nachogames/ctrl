import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Scope from "effect/Scope";

import * as CursorMcpServers from "./CursorMcpServers.ts";

// A stand-in for Cursor's CLI: `mcp list` prints $HOME/status.txt, and the first
// `mcp login` asks to be re-run, like the real CLI after receiving the OAuth code.
const FAKE_CLI = `#!/bin/sh
if [ "$1 $2" = "mcp list" ]; then
  if [ -f "$HOME/list-fails" ]; then echo "Error: Authentication required, run cursor-agent login" >&2; exit 1; fi
  cat "$HOME/status.txt"; exit 0
fi
if [ "$1 $2" = "mcp login" ]; then
  echo "$3" >> "$HOME/logins.txt"
  if [ ! -f "$HOME/half-done" ]; then
    touch "$HOME/half-done"
    echo "Received authorization code. Re-running the command should now complete authentication."
    exit 0
  fi
  rm "$HOME/half-done"
  sed "s/^$3: .*/$3: ready/" "$HOME/status.txt" > "$HOME/status.next" && mv "$HOME/status.next" "$HOME/status.txt"
  echo "MCP login successful"
  exit 0
fi
exit 1
`;

const setup = Effect.fn("setupCursorMcpTest")(function* (options: { readonly cli: boolean }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const makeDirectory = (prefix: string) =>
    fileSystem
      .makeTempDirectoryScoped({ directory: NodeOS.tmpdir(), prefix })
      .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
  const home = yield* makeDirectory("cursor-mcp-home-");
  const folder = yield* makeDirectory("cursor-mcp-folder-");
  if (options.cli) {
    const binary = path.join(home, ".local", "bin", "cursor-agent");
    yield* fileSystem.makeDirectory(path.dirname(binary), { recursive: true });
    yield* fileSystem.writeFileString(binary, FAKE_CLI);
    yield* fileSystem.chmod(binary, 0o755);
  }
  const userConfig = path.join(home, ".cursor", "mcp.json");
  const writeJson = (file: string, value: unknown) =>
    fileSystem
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.andThen(fileSystem.writeFileString(file, JSON.stringify(value, null, 2))));
  const service = yield* CursorMcpServers.CursorMcpServers.pipe(
    Effect.provide(CursorMcpServers.layer),
    Effect.provideService(HostProcess.HomeDirectory, home),
    // No PATH entry holds a real cursor-agent, so only the fake in ~/.local/bin runs.
    Effect.provideService(HostProcess.Environment, { HOME: home, PATH: "/usr/bin:/bin" }),
  );
  return {
    service,
    home,
    folder,
    userConfig,
    writeJson,
    writeStatus: (text: string) => fileSystem.writeFileString(path.join(home, "status.txt"), text),
    readUserConfig: fileSystem.readFileString(userConfig),
    projectConfig: path.join(folder, ".cursor", "mcp.json"),
  };
});

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);

// The fake CLI is a shell script.
const describePosix = HostProcess.Platform.defaultValue() === "win32" ? describe.skip : describe;

describePosix("CursorMcpServers", () => {
  afterEach(() => CursorMcpServers.resetCursorMcpFolderCacheForTest());

  it("merges both config files with the CLI's status, including servers no file declares", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup({ cli: true });
        yield* test.writeJson(test.userConfig, {
          mcpServers: { linear: { url: "https://mcp.linear.app/mcp" } },
        });
        yield* test.writeJson(test.projectConfig, {
          mcpServers: { repro: { command: "node", args: ["server.mjs"] } },
        });
        yield* test.writeStatus(
          "\u001b[32mlinear: requires_authentication\u001b[0m\nrepro: Error: Connection failed\nplugin-slack: ready\n",
        );

        const status = yield* test.service.status(test.folder);

        expect(status.cliAvailable).toBe(true);
        expect(status.folderLoaded).toBe(false);
        expect(status.servers).toEqual([
          {
            name: "linear",
            source: "user",
            transport: { _tag: "url", url: "https://mcp.linear.app/mcp" },
            status: "needs_sign_in",
            statusDetail: "requires_authentication",
            needsRelaunch: false,
          },
          {
            name: "repro",
            source: "project",
            transport: { _tag: "command", command: "node", args: ["server.mjs"] },
            status: "error",
            statusDetail: "Error: Connection failed",
            needsRelaunch: false,
          },
          {
            name: "plugin-slack",
            source: null,
            transport: null,
            status: "ready",
            statusDetail: null,
            needsRelaunch: false,
          },
        ]);
      }),
    ));

  it("re-runs sign-in when the CLI asks, and needs no relaunch for a folder not yet loaded", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup({ cli: true });
        yield* test.writeStatus("linear: requires_authentication\n");

        const status = yield* test.service.signIn(test.folder, "linear");

        expect(status.servers).toMatchObject([
          { name: "linear", status: "ready", needsRelaunch: false },
        ]);
      }),
    ));

  it("asks for a relaunch when a loaded folder was signed out at load time", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup({ cli: true });
        yield* test.writeStatus("linear: requires_authentication\nfigma: ready\n");
        yield* test.service.status(test.folder);
        CursorMcpServers.markCursorFolderLoaded(test.folder);
        // Signed in from a terminal while the folder stays loaded.
        yield* test.writeStatus("linear: ready\nfigma: ready\n");

        const status = yield* test.service.status(test.folder);

        expect(status.folderLoaded).toBe(true);
        expect(status.servers).toMatchObject([
          { name: "linear", status: "ready", needsRelaunch: true },
          { name: "figma", status: "ready", needsRelaunch: false },
        ]);
      }),
    ));

  it("asks for a relaunch after signing in to a folder that is already loaded", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup({ cli: true });
        yield* test.writeStatus("figma: requires_authentication\n");
        CursorMcpServers.markCursorFolderLoaded(test.folder);

        const status = yield* test.service.signIn(test.folder, "figma");

        expect(status.servers).toMatchObject([
          { name: "figma", status: "ready", needsRelaunch: true },
        ]);
      }),
    ));

  it("reports no CLI statuses when listing fails, rather than reading its errors as servers", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup({ cli: true });
        const fileSystem = yield* FileSystem.FileSystem;
        yield* test.writeJson(test.userConfig, { mcpServers: { linear: { url: "https://x" } } });
        yield* fileSystem.writeFileString(`${test.home}/list-fails`, "");

        const status = yield* test.service.status(test.folder);

        expect(status.servers).toMatchObject([{ name: "linear", status: "unknown" }]);
      }),
    ));

  it("lists configured servers with unknown status when the CLI is missing", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup({ cli: false });
        yield* test.writeJson(test.userConfig, { mcpServers: { linear: { url: "https://x" } } });

        const status = yield* test.service.status(null);

        expect(status.cliAvailable).toBe(false);
        expect(status.installCommand).toBe(CursorMcpServers.CURSOR_CLI_INSTALL_COMMAND);
        expect(status.servers).toMatchObject([{ name: "linear", status: "unknown" }]);
        const failure = yield* test.service.signIn(null, "linear").pipe(Effect.flip);
        expect(failure.reason).toBe("cli_missing");
      }),
    ));

  it("edits one entry and keeps the rest of the file", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup({ cli: false });
        yield* test.writeJson(test.userConfig, {
          theme: "kept",
          mcpServers: {
            first: { command: "npx", args: ["a"], env: { TOKEN: "x" } },
            linear: { type: "sse", url: "https://old", headers: { A: "b" } },
            last: { url: "https://last" },
          },
        });

        yield* test.service.saveServer({
          name: "linear-work",
          previousName: "linear",
          transport: { _tag: "url", url: "https://mcp.linear.app/mcp" },
        });
        yield* test.service.saveServer({
          name: "added",
          transport: { _tag: "command", command: "uvx", args: ["tool"] },
        });
        yield* test.service.removeServer("last");

        expect(JSON.parse(yield* test.readUserConfig)).toEqual({
          theme: "kept",
          mcpServers: {
            first: { command: "npx", args: ["a"], env: { TOKEN: "x" } },
            "linear-work": {
              type: "sse",
              url: "https://mcp.linear.app/mcp",
              headers: { A: "b" },
            },
            added: { command: "uvx", args: ["tool"] },
          },
        });
        const duplicate = yield* test.service
          .saveServer({ name: "first", transport: { _tag: "url", url: "https://y" } })
          .pipe(Effect.flip);
        expect(duplicate.reason).toBe("server_exists");
      }),
    ));

  it("leaves an unreadable config file untouched", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup({ cli: false });
        const fileSystem = yield* FileSystem.FileSystem;
        yield* test.writeJson(test.userConfig, {});
        yield* fileSystem.writeFileString(test.userConfig, "{ not json");

        const failure = yield* test.service
          .saveServer({ name: "linear", transport: { _tag: "url", url: "https://x" } })
          .pipe(Effect.flip);

        expect(failure.reason).toBe("config_invalid");
        expect(yield* test.readUserConfig).toBe("{ not json");
        expect((yield* test.service.status(null)).userConfigError).not.toBeNull();
      }),
    ));
});

// Three folders Cursor knows, under a fake home with one user-level server.
const setupFolders = Effect.fn("setupCursorFolders")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const makeDirectory = (prefix: string) =>
    fileSystem
      .makeTempDirectoryScoped({ directory: NodeOS.tmpdir(), prefix })
      .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
  const home = yield* makeDirectory("cursor-share-home-");
  const first = yield* makeDirectory("cursor-share-first-");
  const second = yield* makeDirectory("cursor-share-second-");
  const target = yield* makeDirectory("cursor-share-target-");
  const writeJson = (file: string, value: unknown) =>
    fileSystem
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.andThen(fileSystem.writeFileString(file, JSON.stringify(value))));
  yield* writeJson(path.join(home, ".cursor", "mcp.json"), {
    mcpServers: {
      ember: { url: "https://ember.example/mcp" },
      linear: { url: "https://l.example" },
    },
  });
  const authFile = (folder: string) =>
    path.join(
      home,
      ".cursor",
      "projects",
      folder
        .replace(/[^a-zA-Z0-9]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, ""),
      "mcp-auth.json",
    );
  const writeAuth = Effect.fn("writeAuth")(function* (folder: string, value: unknown, at: number) {
    yield* writeJson(authFile(folder), value);
    yield* fileSystem.utimes(authFile(folder), at, at);
  });
  const readAuth = (folder: string) =>
    fileSystem.readFileString(authFile(folder)).pipe(Effect.map((text) => JSON.parse(text)));
  const share = (folder: string) =>
    CursorMcpServers.shareCursorMcpSignIns(folder).pipe(
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Environment, { HOME: home }),
    );
  return {
    first,
    second,
    target,
    authFile,
    writeAuth,
    readAuth,
    share,
    writeJson,
    fileSystem,
    path,
  };
});

const signIn = (token: string) => ({
  tokens: { access_token: token, refresh_token: `${token}-refresh` },
  clientInfo: { client_id: "ctrl" },
});

describePosix("shareCursorMcpSignIns", () => {
  afterEach(() => CursorMcpServers.resetCursorMcpFolderCacheForTest());

  it("gives a folder the newest sign-in for each user-level server from any folder", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setupFolders();
        yield* test.writeAuth(
          test.first,
          { ember: signIn("old"), linear: { access_token: "legacy" }, local: signIn("local") },
          1_000,
        );
        yield* test.writeAuth(test.second, { ember: signIn("new") }, 3_000);
        yield* test.writeAuth(test.target, { own: signIn("own") }, 2_000);

        yield* test.share(test.target);

        expect(yield* test.readAuth(test.target)).toEqual({
          own: signIn("own"),
          ember: signIn("new"),
          linear: { tokens: { access_token: "legacy" } },
        });
        const info = yield* test.fileSystem.stat(test.authFile(test.target));
        expect(info.mode & 0o777).toBe(0o600);
        // Data flows into the folder being opened, never back out.
        expect(yield* test.readAuth(test.first)).toEqual({
          ember: signIn("old"),
          linear: { access_token: "legacy" },
          local: signIn("local"),
        });
      }),
    ));

  it("keeps a folder's own sign-in when it is the newest", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setupFolders();
        yield* test.writeAuth(test.first, { ember: signIn("first") }, 1_000);
        yield* test.writeAuth(test.target, { ember: signIn("target") }, 2_000);

        yield* test.share(test.target);

        expect(yield* test.readAuth(test.target)).toEqual({ ember: signIn("target") });
      }),
    ));

  it("skips a server the folder's own config defines, so a project cannot take its tokens", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setupFolders();
        yield* test.writeAuth(
          test.first,
          { ember: signIn("ember"), linear: signIn("linear") },
          1_000,
        );
        yield* test.writeJson(test.path.join(test.target, ".cursor", "mcp.json"), {
          mcpServers: { ember: { url: "https://elsewhere.example/mcp" } },
        });

        yield* test.share(test.target);

        expect(yield* test.readAuth(test.target)).toEqual({ linear: signIn("linear") });
      }),
    ));

  it("leaves a folder Cursor already loaded alone, since Cursor would not read the change", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setupFolders();
        yield* test.writeAuth(test.first, { ember: signIn("first") }, 1_000);
        CursorMcpServers.markCursorFolderLoaded(test.target);

        yield* test.share(test.target);

        expect(yield* test.fileSystem.exists(test.authFile(test.target))).toBe(false);
      }),
    ));
});

describe("parseCursorMcpList", () => {
  it("keeps names with spaces and ignores lines that are not entries", () => {
    expect(
      CursorMcpServers.parseCursorMcpList("Loading…\nAsk 24G: requires_authentication\n\n"),
    ).toEqual([{ name: "Ask 24G", status: "needs_sign_in", detail: "requires_authentication" }]);
  });
});

describe("declaredIconUrl", () => {
  it("takes the first https icon a page declares and resolves it against the page", () => {
    const html = `<link rel="stylesheet" href="/a.css"><link rel="apple-touch-icon" href="/t.png">
      <link rel="alternate icon" type="image/png" href="/favicon.png"><link rel="icon" href="/x.svg">`;
    expect(CursorMcpServers.declaredIconUrl(html, "https://linear.app/")).toBe(
      "https://linear.app/favicon.png",
    );
    expect(
      CursorMcpServers.declaredIconUrl(
        '<link rel="icon" href="http://x.test/i.png">',
        "https://x.test/",
      ),
    ).toBeNull();
  });
});
