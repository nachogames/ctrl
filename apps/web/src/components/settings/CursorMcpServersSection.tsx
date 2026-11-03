import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  type CursorMcpServer,
  type CursorMcpServerTransport,
  type CursorMcpStatusResult,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useEffectEvent, useState } from "react";
import { APP_BASE_NAME } from "../../branding";

import { ensureLocalApi } from "../../localApi";
import { useRestartServerForCursorMcp } from "../chat/ComposerCursorMcpControl";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

interface CursorMcpProject {
  readonly id: ProjectId;
  readonly title: string;
}

interface ServerDraft {
  readonly previousName: string | null;
  readonly name: string;
  readonly kind: "url" | "command";
  readonly url: string;
  readonly command: string;
  readonly args: string;
}

const EMPTY_DRAFT: ServerDraft = {
  previousName: null,
  name: "",
  kind: "url",
  url: "",
  command: "",
  args: "",
};

function draftFor(server: CursorMcpServer): ServerDraft {
  const transport = server.transport;
  return {
    previousName: server.name,
    name: server.name,
    kind: transport?._tag ?? "url",
    url: transport?._tag === "url" ? transport.url : "",
    command: transport?._tag === "command" ? transport.command : "",
    args: transport?._tag === "command" ? transport.args.join("\n") : "",
  };
}

function draftTransport(draft: ServerDraft): CursorMcpServerTransport | null {
  if (draft.kind === "url") {
    const url = draft.url.trim();
    return url.length === 0 ? null : { _tag: "url", url };
  }
  const command = draft.command.trim();
  if (command.length === 0) return null;
  // One argument per line, so an argument may contain spaces.
  const args = draft.args
    .split(/\r?\n/)
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0);
  return { _tag: "command", command, args };
}

function describeTransport(transport: CursorMcpServerTransport | null): string | null {
  if (transport === null) return null;
  return transport._tag === "url"
    ? transport.url
    : [transport.command, ...transport.args].join(" ");
}

function StatusBadge({ server }: { readonly server: CursorMcpServer }) {
  if (server.needsRelaunch) return <Badge variant="warning">Restart needed</Badge>;
  switch (server.status) {
    case "ready":
      return <Badge variant="success">Ready</Badge>;
    case "needs_sign_in":
      return <Badge variant="warning">Needs sign-in</Badge>;
    case "error":
      return <Badge variant="error">Error</Badge>;
    case "unknown":
      return <Badge variant="outline">Unknown</Badge>;
  }
}

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : undefined,
  });
}

