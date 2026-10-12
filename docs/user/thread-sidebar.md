# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

When you change a new thread's project, T3 Code stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start without a project

A thread does not need a project. To start one without a project, click **or
start without a project** under a new thread's heading, pick **No project** from
the project menu in that heading or from **New thread in...** in the command
palette, or press `mod+alt+n`. On mobile, pick **No project** from the project
list. It starts on your current machine; before sending, pick another machine
from the machine menu to move it there. To move a draft into a project, pick the
project in the heading.

Each thread without a project works in its own folder under `~/.t3/scratch` (the
`scratch` folder of your T3 data directory), named after its date, the first words
of its first message, and a short id, like
`2026-09-25-convert-these-pngs-to-webp-a1b2c3d4`. Deleting a thread keeps its
folder, so the files the agent wrote stay until you delete them. Branch, worktree, and diff controls stay hidden because
these folders are not Git repositories. This is unavailable when the data
directory itself sits inside a Git checkout.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

To send the same prompt to several models on web or desktop, **Shift-click** models
in a new thread's model picker to add or remove them. A regular click returns to a
single model. Choose a base branch and send. Each selection starts a separate thread
and worktree while you stay in the new thread composer. This requires a Git project.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work.

On web and desktop, unpinning, settling, snoozing, and archiving a thread each show
a notification with **Undo** for five seconds. Undo restores the thread's previous
state, including its pinned position, and reopens an archived thread you were
viewing. Discarding an unsent draft from the sidebar works the same way: Undo brings
back its text and attachments. `mod+z` triggers the most recent Undo when no text field is focused; see
[Keybindings](./keybindings.md#commands-with-special-behavior).

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging, without moving the rows. The
other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

Drag within the pinned section to change its order. Other rows slide aside to show the spot
where the thread will land. On web and desktop, the active list is grouped by project and
sorted by recent activity, so a thread dropped there lands at its place in that order. On
mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; **Done** returns to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

On mobile, new threads appear above the active threads you have arranged. Settling clears a
thread's active position, so using **Un-settle** returns it to the top. Pinning and snoozing
preserve its active position until you move it again. Thread activity does not change that order.
The settled shelf continues to use settlement time.

If dragging is unavailable for one environment, update the T3 Code server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

To generate a fresh title from the conversation, open a thread's menu and choose
**Regenerate title**. The action is unavailable while title generation is in progress
or when the connected environment needs a server update.

Agents connected through T3 Code can use the same server-owned metadata workflow to
rename a thread, regenerate its title, or link and unlink a pull request. These changes
appear on web, desktop, and mobile without requiring the originating browser to remain
open.

### Fold working threads (beta)

Turn on **Settings → General → Working section (beta)** on web and desktop, or **Settings →
Thread behavior → Working section** on iOS and Android, to move threads that are working or
monitoring into a collapsed **Working** section below the active list. A thread leaves the
Working section when it finishes, fails, or needs an approval or answer: on mobile it returns to
the top of the active list, and on web and desktop to its place under its project. The Working
section lists the thread you last sent work to first. Pinned threads stay in the pinned section,
and chats in a group stay under their group. Each device keeps its own choice.

On mobile, while this is on, the active list is ordered by when each thread last came back to
you, so you cannot drag or move threads within it. Your saved order returns when you turn it off.

### Chat groups

A chat group holds the chats that work toward one goal, such as a planning chat and the chats
that build and review its work. Chats in a group share a project and a workspace: the group's
branch, worktree, and pull request. Groups are available on web and desktop.

Every chat has a **Group** panel, even one on its own (see below). A group shows up in the sidebar
only once it holds two chats. Until then the chat looks like any other, and setting a goal or
linking a ticket on it still works. If a group drops back to one chat, that chat becomes a plain
chat again and the group's pin, snooze, or settled state is cleared.

Groups only form when you ask for one:

- **Hand off to new chat**, from a chat's menu or the command palette, asks the agent to write a
  summary and continues the work in a fresh chat. The new chat goes directly above the one it
  continues, and both are in a group named after the original chat.
- Drag a chat onto a group row to move it into that group, or onto another active chat to group
  the two. Both chats must be in the same project.
- Choose **Move to group…** in a chat's menu to move it into one of its project's groups that
  already has two or more chats.
- Agents can do the same with the `t3_group_*` tools, for example to group a planning chat with
  the chat it launched, or to hand off when a chat grows long.

A new group takes the name of the chat that was already there. A group formed by setting a goal
gets a short name from the goal. You can rename it at any time.

When a chat moves into a group that works in another workspace, T3 Code asks first, then switches
the chat to the group's branch and worktree. A busy chat cannot switch.

Chats in a group sit under the group's row: in the active list beneath their project, or in
**Pinned**, **Snoozed**, or **Settled** wherever the group is. Click the row to show or hide its
chats; the group with the open chat stays open. Drag a chat within an expanded group to reorder
it; the order is saved and follows you across devices. New chats and chats joining a group go to
the top. A collapsed group shows its pull request number
and its most urgent status, and hovering it shows how many chats it holds. A chat that was handed
off is dimmed.

**New chat in group**, at the end of an expanded group, starts a chat on the group's branch and
worktree. It joins the group when you send its first message. The same action is in the group's
menu, in the chat header's group menu, and in the Group panel. You can bind the
`chat.newInGroup` command to a shortcut in [keybindings](./keybindings.md); it has none by
default.

The **Group** panel (`G`, the right panel launcher, or the command palette) shows the open chat's
group: its title and goal, which you can edit, cards for its branch, pull request, tickets, frontend, worktree and activity,
what is running for it, its chats, and the last handoff. **Link ticket** on the Tickets card adds
a Linear or GitHub issue link; issue numbers in the pull request title show up there on their own.
**Running** lists the servers the group's chats started and anything named for the group. Hover a
server to open or rename it, or to stop it when one of the group's chats started it; project
scripts that are not running offer **Start**. Other processes and Docker Compose containers in the
group's worktree are folded into one line; **Name it** moves one into the list. Running outlasts
handoffs, so the next chat can find the server the last one started.

On a chat that is not in a visible group, the panel shows the same cards for its workspace, its
Chats list is just that chat, and editing the title renames the chat. When other chats use the
same worktree, the panel says so and offers **Group them**. Nothing is grouped automatically.

Right-click a group to rename, pin, snooze, settle, or ungroup it. Settling a group settles its
chats, and un-settling it brings them back. A group also settles on its own once every chat in it
is settled. In a grouped chat's menu, **Pin group** and **Snooze group** act on the whole group,
while **Settle thread** still acts on that chat. **Remove from group** takes one chat out and
leaves it on its current branch and worktree. **Ungroup** removes the group and keeps every chat
where it is.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent. Settling also closes the thread's
terminals that wait at an idle prompt, and keeps their output. A terminal that
runs a command, such as a dev server, stays open.

To reclaim disk space from settled work, turn on **Run in the thread's worktree when the
thread settles** for one of the project's actions, or set `"runOnSettle": true` on a
`t3.json` script, for example `cargo clean`. It runs each time a thread in its own
worktree settles, manually or automatically, even if a terminal there still runs a
command such as a dev server. Threads in the project's main checkout skip it. Its terminal
closes when the command succeeds and stays open when it fails.

On web and desktop, press a thread's **Settle** button and drag up or down to
settle every thread in that section between it and the one you release on.
The **Un-settle** and **Wake** buttons work the same way in their sections.
Press `Escape` while dragging to cancel.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. Work in progress, pending questions or approvals, and live background work
prevent automatic settlement. An open pull request does not prevent inactivity
settlement, but an old closed or merged pull request does not settle work you
resumed after it closed. Only your own messages count as resuming. A turn that
finished background work or a pull request watch starts on its own does not.

To keep one thread out of the settled shelf no matter how long it sits idle, open its menu,
choose **Auto-settle behavior**, and pick **Disabled**. The current option is checked. Pick
**Enabled** to return to the usual rules. Manual settle, snooze, and archive still work while it
is disabled.

Change these rules in **Settings → General** on web and desktop, or **Settings → Thread behavior** on mobile.
They continue to run when your apps are closed. On web and desktop, choose an environment at the
top to change only its rules, or **All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Mobile applies these
rules to connected environments that support shared settings. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled threads.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

With more than one machine added, the machine button at the top of the sidebar
limits the list to one machine's projects and threads, for example to keep work and
personal machines apart. Each device remembers its own choice. The command palette
still searches every machine.

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments. Message search starts after two characters and
includes your messages and final agent responses.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise its thread ID. See [keybindings](./keybindings.md)
for custom configuration.

## Inspect agent work

**Limited** means the provider stopped on a usage or rate limit. The conversation
keeps the provider's explanation. Retry after the limit resets, or switch to
another provider instance.
On web and desktop, press **Resume** in an empty composer to continue a limited
or interrupted turn manually.
Queued messages stay saved while the limit blocks the thread. They run after
the continuation finishes. If the queue was held by a restart, resume it then.

When the provider reports a reset time, choose **Resume at reset** to schedule a
continuation. You can cancel it from the thread. Enable **Auto-resume limited
threads** in **Settings → General** on web and desktop, or **Settings → Thread
behavior** on mobile, to schedule limit stops by default.
The environment must be running when the reset arrives; it resumes overdue
continuations after a restart. Sending a new message, archiving, or settling the
thread prevents a pending continuation from starting.

Choose **Snooze until reset** to hide the thread until its allowance returns.
Snooze and auto-resume are independent: snooze alone wakes the thread without
sending a message; enabling both wakes and continues it. **Wake now** cancels
the snooze. Enable **Snooze limited threads** in thread behavior settings to
snooze limit stops by default. Providers without a reset time offer manual
retry and the normal snooze choices.

On web and desktop, use **Agents** to follow work delegated to subagents.
Stop on a thread also stops the subagents it delegated to.

Subagent threads started by the agent can't take messages; message the parent
thread instead. When such a subagent needs an approval or an answer, the parent
thread asks for it.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

## Snooze until later

Choose **Snooze → Custom…** from a thread's menu to pick a date and time in your
local time zone, or a duration in minutes, hours, or days. Durations start when
you confirm; one day means 24 hours. On web and desktop, you can also snooze
several selected threads together. Choose **Wake thread** to bring a thread back early.
