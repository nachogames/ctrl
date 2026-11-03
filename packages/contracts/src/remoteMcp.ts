import { Schema } from "effect";

// Plain field types on purpose: the server validates ids and URLs, and richer
// schemas here push the WebSocket handler layer past TypeScript's depth limit.

export const RemoteMcpAuthMode = Schema.Literals(["oauth", "bearer", "none"]);
export type RemoteMcpAuthMode = typeof RemoteMcpAuthMode.Type;

export const RemoteMcpConnectionState = Schema.Literals([
  "connecting",
  "connected",
  "needs_authorization",
  "error",
]);
export type RemoteMcpConnectionState = typeof RemoteMcpConnectionState.Type;

/** What a client may see about a server. Credentials never leave the environment. */
export const RemoteMcpServer = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** The server's origin only; its full URL can carry a key. */
  url: Schema.String,
  authMode: RemoteMcpAuthMode,
  state: RemoteMcpConnectionState,
  toolCount: Schema.Number,
  message: Schema.optional(Schema.String),
});
export type RemoteMcpServer = typeof RemoteMcpServer.Type;

export const RemoteMcpServerList = Schema.Struct({
  servers: Schema.Array(RemoteMcpServer),
});
export type RemoteMcpServerList = typeof RemoteMcpServerList.Type;

export const RemoteMcpAddInput = Schema.Struct({
  /** Prefixes every proxied tool name as `<id>_<tool>`. */
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  authMode: RemoteMcpAuthMode,
  bearerToken: Schema.optional(Schema.String),
});
export type RemoteMcpAddInput = typeof RemoteMcpAddInput.Type;

export const RemoteMcpServerRef = Schema.Struct({ id: Schema.String });

export const RemoteMcpAuthorizeInput = Schema.Struct({
  id: Schema.String,
  /** The environment origin the browser can reach; the sign-in returns there. */
  callbackOrigin: Schema.String,
});

export const RemoteMcpAuthorizeResult = Schema.Struct({
  /** Open this to sign in. Absent when the server was already authorized. */
  authorizationUrl: Schema.optional(Schema.String),
});

export class RemoteMcpError extends Schema.TaggedError<RemoteMcpError>()("RemoteMcpError", {
  message: Schema.String,
  serverId: Schema.optional(Schema.String),
}) {}

export const REMOTE_MCP_OAUTH_CALLBACK_PATH = "/oauth/remote-mcp/callback";

/** 1-16 lowercase letters, digits, or dashes, starting with a letter. */
export const REMOTE_MCP_SERVER_ID_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;
