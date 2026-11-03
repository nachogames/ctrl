import {
  type EnvironmentId,
  PLUGIN_BAND_COLUMNS,
  type PluginStatusEntry,
  pluginUiSourceKey,
  type ThreadId,
} from "@t3tools/contracts";

import { pluginEnvironment } from "~/state/plugins";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { MONO_CH_EM, PluginBandTree } from "./PluginBandTree";
import { PluginStatusItems } from "./PluginStatusItems";

/**
 * What plugins and Claude Code mods draw above this thread's composer: their
 * bands, then their status lines. Draws nothing when there is neither.
 */
export function PluginThreadBand(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const bands =
    useEnvironmentQuery(pluginEnvironment.bands({ environmentId, input: { threadId } })).data
      ?.bands ?? [];
  const statuses = useThreadPluginStatuses(environmentId, threadId);
  const press = useAtomCommand(pluginEnvironment.pressBand, {
    reportFailure: false,
    reportDefect: false,
  });

  if (bands.length === 0 && statuses.length === 0) return null;

  return (
    <div className="mx-auto mb-1.5 flex w-full max-w-208 flex-col gap-1 px-1 font-mono text-xs leading-tight">
      {bands.map((band) => (
        <div
          key={pluginUiSourceKey(band.source)}
          className="overflow-x-auto rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 leading-none [container-type:inline-size]"
        >
          {/* Shrinks below text-xs when the composer is narrower than the band's columns. */}
          <div
            style={{
              fontSize: `min(0.75rem, calc(100cqi / ${PLUGIN_BAND_COLUMNS * MONO_CH_EM}))`,
            }}
          >
            <PluginBandTree
              tree={band.tree}
              onPress={(target, key) => {
                void press({
                  environmentId,
                  input: {
                    threadId,
                    source: band.source,
                    target,
                    ...(key === undefined ? {} : { key }),
                  },
                });
              }}
            />
          </div>
        </div>
      ))}
      {statuses.length === 0 ? null : (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-1">
          <PluginStatusItems entries={statuses} />
        </div>
      )}
    </div>
  );
}

const EMPTY_STATUSES: ReadonlyArray<PluginStatusEntry> = [];

/** The status entries plugins and mods put on one thread. */
export function useThreadPluginStatuses(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<PluginStatusEntry> {
  const statuses =
    useEnvironmentQuery(pluginEnvironment.snapshot({ environmentId, input: {} })).data?.statuses ??
    EMPTY_STATUSES;
  const own = statuses.filter((entry) => entry.threadId === threadId);
  return own.length === 0 ? EMPTY_STATUSES : own;
}
