import {
  effectiveDecision,
  REVIEWER_ACTION_LABELS,
  reviewApplyBadges,
  reviewDecisionLabel,
  reviewerApplyBadges,
  reviewFindingTitle,
  sameReviewItem,
  toggledDecision,
} from "@t3tools/client-runtime/state/review-sessions";
import {
  reviewerAction,
  reviewerPointKind,
  type ReviewDecision,
  type ReviewItem,
  type ReviewPostAs,
  type ReviewRoundState,
} from "@t3tools/contracts";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { Chip } from "../../../components/ui/Chip";
import { cn } from "../../../lib/cn";
import { PullRequestMarkdown } from "../PullRequestMarkdown";
import { ReviewPointExcerpt } from "./ReviewPointExcerpt";

const SOURCE_NAMES: Record<string, string> = {
  copilot: "Copilot",
  "local-review": "Your review",
  ci: "CI",
  you: "You",
};

const sourceNames = (sources: ReadonlyArray<string>) =>
  sources
    .map((source) =>
      source.startsWith("human:")
        ? source.slice("human:".length)
        : (SOURCE_NAMES[source] ?? source),
    )
    .join(", ");

const BADGE_DONE = new Set(["Fixed", "Replied", "Resolved", "Posted", "+1 posted", "Followed up"]);

function Pill(props: { readonly label: string; readonly tone: "info" | "success" | "muted" }) {
  return (
    <View
      className={cn(
        "shrink-0 rounded-md px-1.5 py-0.5",
        props.tone === "info"
          ? "bg-adaptive-sky-500-a12-a16"
          : props.tone === "success"
            ? "bg-adaptive-emerald-500-a12-a16"
            : "bg-subtle",
      )}
    >
      <Text
        className={cn(
          "text-2xs font-t3-medium",
          props.tone === "info"
            ? "text-adaptive-sky-700-300"
            : props.tone === "success"
              ? "text-adaptive-emerald-700-300"
              : "text-foreground-muted",
        )}
      >
        {props.label}
      </Text>
    </View>
  );
}

interface ReviewPointCardProps {
  readonly item: ReviewItem;
  readonly roundState: ReviewRoundState;
  readonly open: boolean;
  /** The round still collects, so the point can be viewed and decided. */
  readonly collecting: boolean;
  readonly canView: boolean;
  readonly canDecide: boolean;
  /** The current round when reviewing someone else's pull request; null on your own. */
  readonly reviewerRound: number | null;
  // The callbacks take the point so every row shares one function.
  readonly onToggle: (item: ReviewItem) => void;
  readonly onViewed: (item: ReviewItem, viewed: boolean) => void;
  readonly onDecide: (item: ReviewItem, decision: ReviewDecision, postAs?: ReviewPostAs) => void;
  readonly onOpenFile: (item: ReviewItem) => void;
}

/** Every review change re-sends the snapshot, so a row re-renders only when its own point did. */
const sameProps = (previous: ReviewPointCardProps, next: ReviewPointCardProps) =>
  (Object.keys(next) as Array<keyof ReviewPointCardProps>).every((key) =>
    key === "item" ? sameReviewItem(previous.item, next.item) : Object.is(previous[key], next[key]),
  );

