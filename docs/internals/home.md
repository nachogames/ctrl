# Shift

Shift is one agent thread per desktop install that acts with the user's reach
across every project here, and as a linked agent on every linked environment. User guide:
[Shift](../user/home.md).

Upstream T3 Code calls this feature Home. Ctrl shows it as Shift but keeps
upstream's identifiers (`home`, `HomeService`, `home.*` RPCs, `home:` ids) so
upstream merges stay cheap.

## Where it runs and who may act

- Shift runs on the desktop's local server, the hub. Only a server with
  `mode: "desktop"` offers it (`ServerConfig.homeWorkspaceRoot` is present).
- Its state lives in `ServerSettings.home` so every client gets it with the
  settings stream. Clients cannot patch it: the WebSocket settings update drops
  `home`, and only the Shift RPCs and Shift's own tools write it.
- The grant is "this thread is `home.threadId`", read on every MCP call in
  `mcp/homeRouting.ts`. Turning Shift off or starting fresh revokes the old
  thread's reach at once, then holds its queue (`queue.hold`, under the
  orchestrator's thread lock) and interrupts its active run. `FleetService`
  operations check the grant again right before they act. No credential carries it.
- Shift threads are always full-access. The MCP mode check stops a caller from
  acting on a thread broader than itself, and approvals need the widest mode.
  Every change Shift makes here is checked on the hub with
  `readHomeChangeCaller`: a live Shift run in full-access/default mode. A user
  who switches Shift to plan mode makes it read-only everywhere.
- Shift never launches into its own folder. That folder's AGENTS.md tells the
  agent it is Shift, so Shift must name a project or pass `scratch:true`.
- Shift thread ids start with `home:` so any client can label Shift's messages
  without knowing which environment sent them.

## Reaching other environments

Here, Shift's tool calls run like any agent's, plus what only Shift may do:
answer approvals and organize any thread (`FleetService`, through
`routeHome` in `mcp/homeRouting.ts`), list every project by default, and never
launch into its own folder.

Elsewhere, Shift uses upstream's linked environments: a tool call that names a
linked `environmentId` is forwarded server to server (`McpToolAccess.routed`),
and the other machine applies the link's access. Shift has no extra reach
there, so it cannot approve requests on another machine. Linked environments
replaced an earlier relay through the desktop renderer, which needed the window
open and duplicated upstream's forwarding.

Home's services are read with `Effect.serviceOption`, so upstream's toolkits
and tests build without them; where they are absent, no caller is Shift.

## Watches

Shift is woken by watched thread changes, not by polling. Watches live in
`ServerSettings.home`. Threads Shift launches are watched automatically with
reason `launched`.

The renderer evaluates watches, because it already streams thread shells from
every environment. It uses the same transitions as desktop notifications
(`components/home/homeWatch.ts`), batches events briefly, and reports them with
`home.reportWatchEvents`. `HomeService.report` drops unwatched events, ends
watches on settle or archive, and sends one message into Shift's thread with
`mode: "auto"`, which steers an active turn or queues behind it.

Two traps in the watch diff. Archived threads leave the shell list instead of
showing `archivedAt`, so a watched thread missing from a live environment's
list counts as ended; a cached or offline list proves nothing. And watching
everything may already hold a silent baseline for a thread when its launch
watch arrives, so a launch watch added while the app runs compares the thread
with an empty state the first time it sees it.

The hub picks the id of every thread Shift launches here, with the
`home-launched:` prefix, and saves the launch watch before the launch starts.
A launch on a linked machine is forwarded before Shift's handler runs, and only
that machine picks the id, so `HomeForwardedLaunches` saves the watch when the
launch returns (`mcp/ForwardedCalls.ts`). Those threads lack the prefix, so
clients may notify for them until the watch reaches them.
While Shift is on, clients skip notifications for prefixed threads. The prefix
travels with the thread, so this does not depend on settings reaching the
client before the thread does; separate streams give no such order.
