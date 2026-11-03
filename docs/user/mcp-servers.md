# Sign-in MCP servers

Connect a remote MCP server that needs a sign-in or token to an environment
once, and every agent T3 Code starts there can use its tools: Codex, Cursor,
Grok, OpenCode, Antigravity, and the rest. You sign in once from Settings
instead of setting the server up in each provider's own config.

## Add a server

1. Open **Settings → Tools → Sign-in MCP servers** and choose **Add server**.
2. Enter a name, the server's URL (usually ending in `/mcp`), and how it
   authenticates:
   - **Sign in (OAuth)** opens the server's sign-in page in your browser.
   - **Bearer token** sends a token you paste.
   - **No authentication** is for servers that need none.
3. For a sign-in, finish it in the browser tab that opens. The server shows
   **Connected** with its tool count once it is ready.

Tools appear to agents with the server's prefix, such as `notes_search` for a
`search` tool on a server with the prefix `notes`. Agents pick them up when
their next session starts.

## Duplicates

Every agent gets these tools, Claude included. If an agent already has the same
server in its own setup, such as a claude.ai connector or an entry in Codex's
config, it sees the tools twice. Choose **Check agents for duplicates** to look:
T3 Code asks each agent that can list its connectors and flags the ones that look
like a server added here. Where the agent allows it, switch its copy off for T3
Code only; the agent's other apps keep it. Otherwise remove it from that agent's
own config.

## Good to know

- Sign-ins and tokens stay on the environment. Clients and providers never see
  them; agents call the tools through the environment.
- Only agents T3 Code started get these tools. An [outside agent](./outside-agents.md)
  connected to the environment's MCP URL does not.
- Claude asks before calling one of these tools unless the thread has full
  access, the same as for its other tools.
- The browser that signs in must reach the environment at the address your
  client uses for it. A sign-in started over Tailscale returns to the Tailscale
  address, for example.
- **Remove** disconnects the server, deletes its sign-in or token, and takes its
  tools away from agents.
