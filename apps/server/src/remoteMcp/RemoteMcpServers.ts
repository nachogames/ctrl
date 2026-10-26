import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  auth,
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  REMOTE_MCP_OAUTH_CALLBACK_PATH,
  REMOTE_MCP_SERVER_ID_PATTERN,
  RemoteMcpAuthMode,
  type RemoteMcpAddInput,
  type RemoteMcpConnectionState,
  RemoteMcpError,
  type RemoteMcpServer,
  type RemoteMcpServerList,
} from "@t3tools/contracts/remoteMcp";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const SECRET_NAME = "remote-mcp-servers";
/** Providers cap a tool name at 64 characters, and Claude spends 14 on `mcp__t3-code__`. */
const MAX_TOOL_NAME_LENGTH = 50;
const PENDING_AUTHORIZATION_TTL_MS = 15 * 60_000;
const TOOL_CALL_TIMEOUT_MS = 10 * 60_000;
const MAX_MESSAGE_LENGTH = 300;

const StoredServer = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  authMode: RemoteMcpAuthMode,
  bearerToken: Schema.optional(Schema.String),
  oauth: Schema.optional(
    Schema.Struct({
      redirectUrl: Schema.optional(Schema.String),
      clientInformation: Schema.optional(Schema.Unknown),
      tokens: Schema.optional(Schema.Unknown),
      // A sign-in in progress, kept apart from the working tokens until it succeeds and saved
      // rather than held in memory, so a server restart mid sign-in still completes it.
      pending: Schema.optional(
        Schema.Struct({
          state: Schema.String,
          expiresAt: Schema.Number,
          redirectUrl: Schema.String,
          codeVerifier: Schema.optional(Schema.String),
          clientInformation: Schema.optional(Schema.Unknown),
          // The saved registration was rejected, so this sign-in registers afresh.
          newClient: Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  ),
});
type StoredServer = typeof StoredServer.Type;
type OAuthState = NonNullable<StoredServer["oauth"]>;
type MutableStoredServer = { -readonly [K in keyof StoredServer]: StoredServer[K] };

const StoredServers = Schema.fromJsonString(Schema.Array(StoredServer));
const decodeStored = Schema.decodeUnknownEffect(StoredServers);
const encodeStored = Schema.encodeSync(StoredServers);

/** A remote tool as the t3-code MCP server advertises it. */
export interface ProxiedTool {
  readonly name: string;
  readonly serverId: string;
  readonly remoteName: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: Record<string, unknown> | undefined;
}

interface LiveServer {
  stored: MutableStoredServer;
  state: RemoteMcpConnectionState;
  message: string | undefined;
  tools: ReadonlyArray<ProxiedTool>;
  client: Client | undefined;
  connecting: Promise<void> | undefined;
  authorizationUrl: URL | undefined;
}

export class RemoteMcpServers extends Context.Service<
  RemoteMcpServers,
  {
    readonly list: Effect.Effect<RemoteMcpServerList>;
    readonly subscribe: Stream.Stream<RemoteMcpServerList>;
    readonly add: (input: RemoteMcpAddInput) => Effect.Effect<void, RemoteMcpError>;
    readonly authorize: (input: {
      readonly id: string;
      readonly callbackOrigin: string;
    }) => Effect.Effect<{ readonly authorizationUrl?: string }, RemoteMcpError>;
    readonly completeAuthorization: (input: {
      readonly state: string;
      readonly code: string;
    }) => Effect.Effect<{ readonly name: string }, RemoteMcpError>;
    readonly reconnect: (input: { readonly id: string }) => Effect.Effect<void, RemoteMcpError>;
    readonly remove: (input: { readonly id: string }) => Effect.Effect<void, RemoteMcpError>;
    /** Every tool any connected server offers, for registration on the t3-code server. */
    readonly tools: () => ReadonlyArray<ProxiedTool>;
    /** Signals that `tools()` may have changed, starting with one signal on subscribe. */
    readonly toolChanges: Stream.Stream<void>;
    readonly isVisible: (toolName: string) => boolean;
    /** The remote server's raw `tools/call` result. */
    readonly callTool: (
      toolName: string,
      args: Record<string, unknown> | undefined,
    ) => Effect.Effect<unknown, RemoteMcpError>;
  }
>()("t3/remoteMcp/RemoteMcpServers") {}

const describe = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text;
};

/** The SDK throws UnauthorizedError with an auth provider and a coded transport error without one. */
const isAuthFailure = (error: unknown) =>
  error instanceof UnauthorizedError ||
  (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403));

const remoteError = (message: string, serverId?: string) =>
  new RemoteMcpError({ message, ...(serverId === undefined ? {} : { serverId }) });

export const exposedToolName = (serverId: string, remoteName: string, digest: string) => {
  const name = `${serverId}_${remoteName}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return name.length <= MAX_TOOL_NAME_LENGTH
    ? name
    : `${name.slice(0, MAX_TOOL_NAME_LENGTH - 7)}_${digest.slice(0, 6)}`;
};

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * What clients see of a server's URL. Some hosted servers carry their key in
 * the path or query, and read-only clients can list servers.
 */
export const displayUrl = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

/** The reason an add request is unusable, or undefined when it is fine. */
export const invalidAddInput = (input: RemoteMcpAddInput): string | undefined => {
  if (!REMOTE_MCP_SERVER_ID_PATTERN.test(input.id)) {
    return "Use 1-16 lowercase letters, digits, or dashes for the id, starting with a letter.";
  }
  if (input.name.trim().length === 0) return "Enter a name.";
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    return "Enter a valid URL.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Use an http or https URL.";
  // Tokens would cross the network in the clear.
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    return "Use https, or http only for a server on this machine.";
  }
  if (input.authMode === "bearer" && (input.bearerToken ?? "").trim().length === 0) {
    return "Enter the bearer token the server expects.";
  }
  return undefined;
};

export const callbackUrl = (callbackOrigin: string) => {
  const origin = new URL(callbackOrigin);
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error("The callback origin must be http or https.");
  }
  return new URL(REMOTE_MCP_OAUTH_CALLBACK_PATH, origin.origin).href;
};

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const changes = yield* PubSub.sliding<void>(1);
  const toolChangesHub = yield* PubSub.sliding<void>(1);
  const servers = new Map<string, LiveServer>();
  let toolIndex = new Map<string, ProxiedTool>();
  let persisting: Promise<void> = Promise.resolve();
  const runSync = Effect.runSyncWith(yield* Effect.context<never>());
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  const notify = () => {
    runSync(PubSub.publish(changes, undefined));
  };

  const sha256 = (text: string) =>
    runPromise(
      crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(Effect.map(Hex.encode)),
    );

  const reindexTools = () => {
    const next = new Map<string, ProxiedTool>();
    for (const server of servers.values()) {
      for (const tool of server.tools) next.set(tool.name, tool);
    }
    toolIndex = next;
    runSync(PubSub.publish(toolChangesHub, undefined));
  };

  const setState = (server: LiveServer, state: RemoteMcpConnectionState, message?: string) => {
    server.state = state;
    server.message = message;
    notify();
  };

  // Writes queue behind each other so a slow write never lands after a newer one.
  const persist = () => {
    const snapshot = encodeStored([...servers.values()].map((server) => server.stored));
    persisting = persisting.then(() =>
      runPromise(
        secrets
          .set(SECRET_NAME, new TextEncoder().encode(snapshot))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("could not save remote MCP servers", { cause }),
            ),
          ),
      ),
    );
    return persisting;
  };

  const clientMetadata = (redirectUrl: string | undefined) => ({
    client_name: "T3 Code",
    redirect_uris: redirectUrl === undefined ? [] : [redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });

  /** The live connection's credentials. It refreshes tokens but never starts a sign-in. */
  const oauthProvider = (server: LiveServer): OAuthClientProvider => ({
    get redirectUrl() {
      return server.stored.oauth?.redirectUrl;
    },
    get clientMetadata() {
      return clientMetadata(server.stored.oauth?.redirectUrl);
    },
    clientInformation: () =>
      server.stored.oauth?.clientInformation as OAuthClientInformationMixed | undefined,
    saveClientInformation: (clientInformation) => {
      server.stored.oauth = { ...server.stored.oauth, clientInformation };
      return persist();
    },
    tokens: () => server.stored.oauth?.tokens as OAuthTokens | undefined,
    saveTokens: (tokens) => {
      server.stored.oauth = { ...server.stored.oauth, tokens };
      return persist();
    },
    // A failed refresh falls through to a new sign-in, which only the user can start.
    redirectToAuthorization: () => {
      throw new UnauthorizedError("Sign in again from Settings.");
    },
    saveCodeVerifier: () => {
      throw new UnauthorizedError("Sign in again from Settings.");
    },
    codeVerifier: () => {
      throw new UnauthorizedError("Sign in again from Settings.");
    },
    invalidateCredentials: (scope) => {
      if (scope === "verifier") return;
      const { clientInformation, tokens, ...rest } = server.stored.oauth ?? {};
      server.stored.oauth = {
        ...rest,
        ...(scope === "all" || scope === "client" || clientInformation === undefined
          ? {}
          : { clientInformation }),
        ...(scope === "all" || scope === "tokens" || tokens === undefined ? {} : { tokens }),
      };
      return persist();
    },
  });

  /**
   * A sign-in the user started. It never sees the working tokens and replaces
   * them only once its code exchange succeeds, so an abandoned sign-in, or one
   * from another address, leaves the live connection alone.
   */
  const signInProvider = (server: LiveServer): OAuthClientProvider => {
    const pending = () => {
      const current = server.stored.oauth?.pending;
      if (current === undefined) throw new Error("No sign-in is in progress.");
      return current;
    };
    const updatePending = (patch: Partial<NonNullable<OAuthState["pending"]>>) => {
      server.stored.oauth = { ...server.stored.oauth, pending: { ...pending(), ...patch } };
      return persist();
    };
    // A registration is bound to its redirect URI, so the saved one fits only the same address.
    const reusableClient = () =>
      pending().newClient !== true && server.stored.oauth?.redirectUrl === pending().redirectUrl
        ? server.stored.oauth?.clientInformation
        : undefined;
    return {
      get redirectUrl() {
        return server.stored.oauth?.pending?.redirectUrl;
      },
      get clientMetadata() {
        return clientMetadata(server.stored.oauth?.pending?.redirectUrl);
      },
      state: () => pending().state,
      clientInformation: () =>
        (pending().clientInformation ?? reusableClient()) as
          | OAuthClientInformationMixed
          | undefined,
      saveClientInformation: (clientInformation) => updatePending({ clientInformation }),
      tokens: () => undefined,
      saveTokens: (tokens) => {
        const current = pending();
        const clientInformation = current.clientInformation ?? reusableClient();
        const { pending: _pending, ...oauth } = server.stored.oauth ?? {};
        server.stored.oauth = {
          ...oauth,
          redirectUrl: current.redirectUrl,
          ...(clientInformation === undefined ? {} : { clientInformation }),
          tokens,
        };
        return persist();
      },
      // Ctrl never opens a browser itself: `authorize` hands this URL to the client that asked.
      redirectToAuthorization: (authorizationUrl) => {
        server.authorizationUrl = authorizationUrl;
      },
      saveCodeVerifier: (codeVerifier) => updatePending({ codeVerifier }),
      codeVerifier: () => {
        const codeVerifier = pending().codeVerifier;
        if (codeVerifier === undefined) throw new Error("No sign-in is in progress.");
        return codeVerifier;
      },
      invalidateCredentials: (scope) =>
        scope === "all" || scope === "client"
          ? updatePending({ clientInformation: undefined, newClient: true })
          : undefined,
    };
  };

  const clearPending = (server: LiveServer) => {
    if (server.stored.oauth?.pending === undefined) return Promise.resolve();
    const { pending: _pending, ...oauth } = server.stored.oauth;
    server.stored.oauth = oauth;
    return persist();
  };

  const closeClient = async (server: LiveServer) => {
    const client = server.client;
    server.client = undefined;
    if (client !== undefined) await client.close().catch(() => undefined);
  };

  const listRemoteTools = async (server: LiveServer, client: Client) => {
    const tools: Array<ProxiedTool> = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor });
      for (const tool of page.tools) {
        const digest = await sha256(tool.name);
        let name = exposedToolName(server.stored.id, tool.name, digest);
        // Cleaning can map two tools to one name (`a.b` and `a_b`); never let one replace the other.
        if (tools.some((existing) => existing.name === name)) {
          name = `${name.slice(0, MAX_TOOL_NAME_LENGTH - 7)}_${digest.slice(0, 6)}`;
        }
        tools.push({
          name,
          serverId: server.stored.id,
          remoteName: tool.name,
          title: tool.title ?? tool.annotations?.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        });
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return tools;
  };

  const connectNow = async (server: LiveServer) => {
    await closeClient(server);
    const { stored } = server;
    if (stored.authMode === "oauth" && stored.oauth?.tokens === undefined) {
      server.tools = [];
      reindexTools();
      setState(server, "needs_authorization");
      return;
    }
    setState(server, "connecting");
    const client = new Client({ name: "T3 Code", version: packageJson.version });
    const transport = new StreamableHTTPClientTransport(new URL(stored.url), {
      ...(stored.authMode === "oauth" ? { authProvider: oauthProvider(server) } : {}),
      ...(stored.authMode === "bearer" && stored.bearerToken !== undefined
        ? { requestInit: { headers: { Authorization: `Bearer ${stored.bearerToken}` } } }
        : {}),
    });
    try {
      // The SDK's own types disagree under exactOptionalPropertyTypes.
      await client.connect(transport as Transport);
      const tools = await listRemoteTools(server, client);
      // A removal or newer connect may have replaced this server while it connected.
      if (servers.get(stored.id) !== server) {
        await client.close().catch(() => undefined);
        return;
      }
      client.onclose = () => {
        if (server.client !== client) return;
        server.client = undefined;
        setState(server, "error", "The connection closed. It reconnects on the next tool call.");
      };
      server.client = client;
      server.tools = tools;
      reindexTools();
      setState(server, "connected");
    } catch (error) {
      await client.close().catch(() => undefined);
      server.tools = [];
      reindexTools();
      if (isAuthFailure(error)) {
        setState(
          server,
          stored.authMode === "oauth" ? "needs_authorization" : "error",
          stored.authMode === "oauth" ? undefined : "The server rejected the credential.",
        );
      } else {
        setState(server, "error", describe(error));
      }
    }
  };

  const connect = (server: LiveServer) => {
    const running = server.connecting ?? connectNow(server);
    server.connecting = running;
    return running.finally(() => {
      if (server.connecting === running) server.connecting = undefined;
    });
  };

  const findServer = (id: string) =>
    Effect.suspend(() => {
      const server = servers.get(id);
      return server === undefined
        ? Effect.fail(remoteError("That MCP server is not configured.", id))
        : Effect.succeed(server);
    });

  const snapshot = (server: LiveServer): RemoteMcpServer => ({
    id: server.stored.id,
    name: server.stored.name,
    url: displayUrl(server.stored.url),
    authMode: server.stored.authMode,
    state: server.state,
    toolCount: server.tools.length,
    ...(server.message === undefined ? {} : { message: server.message }),
  });

  const list = Effect.sync(() => ({ servers: [...servers.values()].map(snapshot) }));

  const subscribe = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      return Stream.concat(
        Stream.fromEffect(list),
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list)),
      );
    }),
  );

  // Starts with one signal once subscribed, so a change before the first pull is never lost.
  const toolChanges = Stream.unwrap(
    PubSub.subscribe(toolChangesHub).pipe(
      Effect.map((subscription) =>
        Stream.concat(Stream.make(undefined), Stream.fromSubscription(subscription)),
      ),
    ),
  );

  const promise = <A>(serverId: string | undefined, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (error) => remoteError(describe(error), serverId),
    });

  const add: RemoteMcpServers["Service"]["add"] = (input) =>
    Effect.suspend(() => {
      const invalid = invalidAddInput(input);
      if (invalid !== undefined) return Effect.fail(remoteError(invalid));
      if (servers.has(input.id)) {
        return Effect.fail(remoteError(`An MCP server with the id "${input.id}" already exists.`));
      }
      const server: LiveServer = {
        stored: {
          id: input.id,
          name: input.name.trim(),
          url: input.url.trim(),
          authMode: input.authMode,
          ...(input.authMode === "bearer" ? { bearerToken: input.bearerToken?.trim() } : {}),
        },
        state: "connecting",
        message: undefined,
        tools: [],
        client: undefined,
        connecting: undefined,
        authorizationUrl: undefined,
      };
      servers.set(input.id, server);
      notify();
      return promise(input.id, async () => {
        await persist();
        await connect(server);
      });
    });

  const authorize: RemoteMcpServers["Service"]["authorize"] = Effect.fn(
    "RemoteMcpServers.authorize",
  )(function* (input) {
    const server = yield* findServer(input.id);
    if (server.stored.authMode !== "oauth") {
      return yield* remoteError("This server does not use sign-in.", input.id);
    }
    const redirectUrl = yield* Effect.try({
      try: () => callbackUrl(input.callbackOrigin),
      catch: (error) => remoteError(describe(error), input.id),
    });
    const state = yield* crypto.randomBytes(32).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
      Effect.mapError((error) => remoteError(describe(error), input.id)),
    );
    const expiresAt = (yield* Clock.currentTimeMillis) + PENDING_AUTHORIZATION_TTL_MS;
    return yield* promise(input.id, async () => {
      server.stored.oauth = {
        ...server.stored.oauth,
        pending: { state, expiresAt, redirectUrl },
      };
      server.authorizationUrl = undefined;
      await persist();
      const result = await auth(signInProvider(server), { serverUrl: server.stored.url });
      if (result === "AUTHORIZED") {
        await clearPending(server);
        await connect(server);
        return {};
      }
      // Set by `redirectToAuthorization` during `auth`, which TypeScript cannot see.
      const authorizationUrl = server.authorizationUrl as URL | undefined;
      if (authorizationUrl === undefined) {
        throw new Error("The server did not start a sign-in.");
      }
      if (authorizationUrl.protocol !== "https:" && authorizationUrl.protocol !== "http:") {
        throw new Error("The server returned a sign-in link that is not a web address.");
      }
      return { authorizationUrl: authorizationUrl.href };
    });
  });

  const completeAuthorization: RemoteMcpServers["Service"]["completeAuthorization"] = Effect.fn(
    "RemoteMcpServers.completeAuthorization",
  )(function* (input) {
    const now = yield* Clock.currentTimeMillis;
    const server = [...servers.values()].find(
      (candidate) => candidate.stored.oauth?.pending?.state === input.state,
    );
    const pending = server?.stored.oauth?.pending;
    if (server === undefined || pending === undefined || pending.expiresAt < now) {
      return yield* remoteError("This sign-in link expired. Start the sign-in again.");
    }
    return yield* promise(server.stored.id, async () => {
      try {
        await auth(signInProvider(server), {
          serverUrl: server.stored.url,
          authorizationCode: input.code,
        });
      } finally {
        // A code is single-use, so a failed exchange needs a fresh sign-in either way.
        await clearPending(server);
      }
      await connect(server);
      return { name: server.stored.name };
    });
  });

  const reconnect: RemoteMcpServers["Service"]["reconnect"] = (input) =>
    findServer(input.id).pipe(Effect.flatMap((server) => promise(input.id, () => connect(server))));

  const remove: RemoteMcpServers["Service"]["remove"] = (input) =>
    findServer(input.id).pipe(
      Effect.flatMap((server) =>
        promise(input.id, async () => {
          servers.delete(input.id);
          reindexTools();
          notify();
          await persist();
          await closeClient(server);
        }),
      ),
    );

  const isVisible: RemoteMcpServers["Service"]["isVisible"] = (toolName) => {
    const tool = toolIndex.get(toolName);
    return tool !== undefined && servers.has(tool.serverId);
  };

  const callTool: RemoteMcpServers["Service"]["callTool"] = (toolName, args) =>
    Effect.suspend(() => {
      const tool = toolIndex.get(toolName);
      const server = tool === undefined ? undefined : servers.get(tool.serverId);
      if (tool === undefined || server === undefined) {
        return Effect.fail(remoteError(`The tool ${toolName} is no longer available.`));
      }
      const call = async () => {
        if (server.client === undefined) await connect(server);
        const client = server.client;
        if (client === undefined) {
          throw new Error(server.message ?? `${server.stored.name} is not connected.`);
        }
        return client.callTool(
          { name: tool.remoteName, ...(args === undefined ? {} : { arguments: args }) },
          undefined,
          { timeout: TOOL_CALL_TIMEOUT_MS },
        );
      };
      return promise(tool.serverId, async () => {
        try {
          return await call();
        } catch (error) {
          // Only an expired session is safe to retry: the server refused the call before running
          // it. A timeout or dropped connection may have run the tool already.
          if (!(error instanceof StreamableHTTPError && error.code === 404)) throw error;
          await connect(server);
          return call();
        }
      });
    });

  const stored = yield* secrets.get(SECRET_NAME).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed([] as ReadonlyArray<StoredServer>),
        onSome: (bytes) => decodeStored(new TextDecoder().decode(bytes)),
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("could not read remote MCP servers", { cause }).pipe(
        Effect.as([] as ReadonlyArray<StoredServer>),
      ),
    ),
  );
  for (const entry of stored) {
    servers.set(entry.id, {
      stored: { ...entry },
      state: "connecting",
      message: undefined,
      tools: [],
      client: undefined,
      connecting: undefined,
      authorizationUrl: undefined,
    });
  }
  yield* Effect.forkScoped(Effect.promise(() => Promise.all([...servers.values()].map(connect))));
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => Promise.all([...servers.values()].map(closeClient))),
  );

  return RemoteMcpServers.of({
    list,
    subscribe,
    add,
    authorize,
    completeAuthorization,
    reconnect,
    remove,
    tools: () => [...toolIndex.values()],
    toolChanges,
    isVisible,
    callTool,
  });
});

export const layer = Layer.effect(RemoteMcpServers, make);
