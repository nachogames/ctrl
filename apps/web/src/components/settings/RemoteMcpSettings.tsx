import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RemoteMcpAuthMode, RemoteMcpServer } from "@t3tools/contracts/remoteMcp";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { readLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { remoteMcpEnvironment } from "../../state/remoteMcp";
import { readPreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { RemoteMcpDuplicateCheck } from "./RemoteMcpDuplicateCheck";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";

const AUTH_MODE_LABELS: Record<RemoteMcpAuthMode, string> = {
  oauth: "Sign in (OAuth)",
  bearer: "Bearer token",
  none: "No authentication",
};

const EMPTY_SERVERS: ReadonlyArray<RemoteMcpServer> = [];

function statusOf(server: RemoteMcpServer) {
  switch (server.state) {
    case "connected":
      return {
        label: `Connected · ${server.toolCount} ${server.toolCount === 1 ? "tool" : "tools"}`,
        dot: "bg-success",
      };
    case "connecting":
      return { label: "Connecting…", dot: "bg-warning" };
    case "needs_authorization":
      return { label: "Needs sign-in", dot: "bg-warning" };
    case "error":
      return { label: server.message ?? "Not connected", dot: "bg-destructive" };
  }
}

/**
 * The browser that signs in must reach this environment's callback, so the
 * sign-in returns to the origin this client already uses for it.
 */
function callbackOrigin(environmentId: EnvironmentId) {
  return readPreparedConnection(environmentId)?.httpBaseUrl ?? window.location.origin;
}

/**
 * Browsers block a window opened after an await, so the tab opens during the
 * click and is pointed at the sign-in once the server returns it.
 */
function startSignInWindow() {
  if (window.desktopBridge) {
    return {
      open: (url: string) => readLocalApi()?.shell.openExternal(url),
      cancel: () => undefined,
    };
  }
  const popup = window.open("about:blank", "_blank");
  if (popup) popup.opener = null;
  return {
    open: (url: string) => {
      if (popup) popup.location.href = url;
      else window.open(url, "_blank", "noopener,noreferrer");
    },
    cancel: () => popup?.close(),
  };
}

/** The Tools page. Upstream T3 Code adds its own Tools page; on merge, this section moves onto it. */
export function ToolsSettingsPanel() {
  return (
    <SettingsPageContainer>
      <RemoteMcpSettings />
    </SettingsPageContainer>
  );
}

function RemoteMcpSettings() {
  const { environment, scope } = useSettingsScope();
  if (scope.kind !== "environment" || !environment) {
    return (
      <SettingsSection id="sign-in-mcp-servers" title="Sign-in MCP servers">
        <SettingsScopeNotice target="environment">
          Choose one environment to manage the MCP servers its agents use.
        </SettingsScopeNotice>
      </SettingsSection>
    );
  }
  return (
    <RemoteMcpServerList
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  );
}

function RemoteMcpServerList({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(remoteMcpEnvironment.servers({ environmentId, input: {} }));
  const servers = query.data?.servers ?? EMPTY_SERVERS;
  const canEdit = useAtomValue(remoteMcpEnvironment.add.permissionAtom(environmentId));
  const [adding, setAdding] = useState(false);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);

  return (
    <SettingsSection
      id="sign-in-mcp-servers"
      title="Sign-in MCP servers"
      headerAction={
        <div className="flex gap-2">
          {servers.length > 0 && !checkingDuplicates && (
            <Button size="xs" variant="ghost" onClick={() => setCheckingDuplicates(true)}>
              Check agents for duplicates
            </Button>
          )}
          {canEdit && !adding && (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              Add server
            </Button>
          )}
        </div>
      }
    >
      <p className="px-4 py-3 text-xs text-muted-foreground sm:px-5">
        For remote MCP servers that need a sign-in or token. Connect one once and every agent on
        this environment can use its tools. Sign-ins and tokens stay on this environment. Agents
        pick up changes when their next session starts.
      </p>
      {adding && (
        <AddRemoteMcpServerForm environmentId={environmentId} onDone={() => setAdding(false)} />
      )}
      {servers.map((server) => (
        <RemoteMcpServerRow
          key={server.id}
          environmentId={environmentId}
          server={server}
          canEdit={canEdit}
        />
      ))}
      {checkingDuplicates && servers.length > 0 && (
        <RemoteMcpDuplicateCheck environmentId={environmentId} servers={servers} />
      )}
      {query.error !== null && (
        <p className="px-4 pb-3 text-xs text-muted-foreground sm:px-5">
          Could not load MCP servers. If this environment runs an older server, update it.
        </p>
      )}
      {servers.length === 0 && !adding && query.data !== null && (
        <p className="px-4 pb-3 text-xs text-muted-foreground sm:px-5">No MCP servers yet.</p>
      )}
    </SettingsSection>
  );
}

function toastOnFailure(result: AtomCommandResult<unknown, unknown>, title: string) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "Try again.",
  });
}

