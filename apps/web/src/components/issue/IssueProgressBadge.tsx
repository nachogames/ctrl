import type { IssueProgress } from "@t3tools/client-runtime/issue-board";
import { useGT } from "gt-react";

/** "3/7" with a thin bar: how many sub-issues are closed. */
export function IssueProgressBadge({ progress }: { progress: IssueProgress }) {
  const gt = useGT();
  const share = progress.total === 0 ? 0 : progress.done / progress.total;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 tabular-nums"
      aria-label={gt("{done} of {total} done", { done: progress.done, total: progress.total })}
    >
      <span aria-hidden className="h-1 w-8 overflow-hidden rounded-full bg-border">
        <span
          className="block h-full rounded-full bg-success"
          style={{ width: `${share * 100}%` }}
        />
      </span>
      <span aria-hidden>
        {progress.done}/{progress.total}
      </span>
    </span>
  );
}
