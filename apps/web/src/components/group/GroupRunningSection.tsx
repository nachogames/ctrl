import type { EnvironmentThreadGroup } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ExternalLinkIcon, XIcon } from "lucide-react";
import { useMemo } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { threadGroupCommands } from "~/state/threadGroups";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  RUNNING_FOOTNOTE,
  runningRowView,
  withoutManualResource,
  type RunningRowView,
} from "./GroupRunningSection.logic";

/**
 * The group's running servers and containers. Mounting subscribes, which makes
 * the server scan; unmounting stops it, so render it only while the panel shows.
 */
export function GroupRunningSection(props: {
  group: EnvironmentThreadGroup;
  threadRef: ScopedThreadRef;
}) {
  const { group } = props;
  const query = useEnvironmentQuery(
    useMemo(
      () =>
        threadGroupCommands.resources({ environmentId: group.environmentId, groupId: group.id }),
      [group.environmentId, group.id],
    ),
  );
  const rows = useMemo(() => (query.data?.resources ?? []).map(runningRowView), [query.data]);
  const openLink = useOpenLink(props.threadRef);
  const updateGroup = useOrchestrationCommand(threadGroupCommands.update, {
    reportFailure: false,
  });

  const open = (url: string) => {
    void openLink(url).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open the link",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  };

  const remove = async (manualId: string) => {
    const result = await updateGroup({
      environmentId: group.environmentId,
      input: {
        groupId: group.id,
        patch: { manualResources: withoutManualResource(group.manualResources, manualId) },
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to remove the resource",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };

  return (
    <>
      {rows.length === 0 ? (
        <p className="px-1.5 text-muted-foreground text-sm">Nothing running</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {rows.map((row) => (
            <RunningRow key={row.id} row={row} onOpen={open} onRemove={remove} />
          ))}
        </ul>
      )}
      <p className="mt-2 px-1.5 text-muted-foreground text-xs">{RUNNING_FOOTNOTE}</p>
    </>
  );
}

function RunningRow(props: {
  row: RunningRowView;
  onOpen: (url: string) => void;
  onRemove: (manualId: string) => Promise<void>;
}) {
  const { row } = props;
  const { openUrl, manualId } = row;
  return (
    <li className="flex min-w-0 list-none items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent/60">
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          row.tone === "running" ? "bg-success" : "bg-muted-foreground/40",
        )}
      />
      <span className="min-w-0 flex-1 truncate text-foreground text-sm">{row.name}</span>
      <span className="max-w-[45%] shrink-0 truncate font-mono text-muted-foreground text-xs">
        {row.detail}
      </span>
      {openUrl !== null ? (
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Open ${row.name}`}
          onClick={() => props.onOpen(openUrl)}
        >
          <ExternalLinkIcon />
        </Button>
      ) : null}
      {manualId !== null ? (
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Remove ${row.name}`}
          onClick={() => void props.onRemove(manualId)}
        >
          <XIcon />
        </Button>
      ) : null}
    </li>
  );
}
