# Group panel: at-a-glance cards and a Running list you can trust

Date: 2026-10-11
Status: design approved in Claude Design, awaiting spec review
Design: https://claude.ai/artifact/DVquojGscmnBVHYKwKUAAm (frames: in context, new group,
just stopped, tile states, handoff expanded, narrow pane)
Builds on: [2026-10-10-chat-groups-design.md](2026-10-10-chat-groups-design.md)

## Problem

The Group panel shipped with Plans 2, 4 and 5 lists facts as plain rows. It doesn't answer
"where is this work at" in one look. The Running section names things by process
(`node :6954`), can't start anything, and mixes what a group chat started with anything
that merely runs in the worktree. The last handoff renders as one wall of text.

## Goals

- A block of at-a-glance cards at the top: branch, pull request, tickets, frontend,
  worktree, activity.
- A Running list whose main rows are things Ctrl knows belong to the group, named properly,
  with Start, Open, Rename and Stop where Ctrl can honestly do them.
- Anything that starts or stops, however it was started, shows up or disappears without the
  user doing anything.
- The panel stays readable when the right pane is narrow.

## Non-goals

- Ticket status or two-way ticket sync. Tickets are links only. A later change can read
  status from Linear without changing the card.
- Controlling processes Ctrl didn't start. They can be shown and named, not stopped.
- Exit codes. Ctrl doesn't learn them for terminal processes, so the "exit 0" in the
  design's just-stopped frame is dropped.
- Mobile.

## Layout

Top to bottom: header (name, goal, edit), glance cards, Running, Chats, Last handoff. The
Workspace section from Plan 2 is replaced by the cards.

### Glance cards

Two columns of cards at 440px and wider: lighter fill, hairline border, rounded corners,
8px gaps, no shadows. Below 440px the six cards become one card with six short rows, one
fact per row with an icon, and the row's action replacing its right-hand text on hover. The
switch is a CSS container query on the panel, so no width plumbing is needed.

| Card         | Shows                                                                   | Action                                      | Empty state                         |
| ------------ | ----------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------- |
| Branch       | branch name; `N ahead · N behind <base>`                                | copy branch                                 | "No branch" (root workspace)        |
| Pull request | `#N title`; state pill (Open / Draft / Merged / Closed); checks summary | open PR                                     | "No pull request"                   |
| Tickets      | a chip per link (Linear key, `#N` for GitHub)                           | open link; "Link ticket"                    | "No tickets linked" + "Link ticket" |
| Frontend     | dot + `localhost:PORT` when running                                     | open in preview; Start when stopped         | "No frontend script" + "Set up"     |
| Worktree     | path, middle-truncated; `N changes`                                     | reveal in Finder (desktop), copy path (web) | "Project folder" for root groups    |
| Activity     | `N working · N idle`; last activity time                                | none                                        | "No activity yet"                   |

Where the data comes from:

- **Branch and Worktree** use the existing VCS status subscription (`vcsEnvironment.status`)
  on the group's worktree path: `aheadCount`, `behindCount`, `workingTree.files.length`.
- **Pull request** uses `useGroupPullRequestStatus`, including the member-PR fallback. The
  checks text reuses `describePullRequestChecks`. Failing checks are amber; Draft and Closed
  are grey; Merged is purple.
- **Tickets** come from links stored on the group. The user pastes a URL with "Link ticket",
  or an agent adds it with `t3_group_update`. GitHub issue references in the PR title
  (`#88`, `Fixes #88`) are added automatically, linking to the PR's repository. The chip
  label comes from the URL: the Linear issue key, or `#N` for GitHub.
- **Frontend** is the project script that has a `previewUrl`. It is "running" when a
  listener on that URL's port belongs to the group (next section). Start runs that script.
  With no such script, "Set up" opens the project's scripts editor.
- **Activity** counts member chats by their existing status and uses the group's activity
  time.

### Running

Two tiers:

1. **Known**, shown in the main list. Ctrl knows these belong to the group:
   - a server whose terminal belongs to a member chat;
   - a resource registered or named for the group.
     Each row has a dot, the name, the port in monospace on the right, and "started by <chat>"
     underneath. Below 440px that line moves into a tooltip. On hover the port gives way to
     Open, Rename and, when Ctrl started it, Stop.
2. **Found in the worktree**, folded into one line, "N other processes in this worktree ·
   node, postgres, redis", with Show. These are servers running inside the worktree folder
   (matched by working directory) and containers whose compose file is there. They are
   hidden by default. Naming one ("Name it") moves it to the known list.

