import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PluginStatusItems, pluginToneClass } from "./PluginStatusItems";
import { useThreadPluginStatuses } from "./PluginThreadBand";

/**
 * The first status line plugins and Claude Code mods put on a thread, small
 * beside the row's other markers; the rest show on hover. It subscribes on
 * its own so a status change repaints this marker, not the row.
 */
export function SidebarPluginStatus(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const entries = useThreadPluginStatuses(props.environmentId, props.threadId);
  const first = entries[0]?.items[0];
  if (first === undefined) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={`max-w-24 shrink-0 truncate font-mono text-2xs ${pluginToneClass(first.tone)}`}
          />
        }
      >
        {first.text}
      </TooltipTrigger>
      <TooltipPopup side="top" variant="code">
        <div className="flex max-w-80 flex-col gap-0.5">
          <PluginStatusItems entries={entries} />
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
