# Every chat is a group of one

Date: 2026-10-12. Builds on `2026-10-11-group-panel-glance-design.md`.

## Goal

Groups stop being a mode you opt into. Every chat has a Group panel; a
group only shows up in the sidebar once it actually holds two chats. Chats
inside a group can be reordered by drag, and a handoff puts the new chat
directly above the one it replaced. Groups are named after a chat (or its
goal), not a PR.

## Decisions (Neil, 2026-10-12)

- A solo chat's sidebar placement comes from the chat's own pin, snooze,
  and settle state.
- A solo chat's panel header is the chat title; editing it renames the chat.
- Chats that join a group land at the top; unordered groups read newest
  first.
- Group naming: handoff, drag, and Move to group… use the existing chat's
  title. A group created because a goal was set is named from the goal by the
  existing cheap title generator.
- The "chats share a worktree" suggestion lives in the panel only, and
  never groups anything without a click.
- Everything else below is the agent's call.

## Model and visibility

- **Visible group** means a group with at least 2 non-archived members. Only
  visible groups get a sidebar group row, appear in Move to group…, or show a
  group name in the panel header.
- A group with exactly one non-archived member (a _hidden group_) renders as
  a plain chat row. Its goal, tickets, manual resources, and last handoff
  still feed that chat's panel.
- The server already deletes a group at 0 members. That stays as it is.
- When a group drops to one non-archived member, the server clears the
  group's `pinnedAt`, `snoozedUntil`, and `settledAt`, so a stale group state
  can't come back when it grows again. A group that grows to 2 starts Active.
  This runs in the existing prune path, which now also runs on
  `thread.archived` and `thread.unarchived`.
- Existing one-member groups need no migration. They become hidden groups.

## Naming

`defaultThreadGroupTitle` no longer uses the PR title. Its order is:

1. the title of the chat that was already there;
2. the humanized branch;
3. "Untitled group".

- **Handoff** names the group after the source chat, never the
  "Continue: …" chat.
- **Drag onto a chat** names it after the target chat.
- **Goal set on a solo chat** (panel or `t3_group_update`) creates the group
  with the chat's title. It then runs one best-effort title generation from
  the goal and updates the title only if it is still the fallback. A failed
  generation leaves the chat title in place.
- A name is decided once, when the group is created. A group that drops to
  one chat and grows again keeps its name.

## Order inside a group

- **Storage:** a new nullable `groupOrderKey` on threads, in a
  `group_order_key` projection column, using the same pattern as
  `pin_order_key`.
- **Command:** `thread.group.reorder { threadId, orderKey }` (client
  guarded). It does not bump `updatedAt`.
- **Shared keys:** the fractional-key helpers (`pinOrderKeyBetween`,
  `generateSpreadPinOrderKeys`) move to `packages/shared` so the server can
  make keys.
- **Sort:** keyless chats come first, newest first, with a handed-off chat
  directly under the chat that replaced it. Keyed chats follow, by key. An
  unordered group therefore reads newest first.
- **Drag (web):** member rows of an expanded group are sortable, using the
  same dnd-kit behavior as Pinned.
  - On the first drag in a group that has keyless members, the client writes
    spread keys for the whole group in its visible order, then moves the
    dragged chat. This is the `planPinnedReorder` rule.
  - Dropping on a chat in a different group still means join that group.
- **Server placement:**
  - _Joining_ (create, New chat in group, drag, Move to group…, agent move):
    if the group has keys, the chat gets a key before the first one. If not,
    it stays keyless and lands at the top as the newest.
  - _Handoff:_ if the group has keys, the new chat gets a key between the
    source and the chat above it. If not, the default order already puts it
    above the source.
  - _Leaving_ the group clears the key.

## Panel for every chat

- **G everywhere:** the Group launcher entry and the `G` shortcut work for
  every chat.
- **Solo panel:** a chat with no visible group gets a panel view built on the
  client from the chat and its hidden group, if any.
  - Header: the chat title, with edit renaming the chat.
  - Goal: editing creates the hidden group when there is none.
  - Glance cards: Branch, PR, and Worktree come from the chat (the hidden
    group's values win when set). Tickets come from the hidden group's links;
    adding one creates the hidden group.
  - Activity: this chat only.
  - Chats: just this chat.
  - Last handoff: only when there is one.
- **Running for a solo chat:** the resources subscription accepts either a
  group id or a thread id. A thread scope means members = {thread} and
  worktree = the chat's worktree.
- **Suggestion:** under Chats, a solo panel whose chat uses a dedicated
  worktree (not the project root) lists the count of other non-archived chats
  in the project on the same worktree that are not in a visible group:
  "2 other chats use this worktree · Group them". One click creates a group
  of all of them. Nothing is suggested otherwise.

## Sidebar and menus

- `partitionThreadsByGroup` and section resolution treat hidden groups as
  ungrouped chats.
- Drag onto a lone chat that has a hidden group joins that group instead of
  creating a new one.
- Move to group… lists only visible groups. "New group with this chat" is
  removed, because it would create an invisible group.
- "Remove from group" stays.

## Agents (MCP)

- **`t3_group_update` on a solo chat:**
  - with a goal or links: creates the hidden group first;
  - with only `settled` or `pinned`: still requires a group.
- **`t3_group_read` on a solo chat:** returns `{ group: null, threadIds:
[self] }` instead of an error.
- `t3_group_handoff` already works from a solo chat. It now gets the new
  naming and order.

## Out of scope

Mobile (groups are still web and desktop only), automatic grouping, and the
existing follow-ups from PR #8 and PR #9.

## Testing

- **Server:**
  - prune clears group state at one live member, and runs on archive;
  - the default title has no PR;
  - handoff and join assign order keys correctly;
  - the reorder command keeps `updatedAt` unchanged.
- **Client runtime:**
  - member sort (keyless newest first, handoff successor above its source,
    keyed after);
  - group visibility counting.
- **Web logic:**
  - partition and section with hidden groups;
  - the reorder plan;
  - the drop target for a hidden group;
  - Move-to-group lists only visible groups;
  - the suggestion count.
- **Docs:** update "Chat groups" in `docs/user/thread-sidebar.md`.