export function CursorMcpServersSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<CursorMcpProject>;
  readonly readOnly: boolean;
}) {
  const canRead = useEnvironmentScope(props.environmentId, AuthOrchestrationReadScope);
  const canManage =
    useEnvironmentScope(props.environmentId, AuthProvidersManageScope) && !props.readOnly;
  const restart = useRestartServerForCursorMcp(props.environmentId);
  const [projectId, setProjectId] = useState<ProjectId | null>(props.projects[0]?.id ?? null);
  const [checked, setStatus] = useState<{
    readonly key: string;
    readonly value: CursorMcpStatusResult;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [draft, setDraft] = useState<ServerDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const readStatus = useAtomCommand(serverEnvironment.cursorMcpStatus, { reportFailure: false });
  const signIn = useAtomCommand(serverEnvironment.cursorMcpSignIn, { reportFailure: false });
  const saveServer = useAtomCommand(serverEnvironment.cursorMcpSaveServer, {
    reportFailure: false,
  });
  const removeServer = useAtomCommand(serverEnvironment.cursorMcpRemoveServer, {
    reportFailure: false,
  });
  const folderInput = projectId === null ? {} : { projectId };

  const statusKey = `${props.environmentId}:${projectId ?? ""}`;
  const load = useEffectEvent(async (key: string) => {
    if (!canRead) return;
    const result = await readStatus({ environmentId: props.environmentId, input: folderInput });
    if (result._tag === "Success") {
      setStatus({ key, value: result.value });
      return;
    }
    reportFailure("Could not check Cursor MCP servers", result);
  });
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- State changes only after the response arrives.
    void load(statusKey);
  }, [statusKey]);
  const refresh = async () => {
    setLoading(true);
    await load(statusKey);
    setLoading(false);
  };

  const signInTo = async (name: string) => {
    if (signingIn !== null) return;
    setSigningIn(name);
    const result = await signIn({
      environmentId: props.environmentId,
      input: { ...folderInput, name },
    });
    setSigningIn(null);
    if (result._tag === "Success") {
      setStatus({ key: statusKey, value: result.value });
      return;
    }
    reportFailure(`Could not sign in to ${name}`, result);
  };

  const save = async () => {
    if (draft === null || saving) return;
    const transport = draftTransport(draft);
    const name = draft.name.trim();
    if (transport === null || name.length === 0) return;
    setSaving(true);
    const result = await saveServer({
      environmentId: props.environmentId,
      input: {
        name,
        transport,
        ...(draft.previousName === null ? {} : { previousName: draft.previousName }),
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setDraft(null);
      void refresh();
      return;
    }
    reportFailure("Could not save the MCP server", result);
  };

  const remove = async (server: CursorMcpServer) => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Remove "${server.name}" from ~/.cursor/mcp.json? Cursor and ${APP_BASE_NAME} both stop loading it.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    const result = await removeServer({
      environmentId: props.environmentId,
      input: { name: server.name },
    });
    if (result._tag === "Success") {
      void refresh();
      return;
    }
    reportFailure("Could not remove the MCP server", result);
  };

  const status = checked?.key === statusKey ? checked.value : null;
  const servers = status?.servers ?? [];
  const needsRelaunch = servers.some((server) => server.needsRelaunch);
  const project = props.projects.find((candidate) => candidate.id === projectId);

  return (
    <div className="grid gap-3">
      <SettingsRow
        title="MCP servers"
        description="Servers Cursor loads from ~/.cursor/mcp.json and each project's .cursor/mcp.json. Cursor saves sign-ins per folder, so status is for the selected project."
        status={
          status === null
            ? undefined
            : !status.cliAvailable
              ? `Install Cursor's command-line tool to see status and sign in: ${status.installCommand}`
              : (status.userConfigError ?? undefined)
        }
        control={
          <div className="flex flex-wrap items-center gap-2">
            {props.projects.length > 1 ? (
              <Select
                value={projectId ?? ""}
                disabled={!canRead || loading}
                onValueChange={(value) => {
                  if (value !== null) setProjectId(value as ProjectId);
                }}
              >
                <SelectTrigger
                  aria-label="Project for Cursor MCP status"
                  className="w-40"
                  size="sm"
                >
                  <SelectValue>{project?.title}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {props.projects.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canRead || loading}
              onClick={() => void refresh()}
            >
              {loading || (canRead && status === null) ? "Checking" : "Refresh"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canManage || draft !== null}
              onClick={() => setDraft(EMPTY_DRAFT)}
            >
              Add server
            </Button>
          </div>
        }
      >
        {needsRelaunch ? (
          <div className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs text-muted-foreground">
            <span>
              Cursor threads read new sign-ins for an already-open folder only after {APP_BASE_NAME}{" "}
              restarts.
            </span>
            {status?.canRestartServer && restart.canMaintain ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={restart.restarting}
                onClick={() => void restart.restart()}
              >
                {restart.restarting ? "Restarting…" : `Restart ${APP_BASE_NAME}`}
              </Button>
            ) : null}
          </div>
        ) : null}

        {servers.length > 0 ? (
          <div className="divide-y divide-border/60 border-y border-border/60">
            {servers.map((server) => (
              <div
                key={server.name}
                className="flex min-w-0 items-center justify-between gap-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate text-xs text-foreground">{server.name}</p>
                    <StatusBadge server={server} />
                    <span className="shrink-0 text-3xs text-muted-foreground">
                      {server.source === "user"
                        ? "User"
                        : server.source === "project"
                          ? "Project"
                          : "Managed by Cursor"}
                    </span>
                  </div>
                  <code className="block truncate text-3xs text-muted-foreground">
                    {describeTransport(server.transport) ?? server.statusDetail ?? ""}
                  </code>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {server.status === "needs_sign_in" && status?.cliAvailable ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={!canManage || signingIn !== null}
                      onClick={() => void signInTo(server.name)}
                    >
                      {signingIn === server.name ? "Signing in" : "Sign in"}
                    </Button>
                  ) : null}
                  {server.source === "user" ? (
                    <>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost-muted"
                        disabled={!canManage || draft !== null}
                        onClick={() => setDraft(draftFor(server))}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost-destructive"
                        disabled={!canManage}
                        onClick={() => void remove(server)}
                      >
                        Remove
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : status !== null ? (
          <p className="py-2 text-xs text-muted-foreground">
            No MCP servers configured for Cursor.
          </p>
        ) : null}

        {draft !== null ? (
          <div className="grid gap-2 py-3">
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem]">
              <Input
                size="sm"
                aria-label="Server name"
                placeholder="Name, e.g. linear"
                value={draft.name}
                disabled={saving}
                onValueChange={(name) => setDraft({ ...draft, name })}
              />
              <Select
                value={draft.kind}
                disabled={saving}
                onValueChange={(kind) => {
                  if (kind === "url" || kind === "command") setDraft({ ...draft, kind });
                }}
              >
                <SelectTrigger aria-label="Server type" size="sm">
                  <SelectValue>{draft.kind === "url" ? "Remote URL" : "Local command"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="url">Remote URL</SelectItem>
                  <SelectItem value="command">Local command</SelectItem>
                </SelectPopup>
              </Select>
            </div>
            {draft.kind === "url" ? (
              <Input
                size="sm"
                type="url"
                aria-label="Server URL"
                placeholder="https://mcp.example.com/mcp"
                value={draft.url}
                disabled={saving}
                onValueChange={(url) => setDraft({ ...draft, url })}
              />
            ) : (
              <div className="grid gap-2">
                <Input
                  size="sm"
                  aria-label="Command"
                  placeholder="npx"
                  value={draft.command}
                  disabled={saving}
                  onValueChange={(command) => setDraft({ ...draft, command })}
                />
                <Textarea
                  size="sm"
                  aria-label="Arguments, one per line"
                  placeholder={"Arguments, one per line\n-y\n@modelcontextprotocol/server-example"}
                  value={draft.args}
                  disabled={saving}
                  onChange={(event) => setDraft({ ...draft, args: event.target.value })}
                />
              </div>
            )}
            <div className="flex items-center justify-end gap-1">
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                disabled={saving}
                onClick={() => setDraft(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={
                  saving || draft.name.trim().length === 0 || draftTransport(draft) === null
                }
                onClick={() => void save()}
              >
                {saving ? "Saving" : draft.previousName === null ? "Add" : "Save"}
              </Button>
            </div>
          </div>
        ) : null}
      </SettingsRow>
    </div>
  );
}