Below the known rows, each runnable project script that isn't running gets a row with a grey
dot and Start. Setup and settle scripts (`runOnWorktreeCreate`, `runOnSettle`) are excluded.

**Names**, in priority order:

1. A name the user or an agent gave it. This is stored as a group manual resource whose URL
   matches the server's port.
2. The project script's name, when Ctrl started it from a script. Script runs from the pane
   use the terminal id `script-<scriptId>`, matching the existing `setup-` and `settle-`
   conventions, so the server can map the terminal back to the script.
3. The terminal's label: the running command, such as `vp run dev`.
4. The process name and port, such as `node :6954`.

**Start** runs the script in a terminal on the current chat, in the group's workspace, with
id `script-<scriptId>`. If that terminal already exists, Start reuses it. **Stop** sends an
interrupt (Ctrl-C) to the owning terminal, and is offered only when the server is attributed
to a member chat's terminal. **Restart** re-runs the script, and is offered only for
script-started servers. **Rename** writes a manual resource. **Open** opens the URL in the
preview pane.

**Stopping is noticed.** When a known row disappears from the scan, the client keeps it for
30 seconds, greyed with the port struck through and "stopped 10s ago". A script-started row
also gets Restart. After that the row returns to the script's Start row, or goes away.

Footnote: "Anything started in this group's worktree or chats shows up here, however it was
started."

### Chats

Chats stay as they are, with one-line rows at narrow widths. The two actions keep their
current labels and shorten to "New chat" and "Hand off" below 440px.

### Last handoff

The note is collapsed to three lines, with "Show more". Expanded, lines that start with a
known heading become small bold labels, each followed by its text: `Goal`, `Current state`,
`Next steps` (kept as a list), and `Don't touch` / `Must not touch` in amber. Other text
renders as is. The footer reads "from <chat> · 11h ago".

## Data and plumbing

- **Contracts.**
  - `ThreadGroupRunningResource` gains:
    - `tier: "known" | "found"`;
    - `terminal: { threadId, terminalId } | null`;
    - `startedByThreadId: ThreadId | null`;
    - `scriptId: string | null`;
    - `port: number | null`.
  - The thread group gains `links: Array<{ id, url, label }>`, edited through the existing
    `update` mutation.
- **Server.**
  - `GroupResourceScanner` sets the tier and keeps the terminal reference. It resolves
    names in the order above, using the project's scripts and the terminal labels the
    terminal manager already has.
  - A manual resource matching a scanned server's port now names that row. It no longer
    gets replaced by it.
  - `t3_group_update` gains `links` (add/remove) and `t3_group_read` returns them.
  - The `t3_group_resource` description asks agents to register servers they start, with a
    clear name.
- **Web.**
  - `GroupGlanceCards.tsx`, with the card and compact layouts.
  - A reworked `GroupRunningSection.tsx`.
  - `GroupHandoffSection` with the collapse and heading parsing.
  - Logic files hold the naming, the tiers, the stopped-row timer and the ticket-label
    parsing.
- **Performance.** No new polling. The cards reuse the subscriptions the panel already
  holds or that other surfaces already open. The Running subscription stays mounted only
  while the panel is visible, as today.

## Error handling

- VCS status unavailable: Branch and Worktree show the branch name and path without counts.
- PR provider not signed in: the Pull request card shows "Sign in to see checks" in place of
  the checks line.
- Start fails to open a terminal: a toast, and the row stays on Start.
- Stop on a terminal that is already gone: the row drops at the next scan, with no error.
- Ticket URL that isn't a URL: "Link ticket" refuses it inline.

## Testing

- **Logic tests:**
  - name resolution order;
  - the tier split;
  - script-terminal id mapping;
  - the stopped-row timer;
  - ticket label parsing (Linear URL, GitHub issue URL, `#N` in a PR title);
  - handoff heading parsing;
  - the card-to-compact row model.
- **Server tests:** scanner tiering and naming with injected listeners, terminals and
  scripts; the manual-resource rename match; `links` through `update` and the MCP tools.
- **Browser pass, headless only, against a dev server:**
  - wide and narrow panel screenshots;
  - start the dev script from the pane and see it named;
  - stop it and see the stopped row;
  - start a `python3 -m http.server` in the worktree outside Ctrl and see it under "other
    processes".
