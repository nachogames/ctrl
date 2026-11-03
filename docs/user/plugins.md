# Plugins

Plugins change Ctrl's own interface. A plugin can add:

- a **view**, shown as a tab in the right panel
- a **status line** on a thread, shown above the composer and on the thread's sidebar row
- a **toast**
- a **band** above a thread's composer, with buttons
- a **`/` command** in the composer menu

Plugins run on web and desktop. The mobile app does not show them yet.

## Start a plugin

The easiest way is to ask an agent: "Write a Ctrl plugin that shows …". Agents on every provider
can call `t3_plugin_list`, which returns the plugins folder and a guide to writing a plugin, and
`t3_plugin_reload`, which returns load errors and recent log lines so the agent can fix them.

A plugin is a folder in `plugins` inside your Ctrl home folder (`~/.ctrl/plugins` for the
desktop app). Ctrl watches the folder. When a plugin is added or a file changes, Ctrl loads it
again. You do not need to restart Ctrl. For the same reason, a plugin keeps files it writes in
`ctx.plugin.dataDir`, not in its own folder.

Settings → Tools → Plugins lists each plugin, shows why one failed to load, and turns it on
or off.

## A small plugin

`~/.ctrl/plugins/hello/t3-plugin.json`:

```json
{
  "id": "me.hello",
  "name": "Hello",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "index.mjs",
  "views": [{ "id": "main", "title": "Hello", "html": "view.html" }],
  "commands": [
    {
      "name": "standup",
      "description": "Ask for a standup summary",
      "prompt": "Summarize what changed today."
    },
    { "name": "wave", "description": "Wave at this thread" }
  ]
}
```

`index.mjs` runs in its own Node process:

```js
export function activate(ctx) {
  ctx.onEvent((event) => {
    if (event.type === "run") ctx.ui.setStatus(event.threadId, "run", `run ${event.status}`);
  });
  ctx.onCommand("wave", ({ threadId }) => {
    ctx.ui.toast({ title: "Hello!", threadId, tone: "success" });
    ctx.ui.setBand(
      threadId,
      ctx.ui.h(
        "Box",
        { gap: 1 },
        "Waved.",
        ctx.ui.h("Button", { label: "Clear", onPress: () => ctx.ui.setBand(threadId, null) }),
      ),
    );
  });
  ctx.handle("time", () => new Date().toLocaleTimeString());
}
```

`view.html` uses the app's theme, and calls the plugin through `t3`:

```html
<p>It is <span id="time"></span>.</p>
<script>
  t3.call("time").then((time) => (document.getElementById("time").textContent = time));
</script>
```

## Claude Code mods

Claude Code mods that draw a status line, a toast or the band above the prompt draw them in the
same places in Ctrl. Mod panes are not shown yet.

## Trust

A plugin's `entry` runs with your user's full access, the same as any program you install. Only
add plugins you trust. Views run in a sandboxed frame and can reach the machine only through their
own plugin.
