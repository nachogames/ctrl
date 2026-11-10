import { useAtomValue } from "@effect/atom-react";
import {
  pointsToRestyle,
  type ReviewRoundView,
} from "@t3tools/client-runtime/state/review-sessions";
import type {
  EnvironmentId,
  ReviewSessionId,
  ReviewWritingStyleSettings,
} from "@t3tools/contracts";
import {
  deleteReviewStyle,
  MAX_CUSTOM_REVIEW_STYLES,
  MAX_REVIEW_STYLE_NAME_LENGTH,
  REVIEW_WRITING_STYLE_PRESETS,
  resolveReviewWritingStyle,
  reviewWritingStyles,
  saveReviewStyleDraft,
} from "@t3tools/shared/reviewWritingStyles";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { Chip } from "../../../components/ui/Chip";
import { useEnvironmentPresentation } from "../../../state/presentation";
import { reviewSessionEnvironment } from "../../../state/reviewSessions";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { PullRequestCardGroup } from "../PullRequestControls";
import { PullRequestMarkdown } from "../PullRequestMarkdown";
import { useReviewCommand } from "./useReviewCommand";

/**
 * How findings read: picking a style saves it for this review and every later one, an example
 * shows what it says, and Rewrite appears while open points are still in another style.
 */
export function ReviewWritingStyleCard(props: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: ReviewSessionId;
  readonly view: ReviewRoundView | undefined;
}) {
  const { presentation } = useEnvironmentPresentation(props.environmentId);
  const setting = presentation?.serverConfig?.settings?.reviewWritingStyle;
  const styles =
    setting === undefined ? REVIEW_WRITING_STYLE_PRESETS : reviewWritingStyles(setting);
  const selected =
    setting === undefined ? REVIEW_WRITING_STYLE_PRESETS[0]! : resolveReviewWritingStyle(setting);
  const canSave = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(props.environmentId),
  );
  const canRequest = useAtomValue(
    reviewSessionEnvironment.request.permissionAtom(props.environmentId),
  );
  const save = useAtomCommand(serverEnvironment.updateSettings, {
    label: "review writing style update",
    reportFailure: true,
  });
  const rewrite = useReviewCommand(reviewSessionEnvironment.request, "Could not rewrite");
  const [showExample, setShowExample] = useState(false);
  // The open form: a new style, or the selected custom style being edited.
  const [form, setForm] = useState<{
    readonly mode: "new" | "edit";
    readonly name: string;
    readonly instructions: string;
  } | null>(null);
  // A server from before writing styles has no setting to save.
  const editable = setting !== undefined && canSave;
  const stale =
    setting === undefined || props.view === undefined
      ? []
      : pointsToRestyle(props.view, selected.id);
  const from = new Set(stale.map((item) => item.writeupStyle ?? null));
  const custom = setting?.custom ?? [];
  const full = custom.length >= MAX_CUSTOM_REVIEW_STYLES;
  const current = { selected: selected.id, custom };
  const saveStyles = async (next: ReviewWritingStyleSettings) => {
    const result = await save({
      environmentId: props.environmentId,
      input: {
        patch: { reviewWritingStyle: { selected: next.selected, custom: [...next.custom] } },
      },
    });
    if (result._tag === "Success") setForm(null);
  };
  const submit = () => {
    if (form === null || form.name.trim() === "" || form.instructions.trim() === "") return;
    void saveStyles(
      saveReviewStyleDraft(current, {
        editing: form.mode === "new" ? null : selected.id,
        name: form.name,
        instructions: form.instructions,
      }),
    );
  };
  const fromLabel =
    from.size !== 1
      ? "another style"
      : from.has(null)
        ? "the old format"
        : (styles.find((style) => from.has(style.id))?.label ?? "another style");
  return (
    <PullRequestCardGroup>
      <View className="gap-3 p-4" accessibilityLabel="Writing style">
        <View className="flex-row items-center">
          <Text className="flex-1 text-2xs font-t3-medium uppercase text-foreground-muted">
            Writing style
          </Text>
          {!selected.builtIn && editable && form === null ? (
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                setForm({
                  mode: "edit",
                  name: selected.label,
                  instructions: selected.instructions,
                })
              }
              className="px-1 py-1 active:opacity-70"
            >
              <Text className="text-xs text-accent">Edit</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => setShowExample((open) => !open)}
            className="px-1 py-1 active:opacity-70"
          >
            <Text className="text-xs text-accent">
              {showExample ? "Hide example" : "See example"}
            </Text>
          </Pressable>
        </View>
        <View className="flex-row flex-wrap gap-2">
          {styles.map((style) => (
            <Chip
              key={style.id}
              size="small"
              label={style.label}
              selected={style.id === selected.id}
              disabled={!editable}
              onPress={() => {
                if (style.id === selected.id) return;
                void save({
                  environmentId: props.environmentId,
                  input: { patch: { reviewWritingStyle: { selected: style.id } } },
                });
              }}
            />
          ))}
          <Chip
            size="small"
            icon="plus"
            label="New style"
            accessibilityLabel="New writing style"
            disabled={!editable || full || form !== null}
            onPress={() => setForm({ mode: "new", name: "", instructions: "" })}
          />
        </View>
        {form === null ? null : (
          <View className="gap-2 rounded-xl border border-border-subtle px-3 py-3">
            <AppTextInput
              accessibilityLabel="Style name"
              value={form.name}
              onChangeText={(name) => setForm({ ...form, name })}
              placeholder="Style name"
              maxLength={MAX_REVIEW_STYLE_NAME_LENGTH}
              className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
            />
            <AppTextInput
              accessibilityLabel="How should each finding read?"
              value={form.instructions}
              onChangeText={(instructions) => setForm({ ...form, instructions })}
              placeholder="How should each finding read? For example: one sentence on what breaks, then the fix as a checklist."
              multiline
              autoCapitalize="sentences"
              className="min-h-32 rounded-xl px-3 py-2 text-base text-foreground"
            />
            {form.mode === "new" ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setForm({ ...form, instructions: selected.instructions })}
                className="self-start px-1 py-1 active:opacity-70"
              >
                <Text className="text-xs text-accent">Start from {selected.label}</Text>
              </Pressable>
            ) : null}
            <View className="flex-row items-center gap-2">
              {form.mode === "edit" ? (
                <Button
                  size="compact"
                  tone="danger"
                  label="Delete"
                  onPress={() => void saveStyles(deleteReviewStyle(current, selected.id))}
                />
              ) : null}
              <View className="flex-1" />
              <Button size="compact" label="Cancel" onPress={() => setForm(null)} />
              <Button
                size="compact"
                tone="primary"
                label="Save"
                disabled={form.name.trim() === "" || form.instructions.trim() === ""}
                onPress={submit}
              />
            </View>
          </View>
        )}
        {showExample ? (
          <View className="gap-2 rounded-xl border border-border-subtle px-3 py-2">
            <Text className="text-xs text-foreground-muted">{selected.description}</Text>
            {selected.example === null ? null : (
              <>
                <Text className="text-2xs font-t3-semibold uppercase text-foreground-muted">
                  Example
                </Text>
                <PullRequestMarkdown lineBreaks={false} markdown={selected.example} />
              </>
            )}
            <Text className="text-2xs font-t3-semibold uppercase text-foreground-muted">
              Rules the agent follows
            </Text>
            <PullRequestMarkdown lineBreaks={false} markdown={selected.rules} />
          </View>
        ) : null}
        {stale.length === 0 ? null : (
          <View className="gap-2 border-t border-border-subtle pt-3">
            <Text className="text-xs text-foreground-muted">
              {stale.length === 1 ? "1 open point is" : `${stale.length} open points are`} in{" "}
              {fromLabel}.
            </Text>
            <Button
              size="compact"
              tone="primary"
              label={`Rewrite open points in ${selected.label}`}
              disabled={!canRequest}
              onPress={() =>
                void rewrite({
                  environmentId: props.environmentId,
                  input: {
                    sessionId: props.sessionId,
                    request: { _tag: "restyle", style: selected.id },
                  },
                })
              }
            />
          </View>
        )}
      </View>
    </PullRequestCardGroup>
  );
}
