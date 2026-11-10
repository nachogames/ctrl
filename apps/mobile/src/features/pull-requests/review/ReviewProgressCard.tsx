import type { ReviewGateTone, ReviewProgress } from "@t3tools/client-runtime/state/review-sessions";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { cn } from "../../../lib/cn";
import { PullRequestCardGroup } from "../PullRequestControls";

const TONE_DOT: Record<ReviewGateTone, string> = {
  done: "bg-adaptive-emerald-600-400",
  waiting: "bg-adaptive-amber-700-300",
  blocked: "bg-danger-foreground",
  neutral: "bg-icon-subtle",
};

/** Where the pull request stands against its goal: approval when reviewing, merge when yours. */
export function ReviewProgressCard({ progress }: { readonly progress: ReviewProgress }) {
  return (
    <PullRequestCardGroup>
      <View className="gap-3 p-4" accessibilityLabel="Review progress">
        <View className="gap-0.5">
          <Text className="text-2xs font-t3-medium uppercase text-foreground-muted">
            Your goal · {progress.goal}
          </Text>
          <Text className="text-base font-t3-semibold">{progress.headline}</Text>
          <Text className="text-xs text-foreground-muted">{progress.detail}</Text>
        </View>
        <View className="flex-row flex-wrap gap-2">
          {progress.gates.map((gate) => (
            <View
              key={gate.label}
              accessibilityLabel={`${gate.label}: ${gate.value}`}
              className="min-w-[46%] flex-1 gap-0.5 rounded-xl border border-border-subtle px-3 py-2"
            >
              <Text className="text-2xs text-foreground-muted">{gate.label}</Text>
              <View className="flex-row items-center gap-1.5">
                <View className={cn("h-2 w-2 rounded-full", TONE_DOT[gate.tone])} />
                <Text className="min-w-0 shrink text-xs font-t3-medium" numberOfLines={1}>
                  {gate.value}
                </Text>
              </View>
            </View>
          ))}
        </View>
        {progress.trend === null ? null : (
          <Text className="text-xs text-foreground-muted">{progress.trend}</Text>
        )}
      </View>
    </PullRequestCardGroup>
  );
}
