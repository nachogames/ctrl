# Shift

Shift is an agent that works across all of your projects, on this machine and on
the machines you link to it. Ask it to start threads, check on them, answer
their questions, approve their requests, rename, settle, snooze or archive them.

## Start Shift

Shift runs in the desktop app. Open **Settings → Shift**, choose a model and turn
on the switch. Change the model there at any time, or with the model picker in
Shift's composer; the conversation carries over. Shift then sits at the top of the sidebar. Open it from there, from the
command palette, or with its keyboard shortcut.

Shift always runs in full access. It can approve requests in your other threads,
so choose a model you trust with that.

## What Shift does on its own

- Threads Shift starts are normal threads in your sidebar. You can open and steer
  them yourself.
- Shift links every thread it mentions. Click a link to open that thread, on any
  of your machines.
- Shift hears about the threads it started when they finish, fail, ask a question
  or need an approval. The desktop app does not notify you about those threads; Shift
  tells you what matters in its own thread.
- Shift leaves the threads you started alone. Ask it to watch a thread, or every
  thread, when you want it to step in.
- Shift cannot delete threads or projects.

## Talk to Shift

Click the waveform button in Shift's composer, or press `F8`, and talk. Shift
answers quick questions itself and hands bigger thinking to a stronger agent,
then tells you the short version. It works like [voice](./composer.md#voice) in
any thread:

- With a Codex model for Shift, you talk with Codex's own voice. It runs on your
  ChatGPT sign-in and needs no setup.
- With any other model, turn on **Dictation** and **Spoken replies** in
  **Settings → Devices** first. They run on your machine at no cost, and download
  a local voice the first time (dictation downloads nothing on macOS 26 or later).

## Other machines

Shift works on your other machines through
[linked environments](./remote-access.md#link-another-environment). Turn on
**Linked environments** in **Settings → Labs** on both machines, then link the
other machine from the one running Shift. Links last 30 days.

On a linked machine Shift can do what the link's access allows, like any agent
there. It cannot approve requests there, and it reaches that machine even when
the desktop app is closed.

Shift hears about threads on other machines through the desktop app, which
stays connected to them. Threads Shift starts there are watched for it, and you
can ask it to watch any thread there. On macOS, closing the window keeps Shift
listening until you quit.

In voice mode, Shift's quick voice also answers about threads on your linked machines. A machine
that is offline, expired, or slow to answer is left out, and the voice says so.

## Instructions and fresh starts

**Settings → Shift → Instructions** opens Shift's `AGENTS.md`. Add standing
instructions below T3 Code's section. Shift can also keep notes in its folder.

**New Shift chat** gives Shift a clean conversation with the same model. The old thread
stays in your history, and its notes and instructions carry over.

Turning Shift off stops it from acting. Its thread stays in your history.
