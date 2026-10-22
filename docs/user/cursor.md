# Cursor

Cursor V2 runs through the official [`@cursor/sdk`](https://cursor.com/docs/api/sdk/typescript)
TypeScript package. It does not use Cursor's ACP transport for V2 execution.

## Prerequisites

- Node.js 22.13 or newer. The repository's supported Node version satisfies this requirement.
- Sign in with Cursor in **Settings > Providers > Cursor**, or provide a Cursor API key in
  `CURSOR_API_KEY`.
- A paid Cursor plan on the account used for browser sign-in or `CURSOR_API_KEY`.
- A model accepted by the Cursor SDK. `auto` is sent to the SDK as its `default` model selection.

The adapter currently uses the SDK's local-agent runtime so runs operate in the selected T3 Code
workspace. Cursor cloud agents need repository and cloud-environment configuration that T3 Code does
not expose yet.

## Sign in

Choose **Sign in**, then open the sign-in page and complete it in your browser. T3 Code
updates automatically when sign-in finishes. This works when connected to a remote environment too.
On mobile, use **Settings > Provider accounts** for an already configured Cursor instance.

Each provider instance keeps its own login on the environment that runs it. Your Cursor editor and
CLI login are separate. A configured `CURSOR_API_KEY` overrides browser sign-in; remove that override
to use the browser flow.

Use **Change account** or **Sign out** in the same settings section. Both stop that
instance's running threads and keep their history. Sign-out forgets the saved credential; to revoke
the generated key before it expires, remove it from your Cursor dashboard's API keys.

## MCP servers

Cursor threads load the MCP servers in `~/.cursor/mcp.json` and the project's `.cursor/mcp.json`.
Servers installed as Cursor app plugins may not load; add them as regular MCP servers instead.
Manage your user-level servers in **Settings > Providers > Cursor > MCP servers**.

Checking status and signing in use Cursor's command-line tool. Install it on the machine running
T3 Code with `curl https://cursor.com/install -fsS | bash`.

Cursor saves MCP sign-ins per folder, so each project and worktree needs its own sign-in. The
**MCP** tab on a Cursor thread's composer lists its servers and whether each is signed in for that
folder; choose **Sign in** there, and the browser opens on the machine running T3 Code.

To sign in once for every Cursor thread, turn on **Share MCP sign-ins across folders** in
**Settings > Providers > Cursor**. Before a thread first runs in a folder, T3 Code copies the newest
sign-in for each server in `~/.cursor/mcp.json` from any folder you signed in from. Servers that a
project's own `.cursor/mcp.json` defines still sign in per folder. Sign-ins stay in your Cursor data
folder on that machine. A server that replaces its refresh token on every refresh can still sign one
copy out; sign in again there.

Cursor reads a folder's sign-ins once per server start, so a sign-in finished after a thread already
used that folder needs a restart. Choose **Restart** in the MCP tab. It works when the desktop app
or the background service runs the server, and interrupts any running turns; otherwise restart the
server yourself.

### Approving MCP calls

Cursor threads in T3 Code don't use the Cursor app's allowlist, and they can't stop to ask you on
their own. To approve MCP calls yourself, turn on **Ask before MCP tools outside your allowlist**
in **Settings > Providers > Cursor**. Any MCP call your allowlist doesn't cover then waits for an
approval card in the thread, even in Full access: **Allow**, **Allow for this chat**, or **Deny**.

The allowlist is the `permissions` list in `~/.cursor/cli-config.json`, the same rules the
`cursor-agent` CLI uses. Allow rules run without asking, deny rules are always refused, and
anything else asks:

```json
{
  "permissions": {
    "allow": ["Mcp(linear:get_*)", "Mcp(linear:list_*)", "Mcp(ember:*)"],
    "deny": ["Mcp(linear:delete_*)"]
  }
}
```

The setting adds one hook to `~/.cursor/hooks.json`. It does nothing when the Cursor app or
`cursor-agent` runs it, and turning the setting off removes it. T3 Code's own tools never ask.

## V2 Capability Mapping

The adapter supports:

- creating and resuming local Cursor agent threads;
- changing the model and model parameters between turns;
- assistant text, reasoning, tool activity, plans, and todo streaming;
- thread-scoped T3 Code MCP tools;
- image attachments;
- interruption, queued app messages, and orchestrator-owned interrupt/restart steering;
- provider conversation snapshots through `Agent.messages.list()`;
- Cursor `task` subagents, projected as read-only child app threads with their tool activity and
  final result.

The public SDK does not currently expose native agent fork, conversation rollback, active steering,
or interactive approval callbacks. Direct active steering is advertised as unsupported, while V2
steering uses the orchestrator's interrupt-and-restart path and preserves the app run identity across
provider turns. Same-provider Cursor forks use the orchestrator's portable full-thread context
handoff into a fresh Cursor agent. The SDK has in-process custom callback tools, but the V2 adapter
intentionally uses the authenticated, thread-scoped MCP server instead.

Portable handoffs summarize eligible timeline items and can omit the end of long messages. Read
[Context in portable handoffs](./portable-handoffs.md) before using a fork for work whose exact
instructions must carry forward.

Cursor task events include an `agentId`, but the local SDK does not register that identifier as a
resumable agent: `Agent.resume()` returns `AgentNotFoundError`. The adapter therefore does not attach
a provider thread to native task projections or advertise subagent thread IDs. A projected child is
read-only: send messages from the parent thread.

Runtime modes map to the controls the local SDK exposes: full access disables its sandbox, while
restricted modes normally enable it. On Windows, Auto and Supervised run without filesystem
isolation when Cursor Auto-review is enabled, because the SDK does not support a filesystem sandbox
there. Restricted modes without Auto-review, including the default Auto-accept edits mode, still
request the sandbox and cannot start on Windows. Explicit sandbox policies remain authoritative,
including restrictive policies that the Windows SDK rejects. Explicit approval policy overrides
control Auto-review, which is not represented as an interactive T3 Code approval flow.

The existing Cursor binary path and API endpoint settings belong to the CLI/ACP integration. Cursor
V2 execution does not launch that binary, and the SDK does not expose an API endpoint override.

## Replay And Live Testing

Cursor replay fixtures preserve the SDK boundary: agent open/resume, sends, ordered `onDelta`
updates, terminal results, cancellation, message snapshots, and close. The real V2 adapter,
orchestrator, event store, projections, and checkpoint logic still run in tests.

Record a fixture against the real SDK with:

```bash
pnpm --filter t3 record:cursor-replay --scenario simple
```

Use `--out <path>` to record a temporary probe without replacing a checked-in fixture. Supported
scenarios are listed by the recorder when an invalid scenario is supplied.
