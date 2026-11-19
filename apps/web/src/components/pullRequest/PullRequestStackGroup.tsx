import type { PullRequestStackMembership } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { PullRequestGlyph } from "./pullRequestIcons";
import type { PullRequestRowTarget } from "./PullRequestRow";
import { PullRequestStackPopover } from "./PullRequestStackPopover";

/** Two or more rows of one stack, under a header that folds them away. */
export function PullRequestStackGroup({
  membership,
  entries,
  open,
  onToggle,
  onSelect,
  children,
}: {
  membership: PullRequestStackMembership;
  /** Bottom layer first. */
  entries: ReadonlyArray<EnvironmentPullRequestEntry>;
  open: boolean;
  onToggle: () => void;
  onSelect: (target: PullRequestRowTarget) => void;
  /** The member rows, in `entries` order. */
  children: ReactNode;
}) {
  const gt = useGT();
  const first = entries[0]!;
  const hidden = membership.size - entries.length;
  return (
    <div>
      <div className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/40">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-start focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          />
          <PullRequestGlyph.stack aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">
            <T>
              Stack into <Var>{membership.base}</Var>
            </T>
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground/60">
            <T>
              <Var>{entries.length}</Var> of <Var>{membership.size}</Var> here
            </T>
          </span>
        </button>
        {hidden > 0 ? (
          <PullRequestStackPopover
            environmentId={first.environmentId}
            reference={{
              projectId: first.projectId,
              host: first.host,
              repository: first.repository,
              number: first.number,
            }}
            membership={membership}
            onSelect={(target) =>
              onSelect({ ...target, host: first.host, environmentId: first.environmentId })
            }
            trigger={{
              content: (
                <span className="tabular-nums hover:text-foreground">
                  <T>
                    +<Var>{hidden}</Var> more
                  </T>
                </span>
              ),
              ariaLabel: gt("Show the {count} other layers of this stack", { count: hidden }),
            }}
          />
        ) : null}
      </div>
      {open ? <div className="ms-3 border-s border-border/60 ps-1">{children}</div> : null}
    </div>
  );
}
