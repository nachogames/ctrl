import {
  reviewFindingTitle,
  effectiveDecision,
  reviewApplyBadges,
  reviewDecisionLabel,
} from "@t3tools/client-runtime/state/review-sessions";
import type {
  EnvironmentId,
  ReviewDecision,
  ReviewItem,
  ReviewRoundState,
  ReviewSessionId,
} from "@t3tools/contracts";
import { ChevronRightIcon, LayersIcon, MessageSquareIcon, SparklesIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import ChatMarkdown from "../../ChatMarkdown";
import { ReadOnlySourcePreview } from "~/components/files/AttachmentFilePreview";
import { cn } from "~/lib/utils";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { sameReviewItem, toggledDecision } from "./pullRequestReview.logic";
import { ReviewItemSourceIcons } from "./ReviewSourceRow";
import { ReviewReplyDraft } from "./ReviewReplyDraft";

const applyBadgeVariant = (label: string) =>
  label === "Fixed" || label === "Replied" || label === "Resolved"
    ? "success"
    : label.endsWith("…")
      ? "info"
      : "secondary";

interface ReviewPointRowProps {
  item: ReviewItem;
  environmentId: EnvironmentId;
  sessionId: ReviewSessionId;
  roundState: ReviewRoundState;
  open: boolean;
  /** Only the current round's points open; older rounds stay one read-only line. */
  openable: boolean;
  /** The round still collects, so the point can be viewed, decided and replied to. */
  collecting: boolean;
  canView: boolean;
  canDecide: boolean;
  /** Messages the user sent about it. */
  talked: number;
  // The callbacks take the point so the tab can pass the same function to every row.
  onOpenChange: (item: ReviewItem, open: boolean) => void;
  onViewed: (item: ReviewItem, viewed: boolean) => void;
  onDecide: (item: ReviewItem, decision: ReviewDecision) => void;
  onOpenLink: (url: string) => void;
  /**
   * The ⋯ menu and the side-chat banner (Task 11). Read only while the point is open: pass them
   * for the open point alone so the closed rows stay memoised.
   */
  menu?: ReactNode;
  banner?: ReactNode;
}

/** Every review change re-sends the snapshot, so a row re-renders only when its own point did. */
const sameRowProps = (previous: ReviewPointRowProps, next: ReviewPointRowProps) =>
  (Object.keys(next) as Array<keyof ReviewPointRowProps>).every((key) =>
    key === "item" ? sameReviewItem(previous.item, next.item) : Object.is(previous[key], next[key]),
  ) && Object.keys(previous).length === Object.keys(next).length;

/** One numbered point: a collapsed row, and when open everything needed to decide it. */
export const ReviewPointRow = memo(function ReviewPointRow({
  item,
  environmentId,
  sessionId,
  roundState,
  open,
  openable,
  collecting,
  canView,
  canDecide,
  talked,
  onOpenChange,
  onViewed,
  onDecide,
  onOpenLink,
  menu,
  banner,
}: ReviewPointRowProps) {
  const decision = effectiveDecision(item);
  const fixedIn = item.alreadyFixedIn;
  const dim = item.viewed && !open;
  return (
    <li className={cn("rounded-xl border", open ? "border-border bg-card" : "border-border/50")}>
      <div className="flex items-center gap-2 py-1.5 ps-1 pe-2">
        <button
          type="button"
          aria-expanded={openable ? open : undefined}
          disabled={!openable}
          onClick={() => onOpenChange(item, !open)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-start not-disabled:hover:bg-accent/50 disabled:cursor-default"
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3 shrink-0 text-muted-foreground",
              open && "rotate-90",
              !openable && "opacity-0",
            )}
          />
          <span className="w-6 shrink-0 font-mono text-xs text-muted-foreground">
            #{item.number}
          </span>
          <ReviewItemSourceIcons sources={item.sources} />
          <span className={cn("min-w-0 flex-1 truncate text-sm", dim && "text-muted-foreground")}>
            {reviewFindingTitle(item.summary)}
          </span>
          {talked > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className="flex items-center gap-1 text-2xs text-muted-foreground"
                    aria-label={`${talked} ${talked === 1 ? "message" : "messages"} about this point`}
                  />
                }
              >
                <MessageSquareIcon aria-hidden="true" className="size-3" />
                {talked}
              </TooltipTrigger>
              <TooltipPopup side="top">Your messages about this point</TooltipPopup>
            </Tooltip>
          ) : null}
          {decision === null ? null : (
            <Badge variant={decision === "fix" ? "info" : "secondary"}>
              {reviewDecisionLabel(decision)}
            </Badge>
          )}
        </button>
        {roundState === "collecting" ? (
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-2xs text-muted-foreground select-none has-disabled:cursor-default">
            <Checkbox
              aria-label={`Mark #${item.number} as viewed`}
              checked={item.viewed}
              // Viewing a point accepts Claude's call; with no call yet there is nothing to accept.
              disabled={!collecting || !canView || decision === null}
              onCheckedChange={(next) => onViewed(item, next === true)}
            />
            Viewed
          </label>
        ) : (
          <span className="flex shrink-0 gap-1">
            {reviewApplyBadges(item, roundState).map((label) => (
              <Badge key={label} variant={applyBadgeVariant(label)}>
                {label}
              </Badge>
            ))}
          </span>
        )}
      </div>
      {open ? (
        <div className="flex flex-col gap-3 px-3.5 pb-3.5">
          {banner}
          {fixedIn === null ? null : (
            <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/40 px-2.5 py-1.5 text-xs">
              <LayersIcon aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                Already fixed in #{fixedIn.number}, in the same stack.
              </span>
              <Button size="xs" variant="ghost" onClick={() => onOpenLink(fixedIn.url)}>
                Open
              </Button>
            </div>
          )}
          <div className="flex items-start gap-2 text-sm">
            <SparklesIcon
              aria-hidden="true"
              className="mt-1 size-3 shrink-0 text-muted-foreground"
            />
            <p className="min-w-0 flex-1">
              <span className="font-semibold">
                {item.suggestedDecision === null
                  ? "No call yet."
                  : `My call: ${reviewDecisionLabel(item.suggestedDecision)}.`}
              </span>
              {item.recommendation === null ? null : <> {item.recommendation}</>}
            </p>
            {menu}
          </div>
          {item.excerpt === null ? null : (
            <div className="overflow-hidden rounded-lg border border-border/60">
              <ReadOnlySourcePreview name="review.diff" text={item.excerpt} />
            </div>
          )}
          <dl className="flex flex-col gap-2.5 text-sm">
            <div>
              <dt className="text-xs font-semibold text-muted-foreground">What's wrong</dt>
              <dd>
                <ChatMarkdown
                  text={item.problem}
                  cwd={undefined}
                  environmentId={environmentId}
                  parseRawHtml
                />
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-muted-foreground">Why it matters</dt>
              <dd>
                <ChatMarkdown
                  text={item.impact}
                  cwd={undefined}
                  environmentId={environmentId}
                  parseRawHtml
                />
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-muted-foreground">
                {decision === "decline" ? "Why we'd skip it" : "What the fix does"}
              </dt>
              <dd>
                <ChatMarkdown
                  text={decision === "decline" ? item.skipReason : item.solution}
                  cwd={undefined}
                  environmentId={environmentId}
                  parseRawHtml
                />
              </dd>
            </div>
          </dl>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Decision</span>
            <ToggleGroup
              aria-label={`Decision for #${item.number}`}
              value={decision === null ? [] : [decision]}
              disabled={!collecting || !canDecide}
              onValueChange={(next) => {
                const value = toggledDecision(item, next);
                if (value !== null) onDecide(item, value);
              }}
            >
              <Toggle value="fix">Fix</Toggle>
              <Toggle value="decline">Decline</Toggle>
            </ToggleGroup>
          </div>
          <ReviewReplyDraft
            item={item}
            environmentId={environmentId}
            sessionId={sessionId}
            collecting={collecting}
          />
        </div>
      ) : null}
    </li>
  );
}, sameRowProps);
