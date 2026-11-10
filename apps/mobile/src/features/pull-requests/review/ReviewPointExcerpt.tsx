import { trimReviewExcerpt } from "@t3tools/client-runtime/state/review-sessions";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { resolveNativeReviewDiffView } from "../../diffs/nativeReviewDiffSurface";
import { buildNativeReviewDiffData } from "../../review/nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "../../review/reviewModel";
import { useNativeReviewDiffBridge } from "../../review/useNativeReviewDiffBridge";
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";
import { useAppearanceCodeSurface } from "../../settings/appearance/useAppearanceCodeSurface";

const EMPTY_IDS: readonly string[] = [];

/** The few diff lines a point is about, with their original line numbers; taps open the file. */
export function ReviewPointExcerpt({
  path,
  line,
  excerpt,
  onOpen,
}: {
  readonly path: string | null;
  readonly line: number | null;
  readonly excerpt: string | null;
  readonly onOpen: (() => void) | undefined;
}) {
  const { nativeReviewDiffStyle, codeWordBreak } = useAppearanceCodeSurface();
  const { themeAppearance } = useAppearancePreferences();
  const shown = excerpt ? trimReviewExcerpt(excerpt.trimStart()) : "";
  // GitHub's hunk has no file header; the path heads the card instead.
  const patch = shown.startsWith("@@")
    ? `diff --git a/${path ?? "review"} b/${path ?? "review"}\n--- a/${path ?? "review"}\n+++ b/${path ?? "review"}\n${shown}`
    : "";
  const sectionId = `review-point:${path}:${line}`;
  const data = (() => {
    const parsed = buildNativeReviewDiffData(buildReviewParsedDiff(patch, sectionId));
    return {
      ...parsed,
      rows: parsed.rows.filter((row) => row.kind !== "file" && row.kind !== "hunk"),
    };
  })();
  const bridge = useNativeReviewDiffBridge({
    threadKey: null,
    sectionId,
    diff: patch,
    data,
    collapsedFileIds: EMPTY_IDS,
    viewedFileIds: EMPTY_IDS,
    selectedRowIds: EMPTY_IDS,
    canHighlight: true,
  });
  const [NativeDiff] = useState(() => resolveNativeReviewDiffView());
  const measurementKey = `${patch}:${codeWordBreak}:${nativeReviewDiffStyle.rowHeight}`;
  const [measured, setMeasured] = useState<{ key: string; height: number } | null>(null);
  if (!path && !excerpt) return null;
  return (
    <View className="overflow-hidden rounded-lg border border-border-subtle">
      {path ? (
        <Pressable
          accessibilityRole={onOpen ? "button" : undefined}
          accessibilityLabel={`Open ${path}${line === null ? "" : ` at line ${line}`}`}
          disabled={!onOpen}
          onPress={onOpen}
          className="min-h-10 flex-row items-center gap-3 border-b border-border-subtle px-3 py-2 active:opacity-60"
        >
          <Text
            className="min-w-0 flex-1 font-mono text-2xs text-foreground-muted"
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {path}
            {line === null ? "" : `:${line}`}
          </Text>
          {onOpen ? (
            <SymbolView name="arrow.up.right" size={13} tintColorClassName="accent-icon-muted" />
          ) : null}
        </Pressable>
      ) : null}
      {NativeDiff && data.rows.length ? (
        <View
          style={{
            height:
              measured?.key === measurementKey
                ? measured.height
                : data.rows.length * nativeReviewDiffStyle.rowHeight,
          }}
        >
          <NativeDiff
            scrollEnabled={false}
            bounces={false}
            appearanceScheme={themeAppearance}
            rowHeight={nativeReviewDiffStyle.rowHeight}
            contentWidth={2800}
            style={{ flex: 1 }}
            rowsJson={bridge.rowsJson}
            themeJson={bridge.themeJson}
            styleJson={bridge.styleJson}
            tokensPatchJson={bridge.tokensPatchJson}
            tokensResetKey={bridge.tokensResetKey}
            onDebug={(event) => {
              bridge.onDebug(event);
              const { message, contentHeight } = event.nativeEvent;
              if (message === "metrics" && typeof contentHeight === "number") {
                setMeasured((current) =>
                  current?.key === measurementKey && current.height === contentHeight
                    ? current
                    : { key: measurementKey, height: contentHeight },
                );
              }
            }}
            onPressLine={onOpen}
          />
        </View>
      ) : shown ? (
        <Text selectable className="p-3 font-mono text-2xs text-foreground-muted">
          {shown}
        </Text>
      ) : null}
    </View>
  );
}
