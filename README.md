<p align="center"><img src="assets/prod/logo.svg" width="96" alt="Ctrl keycap logo"></p>

# Ctrl

Ctrl is a control surface for the coding agents on your machine (Claude Code, Codex, Cursor, Grok Build, OpenCode and Google Antigravity), with web, desktop and mobile clients.

> [!NOTE]
> **Ctrl is a personal fork of [T3 Code](https://github.com/pingdotgg/t3code).** Nearly everything here is the T3 team's work: Theo, Julius and every T3 Code contributor built the app, the server and the clients this fork stands on. Thank you. Ctrl adds a few features of its own (listed below) and tracks upstream closely. If you want the real thing, with support and the mobile apps in the stores, use [T3 Code](https://t3.codes). Bugs that also happen in T3 Code belong [upstream](https://github.com/pingdotgg/t3code/issues). T3 Code's MIT license and copyright notice are kept unchanged in [LICENSE](LICENSE).

Ctrl installs alongside T3 Code: it keeps its data in `~/.ctrl` (override with `T3CODE_HOME`) and uses its own app ids, so the two never share state. Ctrl shares the `t3code://` URL schemes with an installed T3 Code, so sign-in and deep links open whichever app registered last.

## What Ctrl adds

### Chat groups

Related chats, their branch, worktree, pull request and running processes live together in a group. The group panel shows it all in one place, and **Hand off to new chat** continues the work in a fresh chat without losing context.

<img src="assets/readme/chat-groups.png" alt="A chat group with its branch, pull request, worktree and activity in the group panel">

### PR review workspace

The Review tab collects every review of a pull request, from GitHub, Copilot and your agents, into numbered rounds of points. Linked pull requests fill it on their own, with no skill to install and no agent turn. Decide each point (fix, decline, discuss), ask about `#3` from any chat in the group or open a side chat for it, then **Apply** the round and the agent makes the fixes, pushes and posts the replies. When new commits land, open points go stale so they can be checked again.

Reviewing someone else's pull request works too. Run your own review, triage it against Copilot and the other reviewers, and **Prepare pending review** puts your new comments and +1 replies into a pending GitHub review for you to read and submit. It never touches the code. When the author asks again, **Re-review** checks your open threads against the new commits.

<img src="assets/readme/review-tab.png" alt="The Review tab showing round 1 of a pull request review with five points">

### Your pull requests, and only yours

The Pull Requests page has a **Mine** filter (under **Filters → Involvement**) that shows only pull requests you wrote or were asked to review, so other people's PRs in repos you merely cloned stay out of the way.

<img src="assets/readme/pull-requests-mine.png" alt="The Pull Requests page with the Mine involvement filter selected">

**Group → Project** sorts the list into one section per project.

<img src="assets/readme/pull-requests.png" alt="Pull requests grouped by project">

### Every machine, at a glance

Connect several computers and the sidebar can show one machine's chats at a time. Each machine reports its battery level and whether it's charging, so you can see which laptop is about to die before you start work on it. The Android app shows the same battery in the thread header and filter menu.

<img src="assets/readme/machines.png" alt="The sidebar machine filter listing Computer 1 (charging) and Computer 2 (low battery)" width="300">

### And smaller things

- Three keycap app icons (Outline, Solid, Mac) under **Settings → Appearance**.

  <img src="assets/readme/app-icon.png" alt="The app icon picker" width="600">

- Phone alerts sent directly from your server through Ctrl's push relay, with no T3 Connect. See [Mobile notifications](./docs/user/mobile-notifications.md).
- Signed desktop builds that update themselves, and Android updates over the air.

## Installation

### Ctrl

Download the latest build from [Ctrl releases](https://github.com/nachogames/ctrl/releases):

- **macOS (Apple silicon):** `Ctrl-<version>-arm64.dmg`. It updates itself from then on.
- **Android:** the signed `.apk` from the newest release that includes one. Later updates arrive over the air.

There are no Windows, Linux or iOS builds. Build those from source (see the end of this page).

> [!WARNING]
> Ctrl, like T3 Code, supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Official T3 Code

The commands below install **official T3 Code**, not Ctrl.

#### Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

Then run `t3` to start the server and open the local web app. `t3 service install` keeps it running in the background, `t3 update` moves to a newer release, and `t3 --help` has the full reference.

To try it once without installing, run `npx t3@latest` instead.

#### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

##### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

##### Windows (`scoop`)

```bash
scoop install extras/t3code
```

##### macOS (Homebrew)

```bash
brew install --cask t3-code
```

##### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then:

```bash
sudo apt install ./T3-Code-*.deb
```

##### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

Ctrl's own features:

- [Chat groups and the sidebar](./docs/user/thread-sidebar.md)
- [PR reviews in the Review tab](./docs/user/source-control.md#conversational-pr-reviews)
- [Mobile notifications and the push relay](./docs/user/mobile-notifications.md)

Inherited from T3 Code:

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run the server as a background service](./docs/user/background-service.md)

## Building from source

Ctrl uses [Vite+](https://viteplus.dev/guide/), so install the global `vp` tool first:

```bash
curl -fsSL https://vite.plus | bash   # macOS / Linux
irm https://vite.plus/ps1 | iex       # Windows (PowerShell)
```

Then install dependencies and start the server and web app:

```bash
vp i
vp run dev
```

Start at [docs/internals/overview.md](./docs/internals/overview.md) for how it fits together. Ctrl is a personal fork and isn't looking for contributions. Bugs that also happen in T3 Code belong [upstream](https://github.com/pingdotgg/t3code/issues).
