import {
  reviewSourceDetail,
  reviewSourceStateLabel,
  reviewSourceTitle,
} from "@t3tools/client-runtime/state/review-sessions";
import type {
  EnvironmentId,
  ReviewItemSource,
  ReviewSessionId,
  ReviewSource,
  ReviewSourceComment,
} from "@t3tools/contracts";
import { BotIcon, ChevronRightIcon, CircleXIcon, SparklesIcon } from "lucide-react";
import { memo, useState } from "react";

import ChatMarkdown from "../../ChatMarkdown";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { reviewSessionEnvironment } from "~/state/reviewSessions";
import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

/** Copilot, your review, or a reviewer's initial. */
function ReviewSourceAvatar({ kind, author }: Pick<ReviewSource, "kind" | "author">) {
  return (
    <span
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
      aria-hidden="true"
    >
      {kind === "copilot" ? (
        <BotIcon className="size-3.5" />
      ) : kind === "local" ? (
        <SparklesIcon className="size-3" />
      ) : (
        <span className="text-2xs font-semibold">{(author ?? "?").charAt(0).toUpperCase()}</span>
      )}
    </span>
  );
}

const SOURCE_NAMES: Record<string, string> = {
  copilot: "Copilot",
  "local-review": "your review",
  ci: "CI",
};

const SOURCE_TIPS: Record<string, string> = {
  copilot: "Copilot · review comment on GitHub",
  "local-review": "Your review · ran on this computer",
  ci: "CI · a failing check",
};

/** The small icons on a point row naming who raised it. */
export function ReviewItemSourceIcons({ sources }: { sources: ReadonlyArray<ReviewItemSource> }) {
  return (
    <span className="flex min-w-10 shrink-0 gap-0.5">
      <span className="sr-only">Raised by</span>
      {sources.map((name) => {
        const human = name.startsWith("human:") ? name.slice("human:".length) : null;
        return (
          <Tooltip key={name}>
            <TooltipTrigger
              render={
                <span className="inline-flex size-4.5 items-center justify-center rounded-full bg-muted text-muted-foreground" />
              }
            >
              {name === "copilot" ? (
                <BotIcon aria-hidden="true" className="size-3" />
              ) : name === "local-review" ? (
                <SparklesIcon aria-hidden="true" className="size-2.5" />
              ) : name === "ci" ? (
                <CircleXIcon aria-hidden="true" className="size-3" />
              ) : (
                <span aria-hidden="true" className="text-2xs font-semibold">
                  {(human ?? name).charAt(0).toUpperCase()}
                </span>
              )}
              <span className="sr-only">{human ?? SOURCE_NAMES[name] ?? name}</span>
            </TooltipTrigger>
            <TooltipPopup side="top">
              {human === null ? (SOURCE_TIPS[name] ?? name) : `${human} · review on GitHub`}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </span>
  );
}

/** One review that went into the round; a finished one expands to exactly what it said. */
export const ReviewSourceRow = memo(function ReviewSourceRow({
  source,
  environmentId,
  sessionId,
  ranOn,
  resolution,
  comments,
}: {
  source: ReviewSource;
  resolution?: string | undefined;
  environmentId: EnvironmentId;
  sessionId: ReviewSessionId | null;
  comments?: ReadonlyArray<ReviewSourceComment>;
  /** The model a local review ran on, as `ranOnLabel` names it. */
  ranOn: string | null;
}) {
  const [open, setOpen] = useState(false);
  const readable = source.state === "done" && source.commentCount > 0;
  const expanded = open && readable;
  return (
    <li className={cn("rounded-lg", expanded && "bg-muted/40")}>
      <button
        type="button"
        disabled={!readable}
        aria-expanded={readable ? expanded : undefined}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-start not-disabled:hover:bg-accent/50 disabled:cursor-default"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 text-muted-foreground",
            expanded && "rotate-90",
            !readable && "opacity-30",
          )}
        />
        <ReviewSourceAvatar kind={source.kind} author={source.author} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">{reviewSourceTitle(source)}</span>
          <span className="truncate text-xs text-muted-foreground">
            {reviewSourceDetail(source, ranOn)}
            {source.submittedAt ? ` · ${new Date(source.submittedAt).toLocaleString()}` : ""}
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {source.failed
            ? "Failed · no review produced"
            : (resolution ?? reviewSourceStateLabel(source))}
        </span>
      </button>
      {expanded ? (
        <ReviewSourceComments
          environmentId={environmentId}
          sessionId={sessionId}
          source={source}
          {...(comments ? { providedComments: comments } : {})}
        />
      ) : null}
    </li>
  );
});

/** Read on demand: only an expanded review asks the server for what it said. */
function ReviewSourceComments({
  environmentId,
  sessionId,
  source,
  providedComments,
}: {
  environmentId: EnvironmentId;
  sessionId: ReviewSessionId | null;
  source: ReviewSource;
  providedComments?: ReadonlyArray<ReviewSourceComment>;
}) {
  const query = useEnvironmentQuery(
    sessionId === null || providedComments !== undefined
      ? null
      : reviewSessionEnvironment.sourceComments({
          environmentId,
          input: { sessionId, sourceId: source.id },
        }),
  );
  const comments = providedComments ?? query.data?.comments ?? [];
  return (
    <div className="flex flex-col gap-2 ps-14 pe-2.5 pb-2.5">
      {providedComments === undefined && query.data === null ? (
        <p className="text-xs text-muted-foreground">
          {query.error === null ? "Reading what it said…" : "Could not read this review."}
        </p>
      ) : (
        comments.map((comment) => (
          <div
            key={comment.url ?? `${comment.key}:${comment.path}:${comment.line}`}
            className="flex flex-col gap-0.5 text-xs"
          >
            <span className="font-mono text-muted-foreground">
              {comment.path === null
                ? "Review summary"
                : `${comment.path.split("/").at(-1)}${comment.line === null ? "" : `:${comment.line}`}`}
            </span>
            <ChatMarkdown
              text={comment.body}
              cwd={undefined}
              environmentId={environmentId}
              parseRawHtml
            />
          </div>
        ))
      )}
      <p className="text-xs text-muted-foreground">
        {source.kind === "local"
          ? "Your review's raw findings. Nothing is posted until you apply."
          : "Exactly what it wrote. Triage decides what to do with each."}
      </p>
    </div>
  );
}

/** The offer to run your own review beside the others. */
export function ReviewLocalOfferRow({ disabled, onRun }: { disabled: boolean; onRun: () => void }) {
  return (
    <li className="flex items-center gap-2.5 px-1.5 py-1.5">
      <span className="size-3 shrink-0" aria-hidden="true" />
      <ReviewSourceAvatar kind="local" author={null} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">Your review</span>
        <span className="truncate text-xs text-muted-foreground">
          Not run yet. A second, independent look.
        </span>
      </span>
      <Button size="xs" variant="outline" disabled={disabled} onClick={onRun}>
        Run your review
      </Button>
    </li>
  );
}
