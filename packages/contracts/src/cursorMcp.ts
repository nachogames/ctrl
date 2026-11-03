import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

// Ctrl: Cursor's MCP servers, managed through Cursor's own config file and CLI.

const CursorMcpServerName = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const CursorMcpText = Schema.String.check(Schema.isMaxLength(4_096));

export const CursorMcpServerSource = Schema.Literals(["user", "project"]);
export type CursorMcpServerSource = typeof CursorMcpServerSource.Type;

export const CursorMcpServerStatus = Schema.Literals([
  "ready",
  "needs_sign_in",
  "error",
  "unknown",
]);
export type CursorMcpServerStatus = typeof CursorMcpServerStatus.Type;

export const CursorMcpServerTransport = Schema.Union([
  Schema.TaggedStruct("url", { url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)) }),
  Schema.TaggedStruct("command", {
    command: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
    args: Schema.Array(CursorMcpText).check(Schema.isMaxLength(64)),
  }),
]);
export type CursorMcpServerTransport = typeof CursorMcpServerTransport.Type;

export const CursorMcpServer = Schema.Struct({
  name: CursorMcpServerName,
  /** Null for servers the CLI reports that no readable config file declares, such as plugin servers. */
  source: Schema.NullOr(CursorMcpServerSource),
  transport: Schema.NullOr(CursorMcpServerTransport),
  status: CursorMcpServerStatus,
  statusDetail: Schema.NullOr(CursorMcpText),
  /** Signed in on disk, but this server process loaded the folder while it was signed out. */
  needsRelaunch: Schema.Boolean,
  /** An icon the server's site declares, for URL servers that have one. */
  iconUrl: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_048))),
});
export type CursorMcpServer = typeof CursorMcpServer.Type;

/** A thread checks its own folder, a project its root; neither checks user-level servers only. */
export const CursorMcpFolderInput = Schema.Struct({
  threadId: Schema.optionalKey(ThreadId),
  projectId: Schema.optionalKey(ProjectId),
  /** For a project: the Cursor instance whose settings apply, as a draft has no thread yet. */
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
});
export type CursorMcpFolderInput = typeof CursorMcpFolderInput.Type;

export const CursorMcpStatusResult = Schema.Struct({
  cliAvailable: Schema.Boolean,
  installCommand: Schema.String,
  folder: Schema.NullOr(Schema.String),
  /** This server process has already opened a Cursor agent in the folder. */
  folderLoaded: Schema.Boolean,
  servers: Schema.Array(CursorMcpServer).check(Schema.isMaxLength(256)),
  /** Something supervises this server and starts it again after it exits: the desktop app or the background service. */
  canRestartServer: Schema.Boolean,
  /** Set when `~/.cursor/mcp.json` exists but cannot be read as JSON. */
  userConfigError: Schema.NullOr(CursorMcpText),
});
export type CursorMcpStatusResult = typeof CursorMcpStatusResult.Type;

export const CursorMcpSignInInput = Schema.Struct({
  ...CursorMcpFolderInput.fields,
  name: CursorMcpServerName,
});
export type CursorMcpSignInInput = typeof CursorMcpSignInInput.Type;

export const CursorMcpSaveServerInput = Schema.Struct({
  name: CursorMcpServerName,
  /** Set when renaming; the old entry is replaced in place. */
  previousName: Schema.optionalKey(CursorMcpServerName),
  transport: CursorMcpServerTransport,
});
export type CursorMcpSaveServerInput = typeof CursorMcpSaveServerInput.Type;

export const CursorMcpRemoveServerInput = Schema.Struct({
  name: CursorMcpServerName,
});
export type CursorMcpRemoveServerInput = typeof CursorMcpRemoveServerInput.Type;

export const CursorMcpOperationErrorReason = Schema.Literals([
  "cli_missing",
  "config_invalid",
  "server_exists",
  "server_not_found",
  "folder_not_found",
  "sign_in_failed",
  "command_failed",
  "restart_unsupported",
]);
export type CursorMcpOperationErrorReason = typeof CursorMcpOperationErrorReason.Type;

export class CursorMcpOperationError extends Schema.TaggedError<CursorMcpOperationError>()(
  "CursorMcpOperationError",
  {
    reason: CursorMcpOperationErrorReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "cli_missing":
        return "Cursor's command-line tool (cursor-agent) is not installed on this machine.";
      case "config_invalid":
        return "~/.cursor/mcp.json is not valid JSON, so it was left unchanged.";
      case "server_exists":
        return "An MCP server with that name already exists.";
      case "server_not_found":
        return "That MCP server is not in ~/.cursor/mcp.json.";
      case "folder_not_found":
        return "The thread or project folder could not be found.";
      case "sign_in_failed":
        return "Cursor did not finish signing in to that MCP server.";
      case "command_failed":
        return "Cursor's command-line tool failed.";
      case "restart_unsupported":
        return "Nothing would start this server again, so restart it on the machine running it.";
    }
  }
}
