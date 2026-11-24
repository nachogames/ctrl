import type { EnvironmentIssueEntry } from "@t3tools/client-runtime/issue-list";
import { nodeProgress, progressOf, type IssueProgress } from "@t3tools/client-runtime/issue-board";
import { issueTree, treeHasVisible, type IssueTreeNode } from "@t3tools/client-runtime/issue-tree";
import { T, useGT } from "gt-react";
import { ChevronRightIcon, FlagIcon } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { IssueProgressBadge } from "./IssueProgressBadge";

const flatten = (node: IssueTreeNode): EnvironmentIssueEntry[] => [
  node.entry,
  ...node.children.flatMap(flatten),
];
const groupEntries = (group: ReturnType<typeof issueTree>[number]) =>
  group.milestones.flatMap((milestone) => milestone.roots.flatMap(flatten));

const showAll = () => true;

/**
 * Rows nested as tracker project, then milestone, then parent issue; projects fold. `visible`
 * hides rows but keeps the parents above a shown one, and progress still counts every row.
 */
export function IssueTreeList({
  rows,
  renderRow,
  visible = showAll,
  folded: foldedProp,
  onFoldedChange,
}: {
  /** Folded project ids, for a caller that keeps them across remounts. */
  folded?: ReadonlySet<string>;
  onFoldedChange?: (folded: ReadonlySet<string>) => void;
  rows: ReadonlyArray<EnvironmentIssueEntry>;
  visible?: (entry: EnvironmentIssueEntry) => boolean;
  renderRow: (
    entry: EnvironmentIssueEntry,
    depth: number,
    progress: IssueProgress | null,
  ) => ReactNode;
}) {
  const gt = useGT();
  const [ownFolded, setOwnFolded] = useState<ReadonlySet<string>>(() => new Set());
  const folded = foldedProp ?? ownFolded;
  const toggle = (key: string) => {
    const next = new Set(folded);
    if (!next.delete(key)) next.add(key);
    if (onFoldedChange) onFoldedChange(next);
    else setOwnFolded(next);
  };

  const shows = (node: IssueTreeNode) => treeHasVisible(node, visible);
  const branch = (node: IssueTreeNode, depth: number): ReactNode => (
    <Fragment key={`${node.entry.environmentId}:${node.entry.url}`}>
      <div style={{ paddingInlineStart: `${depth * 1.25}rem` }}>
        {renderRow(node.entry, depth, nodeProgress(node))}
      </div>
      {node.children.filter(shows).map((child) => branch(child, depth + 1))}
    </Fragment>
  );

  return (
    <div className="flex flex-col gap-3">
      {issueTree(rows)
        .filter((group) => group.milestones.some((m) => m.roots.some(shows)))
        .map((group) => {
          const key = group.project?.id ?? "";
          const open = !folded.has(key);
          return (
            <div key={key} className="flex flex-col gap-1">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggle(key)}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm font-medium hover:bg-accent/60"
              >
                <ChevronRightIcon
                  aria-hidden
                  className={cn("size-3.5 shrink-0 text-muted-foreground", open && "rotate-90")}
                />
                <span className="truncate">
                  {group.project?.name ??
                    gt("No project", { $context: "issues outside every tracker project" })}
                </span>
                <span className="text-xs font-normal text-muted-foreground">
                  <IssueProgressBadge progress={progressOf(groupEntries(group))} />
                </span>
              </button>
              {open
                ? group.milestones
                    .filter((milestone) => milestone.roots.some(shows))
                    .map((milestone) => (
                      <div key={milestone.milestone?.id ?? ""} className="flex flex-col">
                        {milestone.milestone || group.milestones.length > 1 ? (
                          <p className="flex items-center gap-1.5 px-3 pt-1 text-xs text-muted-foreground">
                            <FlagIcon aria-hidden className="size-3" />
                            {milestone.milestone?.name ?? <T>No milestone</T>}
                          </p>
                        ) : null}
                        {milestone.roots.filter(shows).map((node) => branch(node, 0))}
                      </div>
                    ))
                : null}
            </div>
          );
        })}
    </div>
  );
}
