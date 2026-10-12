import type { EnvironmentThreadGroup } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type ProjectScript,
  type ScopedThreadRef,
  type ThreadGroupId,
  type ThreadGroupRunningResource,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  PencilIcon,
  PlayIcon,
  RotateCwIcon,
  SquareIcon,
  TagIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useEnvironmentScope } from "~/state/session";
import { threadGroupCommands } from "~/state/threadGroups";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GroupInlineEdit } from "./GroupInlineEdit";
import {
  NO_STOPPED_TRACKING,
  RUNNING_FOOTNOTE,
  expireStoppedRows,
  observeScan,
  renameManualResources,
  runningView,
  type FoundRow,
  type KnownRow,
} from "./GroupRunningSection.logic";
import type { GroupScriptRunner } from "./useGroupScriptRunner";
import type { ScriptStartState } from "./useGroupScriptRunner.logic";
import { useOpenServerUrl } from "./useOpenServerUrl";

function errorToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * The group's running servers: known rows, the folded worktree processes, and
 * Start rows for scripts that are not running. `resources` comes from the panel's
 * one scan subscription; null until the first scan arrives. A solo chat without
 * a group passes a null `id`; naming a server then creates its hidden group.
 */
export function GroupRunningSection(props: {
  group: Pick<EnvironmentThreadGroup, "environmentId" | "manualResources"> & {
    readonly id: ThreadGroupId | null;
  };
  ensureGroup: () => Promise<ThreadGroupId | null>;
  threadRef: ScopedThreadRef;
  resources: ReadonlyArray<ThreadGroupRunningResource> | null;
  error: string | null;
  scripts: ReadonlyArray<ProjectScript>;
  runner: GroupScriptRunner;
  chatTitles: ReadonlyMap<ThreadId, string>;
}) {
  const { group, runner } = props;
  // The last scan lives in this state, not a ref: the updater runs during the next
  // render, when a ref written beside it would already hold this scan.
  const [tracking, setTracking] = useState(NO_STOPPED_TRACKING);
  const { stopped } = tracking;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const next = props.resources;
    if (next === null) return;
    const at = Date.now();
    // oxlint-disable-next-line react/set-state-in-effect -- Diffs each scan against the last; the clock read keeps render pure.
    setNow(at);
    setTracking((current) => observeScan(current, next, at));
  }, [props.resources]);
  const hasStopped = stopped.length > 0;
  // Ticks only while a stopped row is shown, to age its label and let it go.
  useEffect(() => {
    if (!hasStopped) return;
    const id = setInterval(() => {
      const at = Date.now();
      setNow(at);
      setTracking((current) => ({ ...current, stopped: expireStoppedRows(current.stopped, at) }));
    }, 5_000);
    return () => clearInterval(id);
  }, [hasStopped]);
  const view = useMemo(
    () =>
      runningView({
        resources: props.resources ?? [],
        stopped,
        scripts: props.scripts,
        manual: group.manualResources,
        chatTitles: props.chatTitles,
        currentThreadId: props.threadRef.threadId,
        now,
      }),
    [
      group.manualResources,
      now,
      props.chatTitles,
      props.resources,
      props.scripts,
      props.threadRef.threadId,
      stopped,
    ],
  );
  const [showFound, setShowFound] = useState(false);

  const openServer = useOpenServerUrl(props.threadRef);
  // Naming and removing change the group, which takes orchestration access.
  const canOrchestrate = useEnvironmentScope(group.environmentId, AuthOrchestrationOperateScope);
  const removeResource = useOrchestrationCommand(threadGroupCommands.removeResource, {
    reportFailure: false,
  });
  const updateGroup = useOrchestrationCommand(threadGroupCommands.update, {
    reportFailure: false,
  });

  const open = (url: string) => {
    void openServer(url).catch((error: unknown) => errorToast("Unable to open the link", error));
  };

  const remove = async (manualId: string) => {
    // Manual resources live on a group, so one without a group has none to remove.
    if (group.id === null) return;
    // Only the id goes to the server, which removes it under the group's lock.
    const result = await removeResource({
      environmentId: group.environmentId,
      input: { groupId: group.id, resourceId: manualId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      errorToast("Failed to remove the resource", squashAtomCommandFailure(result));
    }
  };

  /** Names whatever runs on `port`; an empty or unchanged name cancels. */
  const rename = async (port: number, current: string, draft: string) => {
    const name = draft.trim();
    if (name === "" || name === current) return;
    const groupId = group.id ?? (await props.ensureGroup());
    if (groupId === null) return;
    const result = await updateGroup({
      environmentId: group.environmentId,
      input: {
        groupId,
        patch: { manualResources: renameManualResources(group.manualResources, { port, name }) },
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      errorToast("Failed to rename", squashAtomCommandFailure(result));
    }
  };

  const scriptById = (scriptId: string) =>
    props.scripts.find((script) => script.id === scriptId) ?? null;

  const { found } = view;
  const empty = view.known.length === 0 && found === null && view.start.length === 0;
  return (
    <>
      {/* Before the first scan arrives nothing is known, so claim nothing. */}
      {props.resources === null ? (
        <p className="px-1.5 text-muted-foreground text-sm">
          {props.error === null ? "Checking…" : "Could not check what is running"}
        </p>
      ) : empty ? (
        <p className="px-1.5 text-muted-foreground text-sm">Nothing running</p>
      ) : (
        <>
          {view.known.length > 0 || view.start.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {view.known.map((row) => {
                const restartScript =
                  row.restart === null ? null : scriptById(row.restart.scriptId);
                const restartThreadId = row.restart?.threadId ?? null;
                return (
                  <KnownRunRow
                    key={row.id}
                    row={row}
                    canOperate={runner.canOperate}
                    canOrchestrate={canOrchestrate}
                    restartState={
                      row.restart === null ? "idle" : runner.startState(row.restart.scriptId)
                    }
                    onOpen={open}
                    onRename={(port, draft) => void rename(port, row.name, draft)}
                    onStop={(terminal) => void runner.stop(terminal)}
                    onRemove={(manualId) => void remove(manualId)}
                    onRestart={
                      restartScript === null || restartThreadId === null
                        ? null
                        : () => void runner.start(restartScript, restartThreadId)
                    }
                  />
                );
              })}
              {view.start.map((row) => {
                const script = scriptById(row.scriptId);
                const state = runner.startState(row.scriptId);
                return (
                  <li
                    key={row.scriptId}
                    className="flex min-w-0 list-none items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent/60"
                  >
                    <StatusDot running={false} />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">
                      {row.name}
                    </span>
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      disabled={!runner.canOperate || script === null || state !== "idle"}
                      onClick={() => {
                        if (script !== null) void runner.start(script, props.threadRef.threadId);
                      }}
                    >
                      <PlayIcon aria-hidden />
                      {START_LABEL[state]}
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {found !== null ? (
            <div className="mt-1.5 border-border border-t pt-1">
              <div className="flex min-w-0 items-center gap-2 px-1.5">
                <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
                  {found.label}
                </span>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  aria-expanded={showFound}
                  onClick={() => setShowFound((shown) => !shown)}
                >
                  {showFound ? "Hide" : "Show"}
                  <ChevronDownIcon aria-hidden className={cn(showFound && "rotate-180")} />
                </Button>
              </div>
              {showFound ? (
                <div className="mt-1 ml-3 border-border border-l pl-2">
                  <p className="px-1.5 py-1 text-muted-foreground text-xs">
                    Not started by a chat or run script. Shown because they run inside this
                    worktree.
                  </p>
                  <ul className="flex flex-col gap-0.5">
                    {found.rows.map((row) => (
                      <FoundRunRow
                        key={row.id}
                        row={row}
                        canOrchestrate={canOrchestrate}
                        onOpen={open}
                        onName={(port, draft) => void rename(port, row.name, draft)}
                      />
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
      <p className="mt-2 px-1.5 text-muted-foreground text-xs">{RUNNING_FOOTNOTE}</p>
    </>
  );
}

/** Start reads "Starting…" until the scan shows the server, and "Running" while its terminal is busy. */
const START_LABEL: Record<ScriptStartState, string> = {
  idle: "Start",
  starting: "Starting…",
  busy: "Running",
};

function StatusDot(props: { running: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        props.running ? "bg-success" : "bg-muted-foreground/40",
      )}
    />
  );
}

/**
 * The port (or detail) on the right, which gives way to `actions` while the row is
 * hovered or focused. The actions stay in the tab order while visually hidden, so
 * keyboard focus reaches them and reveals them.
 */
function RowEnd(props: { label: string; struck?: boolean; actions: ReactNode | null }) {
  return (
    <>
      <span
        className={cn(
          "max-w-[45%] shrink-0 truncate font-mono text-muted-foreground text-xs",
          props.struck && "line-through",
          props.actions !== null && "group-hover/run:hidden group-focus-within/run:hidden",
        )}
      >
        {props.label}
      </span>
      {props.actions !== null ? (
        <span className="sr-only flex shrink-0 items-center gap-0.5 group-hover/run:not-sr-only group-focus-within/run:not-sr-only">
          {props.actions}
        </span>
      ) : null}
    </>
  );
}

function KnownRunRow(props: {
  row: KnownRow;
  canOperate: boolean;
  canOrchestrate: boolean;
  restartState: ScriptStartState;
  onOpen: (url: string) => void;
  onRename: (port: number, draft: string) => void;
  onStop: (terminal: NonNullable<KnownRow["stopTerminal"]>) => void;
  onRemove: (manualId: string) => void;
  onRestart: (() => void) | null;
}) {
  const { row } = props;
  const { openUrl, stopTerminal, port } = row;
  const canRename = row.canRename && props.canOrchestrate;
  const manualId = props.canOrchestrate ? row.manualId : null;
  const nameId = props.canOrchestrate ? row.nameId : null;
  const [editing, setEditing] = useState(false);
  const stopped = row.state === "stopped";
  const actions =
    openUrl === null &&
    !canRename &&
    stopTerminal === null &&
    manualId === null &&
    nameId === null ? null : (
      <>
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
        {canRename && port !== null ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Rename ${row.name}`}
            onClick={() => setEditing(true)}
          >
            <PencilIcon />
          </Button>
        ) : null}
        {nameId !== null ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Remove the name ${row.name}`}
            onClick={() => props.onRemove(nameId)}
          >
            <TagIcon />
          </Button>
        ) : null}
        {stopTerminal !== null ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Stop ${row.name}`}
            disabled={!props.canOperate}
            onClick={() => props.onStop(stopTerminal)}
          >
            <SquareIcon />
          </Button>
        ) : null}
        {manualId !== null ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Remove ${row.name}`}
            onClick={() => props.onRemove(manualId)}
          >
            <XIcon />
          </Button>
        ) : null}
      </>
    );
  return (
    <li
      className={cn(
        "group/run flex min-w-0 list-none items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent/60",
        stopped && "opacity-60",
      )}
    >
      <StatusDot running={row.state === "running"} />
      {editing && port !== null ? (
        <GroupInlineEdit
          label={`Name for ${row.name}`}
          initial={row.name}
          className="text-sm"
          onCommit={(draft) => {
            setEditing(false);
            props.onRename(port, draft);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <span className="flex min-w-0 flex-1 flex-col">
            {/* Below 440px the note line hides, so the name's tooltip carries it. */}
            <Tooltip disabled={row.note === null}>
              <TooltipTrigger
                render={<span className="min-w-0 truncate text-foreground text-sm" />}
              >
                {row.name}
              </TooltipTrigger>
              <TooltipPopup>{row.note}</TooltipPopup>
            </Tooltip>
            {row.note !== null ? (
              <span className="hidden truncate text-muted-foreground text-xs @min-[440px]/group-panel:block">
                {row.note}
              </span>
            ) : null}
          </span>
          <RowEnd
            label={port === null ? row.detail : `:${port}`}
            struck={stopped}
            actions={actions}
          />
          {props.onRestart !== null ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={!props.canOperate || props.restartState !== "idle"}
              onClick={props.onRestart}
            >
              <RotateCwIcon aria-hidden />
              {props.restartState === "starting" ? "Starting…" : "Restart"}
            </Button>
          ) : null}
        </>
      )}
    </li>
  );
}

function FoundRunRow(props: {
  row: FoundRow;
  canOrchestrate: boolean;
  onOpen: (url: string) => void;
  onName: (port: number, draft: string) => void;
}) {
  const { row } = props;
  const { openUrl, port } = row;
  const [naming, setNaming] = useState(false);
  return (
    <li className="group/run flex min-w-0 list-none items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent/60">
      <StatusDot running />
      {naming && port !== null ? (
        <GroupInlineEdit
          label={`Name for ${row.name}`}
          initial={row.name}
          className="text-sm"
          onCommit={(draft) => {
            setNaming(false);
            props.onName(port, draft);
          }}
          onCancel={() => setNaming(false)}
        />
      ) : (
        <>
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <span className="min-w-0 truncate text-muted-foreground text-sm">{row.name}</span>
            {row.canNameIt && props.canOrchestrate ? (
              <Button size="xs" variant="ghost-muted" onClick={() => setNaming(true)}>
                Name it
              </Button>
            ) : null}
          </span>
          <RowEnd
            label={port === null ? row.detail : `:${port}`}
            actions={
              openUrl === null ? null : (
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Open ${row.name}`}
                  onClick={() => props.onOpen(openUrl)}
                >
                  <ExternalLinkIcon />
                </Button>
              )
            }
          />
        </>
      )}
    </li>
  );
}