function RemoteMcpServerRow({
  environmentId,
  server,
  canEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly server: RemoteMcpServer;
  readonly canEdit: boolean;
}) {
  const authorize = useAtomCommand(remoteMcpEnvironment.authorize);
  const reconnect = useAtomCommand(remoteMcpEnvironment.reconnect);
  const remove = useAtomCommand(remoteMcpEnvironment.remove);
  const [pending, setPending] = useState(false);
  const status = statusOf(server);

  const run = async (
    failureTitle: string,
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    setPending(true);
    toastOnFailure(await action().finally(() => setPending(false)), failureTitle);
  };

  const signIn = () => {
    const signInWindow = startSignInWindow();
    return run(`Could not sign in to ${server.name}`, async () => {
      const result = await authorize({
        environmentId,
        input: { id: server.id, callbackOrigin: callbackOrigin(environmentId) },
      });
      if (result._tag === "Success" && result.value.authorizationUrl !== undefined) {
        await signInWindow.open(result.value.authorizationUrl);
      } else {
        signInWindow.cancel();
      }
      return result;
    });
  };

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-1.5">
          <ConnectionStatusDot dotClassName={status.dot} />
          {server.name}
        </span>
      }
      description={
        <span className="grid gap-0.5">
          <span className="break-all">{server.url}</span>
          <span>
            {status.label} · tools appear as <code>{server.id}_…</code>
          </span>
        </span>
      }
      control={
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {server.authMode === "oauth" && (
            <Button
              size="xs"
              variant={server.state === "needs_authorization" ? "default" : "outline"}
              disabled={!canEdit || pending}
              onClick={() => void signIn()}
            >
              {server.state === "needs_authorization" ? "Sign in" : "Sign in again"}
            </Button>
          )}
          {server.state !== "needs_authorization" && (
            <Button
              size="xs"
              variant="outline"
              disabled={!canEdit || pending || server.state === "connecting"}
              onClick={() =>
                void run(`Could not reconnect ${server.name}`, () =>
                  reconnect({ environmentId, input: { id: server.id } }),
                )
              }
            >
              Reconnect
            </Button>
          )}
          <Button
            size="xs"
            variant="outline"
            disabled={!canEdit || pending}
            onClick={() =>
              void run(`Could not remove ${server.name}`, () =>
                remove({ environmentId, input: { id: server.id } }),
              )
            }
          >
            Remove
          </Button>
        </div>
      }
    />
  );
}

function AddRemoteMcpServerForm({
  environmentId,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly onDone: () => void;
}) {
  const add = useAtomCommand(remoteMcpEnvironment.add);
  const authorize = useAtomCommand(remoteMcpEnvironment.authorize);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [url, setUrl] = useState("");
  const [authMode, setAuthMode] = useState<RemoteMcpAuthMode>("oauth");
  const [bearerToken, setBearerToken] = useState("");
  const [saving, setSaving] = useState(false);

  const derivedId = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+|-+$/g, "")
    .slice(0, 16)
    .replace(/-+$/g, "");
  const effectiveId = idEdited ? id : derivedId;

  return (
    <form
      className="grid gap-3 px-4 py-4 sm:px-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving) return;
        setSaving(true);
        const signInWindow = authMode === "oauth" ? startSignInWindow() : undefined;
        const result = await add({
          environmentId,
          input: {
            id: effectiveId,
            name,
            url,
            authMode,
            ...(authMode === "bearer" ? { bearerToken } : {}),
          },
        });
        if (result._tag === "Success" && signInWindow) {
          const signIn = await authorize({
            environmentId,
            input: { id: effectiveId, callbackOrigin: callbackOrigin(environmentId) },
          });
          if (signIn._tag === "Success" && signIn.value.authorizationUrl !== undefined) {
            await signInWindow.open(signIn.value.authorizationUrl);
          } else {
            signInWindow.cancel();
            toastOnFailure(signIn, `Could not sign in to ${name}`);
          }
        } else {
          signInWindow?.cancel();
          toastOnFailure(result, `Could not add ${name}`);
        }
        setSaving(false);
        if (result._tag === "Success") onDone();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="remote-mcp-name">Name</Label>
          <Input
            id="remote-mcp-name"
            size="sm"
            required
            placeholder="Notes"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="remote-mcp-id">Tool prefix</Label>
          <Input
            id="remote-mcp-id"
            size="sm"
            required
            pattern="[a-z][a-z0-9\-]{0,15}"
            title="1-16 lowercase letters, digits, or dashes, starting with a letter."
            placeholder="notes"
            value={effectiveId}
            onChange={(event) => {
              setIdEdited(true);
              setId(event.target.value);
            }}
          />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="remote-mcp-url">Server URL</Label>
        <Input
          id="remote-mcp-url"
          size="sm"
          type="url"
          required
          placeholder="https://mcp.example.com/mcp"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label>Authentication</Label>
          <Select
            value={authMode}
            onValueChange={(value) => {
              if (value !== null) setAuthMode(value as RemoteMcpAuthMode);
            }}
          >
            <SelectTrigger aria-label="Authentication" size="sm">
              <SelectValue>{AUTH_MODE_LABELS[authMode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {(Object.keys(AUTH_MODE_LABELS) as RemoteMcpAuthMode[]).map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {AUTH_MODE_LABELS[mode]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        {authMode === "bearer" && (
          <div className="grid gap-1.5">
            <Label htmlFor="remote-mcp-token">Bearer token</Label>
            <Input
              id="remote-mcp-token"
              size="sm"
              type="password"
              required
              autoComplete="off"
              value={bearerToken}
              onChange={(event) => setBearerToken(event.target.value)}
            />
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="xs" variant="outline" disabled={saving} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={saving}>
          {saving ? "Adding…" : authMode === "oauth" ? "Add and sign in" : "Add"}
        </Button>
      </div>
    </form>
  );
}