/** One numbered finding: a row, and when open everything needed to decide it. */
export const ReviewPointCard = memo(function ReviewPointCard({
  item,
  roundState,
  open,
  collecting,
  canView,
  canDecide,
  reviewerRound,
  onToggle,
  onViewed,
  onDecide,
  onOpenFile,
}: ReviewPointCardProps) {
  const decision = effectiveDecision(item);
  const kind = reviewerRound === null ? null : reviewerPointKind(item, reviewerRound);
  // On someone else's pull request a choice is named by what it does to the point.
  const label = (choice: ReviewDecision) => {
    const action = reviewerRound === null ? null : reviewerAction(item, reviewerRound, choice);
    return action === null ? reviewDecisionLabel(choice) : REVIEWER_ACTION_LABELS[action];
  };
  const badges =
    roundState === "collecting"
      ? []
      : reviewerRound === null
        ? reviewApplyBadges(item, roundState)
        : reviewerApplyBadges(item, reviewerAction(item, reviewerRound), roundState);
  const decidable = collecting && canDecide;
  // A pressed choice that is already shown hands the point back to Claude's call, as on desktop.
  const choose = (value: "fix" | "decline") => {
    const next = toggledDecision(item, decision === value ? [] : [value]);
    if (next !== null) onDecide(item, next);
  };
  const chooseOverlap = (value: ReviewPostAs | "decline") => {
    const pressed =
      decision === "decline" ? "decline" : decision === null ? null : (item.postAs ?? "reply");
    if (pressed === value) {
      const next = toggledDecision(item, []);
      if (next !== null) onDecide(item, next);
    } else if (value === "decline") onDecide(item, "decline");
    else onDecide(item, "fix", value);
  };
  const where = item.path === null ? null : item.path.split("/").at(-1);
  return (
    <View
      className={cn(
        "overflow-hidden rounded-2xl border",
        open ? "border-composer-border bg-grouped-card" : "border-border-subtle",
      )}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Finding ${item.number}: ${reviewFindingTitle(item.summary)}${decision === null ? ", needs a decision" : `, ${label(decision)}`}${item.viewed ? ", viewed" : ""}`}
        onPress={() => onToggle(item)}
        className="flex-row items-start gap-2.5 px-3 py-2.5 active:opacity-70"
      >
        <Text className="w-7 pt-0.5 font-mono text-xs text-foreground-muted">#{item.number}</Text>
        <View className="min-w-0 flex-1 gap-1">
          <Text
            className={cn(
              "text-sm leading-5 font-t3-medium",
              item.viewed && !open && "text-foreground-muted",
            )}
            numberOfLines={open ? undefined : 2}
          >
            {reviewFindingTitle(item.summary)}
          </Text>
          <View className="flex-row flex-wrap items-center gap-1.5">
            <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
              {[sourceNames(item.sources), where].filter(Boolean).join(" · ")}
            </Text>
            {item.stale ? (
              <Text className="text-2xs text-foreground-muted">
                · earlier commit, {item.githubState === "outdated" ? "code changed" : "not touched"}
              </Text>
            ) : null}
            {item.viewed ? (
              <SymbolView name="checkmark" size={11} tintColorClassName="accent-icon-muted" />
            ) : null}
          </View>
        </View>
        <View className="items-end gap-1 pt-0.5">
          {badges.length > 0 ? (
            badges.map((badge) => (
              <Pill key={badge} label={badge} tone={BADGE_DONE.has(badge) ? "success" : "muted"} />
            ))
          ) : kind === "context" ? (
            <Pill label="Context" tone="muted" />
          ) : decision === null ? (
            <Pill label="Needs a call" tone="muted" />
          ) : (
            <Pill label={label(decision)} tone={decision === "fix" ? "info" : "muted"} />
          )}
        </View>
      </Pressable>
      {open ? (
        <View className="gap-3 border-t border-border-subtle px-3 pt-3 pb-3.5">
          {item.alreadyFixedIn === null ? null : (
            <Text className="text-xs text-foreground-muted">
              Already fixed in #{item.alreadyFixedIn.number}, in the same stack.
            </Text>
          )}
          {kind === "context" ? null : (
            <View className="flex-row items-start gap-2">
              <SymbolView name="robot" size={14} tintColorClassName="accent-icon-muted" />
              <Text className="min-w-0 flex-1 text-sm">
                <Text className="text-sm font-t3-semibold">
                  {item.suggestedDecision === null
                    ? "No call yet."
                    : `My call: ${label(item.suggestedDecision)}.`}
                </Text>
                {item.recommendation === null ? null : ` ${item.recommendation}`}
              </Text>
            </View>
          )}
          <ReviewPointExcerpt
            path={item.path}
            line={item.line}
            excerpt={item.excerpt}
            onOpen={item.path === null ? undefined : () => onOpenFile(item)}
          />
          {item.writeup?.trim() ? (
            <PullRequestMarkdown lineBreaks={false} markdown={item.writeup} />
          ) : (
            <>
              <PullRequestMarkdown
                lineBreaks={false}
                markdown={`**Problem:** ${[item.problem, item.impact].filter(Boolean).join(" ")}`}
              />
              <PullRequestMarkdown lineBreaks={false} markdown={`**Solution:** ${item.solution}`} />
            </>
          )}
          {decision === "decline" && item.skipReason ? (
            <PullRequestMarkdown
              lineBreaks={false}
              markdown={`**${
                kind === null
                  ? "Reason to decline"
                  : kind === "follow-up"
                    ? "Still needs"
                    : "Why skip"
              }:** ${item.skipReason}`}
            />
          ) : null}
          {kind === "context" ? (
            <Text className="text-xs text-foreground-muted">
              Raised by someone else, not by your review. Nothing for you to decide.
            </Text>
          ) : (
            <View className="flex-row flex-wrap items-center gap-2">
              {kind === "overlap" ? (
                <>
                  <Chip
                    label={REVIEWER_ACTION_LABELS.reply}
                    selected={decision === "fix" && (item.postAs ?? "reply") === "reply"}
                    disabled={!decidable}
                    onPress={() => chooseOverlap("reply")}
                  />
                  <Chip
                    label={REVIEWER_ACTION_LABELS.comment}
                    selected={decision === "fix" && item.postAs === "comment"}
                    disabled={!decidable}
                    onPress={() => chooseOverlap("comment")}
                  />
                  <Chip
                    label={REVIEWER_ACTION_LABELS.skip}
                    selected={decision === "decline"}
                    disabled={!decidable}
                    onPress={() => chooseOverlap("decline")}
                  />
                </>
              ) : (
                <>
                  <Chip
                    label={label("fix")}
                    icon="hammer"
                    selected={decision === "fix"}
                    disabled={!decidable}
                    onPress={() => choose("fix")}
                  />
                  <Chip
                    label={label("decline")}
                    icon="xmark"
                    selected={decision === "decline"}
                    disabled={!decidable}
                    onPress={() => choose("decline")}
                  />
                </>
              )}
              {roundState === "collecting" ? (
                <Chip
                  label={item.viewed ? "Viewed" : "Mark viewed"}
                  icon={item.viewed ? "checkmark.circle.fill" : "circle"}
                  selected={item.viewed}
                  // Viewing accepts Claude's call; with no call yet there is nothing to accept.
                  disabled={!collecting || !canView || decision === null}
                  onPress={() => onViewed(item, !item.viewed)}
                />
              ) : null}
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}, sameProps);
