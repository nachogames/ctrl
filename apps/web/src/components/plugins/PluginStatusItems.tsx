import { type PluginStatusEntry, pluginUiSourceKey } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

/** Status items from plugins and Claude Code mods, each in its tone. */
export function PluginStatusItems(props: {
  readonly entries: ReadonlyArray<PluginStatusEntry>;
  readonly className?: string;
}) {
  return props.entries.flatMap((entry) =>
    entry.items.map((item) => (
      <span
        key={`${pluginUiSourceKey(entry.source)}:${item.key}`}
        className={cn("whitespace-pre", pluginToneClass(item.tone), props.className)}
      >
        {item.text}
      </span>
    )),
  );
}

export function pluginToneClass(tone: string | undefined): string {
  switch (tone) {
    case "success":
      return "text-success";
    case "warning":
      return "text-warning";
    case "error":
      return "text-destructive";
    case "info":
      return "text-info";
    default:
      return "text-muted-foreground";
  }
}
