import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  issueBoard,
  type IssueBoardColumn,
  type IssueBoardLane,
  type IssueBoardProject,
} from "@t3tools/client-runtime/issue-board";
import type { EnvironmentIssueEntry } from "@t3tools/client-runtime/issue-list";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { msg, T, useGT } from "gt-react";
import { FlagIcon } from "lucide-react";
import { Fragment, useState } from "react";

import { m } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { issueEnvironment, refreshIssueLists } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";

import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { PullRequestActorAvatar } from "../pullRequest/pullRequestPresentation";
import { toastManager } from "../ui/toast";
import { IssueProgressBadge } from "./IssueProgressBadge";
import { IssueStateGlyph } from "./issuePresentation";

const entryId = (entry: EnvironmentIssueEntry) => `${entry.environmentId} ${entry.url}`;
const COLUMN_WIDTH = "14rem";
const LANE_WIDTH = "13rem";

/**
 * Tracker project, then milestone, then one lane per parent issue with its sub-issues by state.
 * Dragging a card to another column moves the issue to that state; the card shows there at once
 * and goes back if the tracker refuses.
 */
export function IssueBoard({
  rows,
  visible,
  onSelect,
}: {
  rows: ReadonlyArray<EnvironmentIssueEntry>;
  visible: (entry: EnvironmentIssueEntry) => boolean;
  onSelect: (entry: EnvironmentIssueEntry) => void;
}) {
  const gt = useGT();
  const setState = useAtomCommand(issueEnvironment.setState, { reportFailure: false });
  // Moves the tracker has not confirmed yet, by card, so the card shows where it was dropped.
  const [moves, setMoves] = useState<ReadonlyMap<string, string>>(() => new Map());
  const shown = rows.map((row) => {
    const moved = moves.get(entryId(row));
    return moved === undefined || moved === row.state.name
      ? row
      : { ...row, state: { ...row.state, name: moved } };
  });
  const board = issueBoard(shown, visible);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    const entry = shown.find((row) => entryId(row) === active.id);
    const column = over === null ? undefined : board.columns[Number(over.data.current?.column)];
    if (entry === undefined || column === undefined || column.name === entry.state.name) return;
    const id = entryId(entry);
    setMoves((current) => new Map(current).set(id, column.name));
    const result = await setState({
      environmentId: entry.environmentId as EnvironmentId,
      input: {
        projectId: entry.projectId,
        tracker: entry.tracker,
        host: entry.host,
        scope: entry.scope,
        key: entry.key,
        state: column.name,
      },
    });
    if (result._tag === "Failure") {
      setMoves((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
      toastManager.add({
        type: "error",
        title: m(
          msg("Could not move {issue} to {state}", { issue: entry.displayKey, state: column.name }),
        ),
        description: readableFailure(
          squashAtomCommandFailure(result),
          m(msg("The tracker refused it.")),
        ),
      });
      return;
    }
    refreshIssueLists(entry.environmentId as EnvironmentId);
  };

  const template = `${LANE_WIDTH} repeat(${board.columns.length}, ${COLUMN_WIDTH})`;
  return (
    <DndContext sensors={sensors} onDragEnd={(event) => void onDragEnd(event)}>
      <div className="flex w-max flex-col gap-6 p-2">
        {board.projects.map((group) => (
          <section key={group.project?.id ?? ""} className="flex w-max flex-col gap-2">
            <h3 className="sticky left-0 flex w-fit items-center gap-2 px-1 text-sm font-medium">
              {group.project?.name ??
                gt("No project", { $context: "issues outside every tracker project" })}
              <span className="text-xs font-normal text-muted-foreground">
                <IssueProgressBadge progress={group.progress} />
              </span>
            </h3>
            <div className="grid" style={{ gridTemplateColumns: template }}>
              {/* Opaque, gapless header cells: cards scrolling under them stay hidden. */}
              <span className="sticky top-0 left-0 z-30 border-b bg-background" />
              {board.columns.map((column, position) => (
                <span
                  key={column.name}
                  className="sticky top-0 z-20 flex items-center gap-1.5 border-b bg-background px-2 py-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground"
                >
                  <span className="truncate">{column.name}</span>
                  <span className="tabular-nums font-normal text-muted-foreground/70">
                    {columnCount(group, position)}
                  </span>
                </span>
              ))}
              {group.milestones.map(({ milestone, lanes }) => (
                <Fragment key={milestone?.id ?? ""}>
                  {milestone || group.milestones.length > 1 ? (
                    <p
                      className="sticky left-0 flex w-fit items-center gap-1.5 px-1 pt-4 pb-1 text-xs font-medium text-muted-foreground"
                      style={{ gridColumn: "1 / -1" }}
                    >
                      <FlagIcon aria-hidden className="size-3" />
                      {milestone?.name ?? <T>No milestone</T>}
                    </p>
                  ) : null}
                  {lanes.map((lane) => (
                    <BoardLane
                      key={lane.parent ? entryId(lane.parent) : "loose"}
                      lane={lane}
                      columns={board.columns}
                      onSelect={onSelect}
                    />
                  ))}
                </Fragment>
              ))}
            </div>
          </section>
        ))}
      </div>
    </DndContext>
  );
}

/** How many cards a project shows in one column, for the column's heading. */
const columnCount = (group: IssueBoardProject, position: number) =>
  group.milestones.reduce(
    (sum, milestone) =>
      sum + milestone.lanes.reduce((count, lane) => count + (lane.cells[position]?.length ?? 0), 0),
    0,
  );

function BoardLane({
  lane,
  columns,
  onSelect,
}: {
  lane: IssueBoardLane;
  columns: ReadonlyArray<IssueBoardColumn>;
  onSelect: (entry: EnvironmentIssueEntry) => void;
}) {
  const laneKey = lane.parent ? entryId(lane.parent) : "loose";
  return (
    <>
      {/* Spans the whole row and covers what scrolls under it; the card inside stays in view. */}
      <div className="sticky left-0 z-10 border-t bg-background py-2 pr-2">
        <div className="sticky top-10 flex flex-col gap-1.5 rounded-md border bg-card p-2 text-xs">
          {lane.parent ? (
            <button
              type="button"
              className="flex items-start gap-1.5 text-left hover:underline"
              onClick={() => onSelect(lane.parent!)}
            >
              <IssueStateGlyph state={lane.parent.state} />
              <span className="min-w-0">
                <span className="font-mono text-muted-foreground">{lane.parent.displayKey}</span>{" "}
                <span className="font-medium">{lane.parent.title}</span>
              </span>
            </button>
          ) : (
            <span className="text-muted-foreground">
              <T>No parent</T>
            </span>
          )}
          <span className="text-muted-foreground">
            <IssueProgressBadge progress={lane.progress} />
          </span>
        </div>
      </div>
      {lane.cells.map((cell, column) => (
        <BoardCell key={columns[column]?.name} laneKey={laneKey} column={column}>
          {cell.map((entry) => (
            <BoardCard
              key={entryId(entry)}
              entry={entry}
              showParent={lane.parent !== null && entry.parent?.key !== lane.parent.key}
              onSelect={onSelect}
            />
          ))}
        </BoardCell>
      ))}
    </>
  );
}

function BoardCell({
  laneKey,
  column,
  children,
}: {
  laneKey: string;
  column: number;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${laneKey}|${column}`, data: { column } });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex min-h-16 flex-col gap-1.5 border-t px-1 py-2",
        isOver && "rounded-md bg-accent/50 ring-1 ring-ring ring-inset",
      )}
    >
      {children}
    </div>
  );
}

function BoardCard({
  entry,
  showParent,
  onSelect,
}: {
  entry: EnvironmentIssueEntry;
  showParent: boolean;
  onSelect: (entry: EnvironmentIssueEntry) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: entryId(entry),
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      onClick={() => onSelect(entry)}
      style={
        transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined
      }
      className={cn(
        "flex flex-col gap-1 rounded-md border bg-card px-2 py-1.5 text-left text-xs hover:bg-accent/60",
        isDragging && "relative z-10 shadow-lg",
      )}
    >
      <span className="line-clamp-2">
        <span className="font-mono text-muted-foreground">{entry.displayKey}</span> {entry.title}
      </span>
      <span className="flex items-center gap-1 text-muted-foreground">
        {entry.assignees[0] ? <PullRequestActorAvatar actor={entry.assignees[0]} /> : null}
        {showParent && entry.parent ? (
          <span className="truncate">↳ {entry.parent.displayKey}</span>
        ) : null}
      </span>
    </button>
  );
}
