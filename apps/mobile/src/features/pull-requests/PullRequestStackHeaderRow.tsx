import type { PullRequestStackMembership } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { PullRequestGlyph } from "./pullRequestGlyphs";

/** Heads two or more PRs from one stack; tapping folds them. */
export function PullRequestStackHeaderRow(props: {
  readonly membership: PullRequestStackMembership;
  readonly shown: number;
  readonly open: boolean;
  readonly sidebar: boolean;
  readonly onToggle: () => void;
  /** Opens a PR in the stack, whose page lists every layer. */
  readonly onShowAll: () => void;
}) {
  const gt = useGT();
  const muted = props.sidebar ? "text-drawer-foreground-muted" : "text-foreground-muted";
  const tint = props.sidebar ? "accent-drawer-foreground-muted" : "accent-foreground-muted";
  const hidden = props.membership.size - props.shown;
  return (
    <View
      className={cn(
        "flex-row items-center gap-2 pt-3 pb-1",
        props.sidebar ? "bg-drawer px-3" : "px-4",
      )}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.open }}
        accessibilityLabel={gt("Stack into {base}, {shown} of {size} here", {
          base: props.membership.base,
          shown: props.shown,
          size: props.membership.size,
        })}
        onPress={props.onToggle}
        className="min-w-0 flex-1 flex-row items-center gap-1.5"
      >
        <SymbolView
          name={props.open ? "chevron.down" : "chevron.right"}
          size={11}
          tintColorClassName={tint}
        />
        <SymbolView name={PullRequestGlyph.stack} size={13} tintColorClassName={tint} />
        <Text className={cn("min-w-0 shrink text-xs font-medium", muted)} numberOfLines={1}>
          {gt("Stack into {base}", { base: props.membership.base })}
        </Text>
        <Text className={cn("text-xs tabular-nums", muted)}>
          {gt("{shown} of {size} here", { shown: props.shown, size: props.membership.size })}
        </Text>
      </Pressable>
      {hidden > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Show the {count} other layers of this stack", { count: hidden })}
          onPress={props.onShowAll}
          hitSlop={8}
        >
          <Text className={cn("text-xs tabular-nums", muted)}>
            {gt("+{count} more", { count: hidden })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
