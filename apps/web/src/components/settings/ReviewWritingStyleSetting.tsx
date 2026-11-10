import type { ReviewWritingStyleSettings } from "@t3tools/contracts";
import {
  DEFAULT_REVIEW_WRITING_STYLE,
  deleteReviewStyle,
  MAX_CUSTOM_REVIEW_STYLES,
  resolveReviewWritingStyle,
  type ReviewStyleDraft,
  reviewWritingStyles,
  saveReviewStyleDraft,
} from "@t3tools/shared/reviewWritingStyles";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { ReviewStyleEditor } from "../pullRequest/review/ReviewStyleEditor";
import { ReviewStylePreview } from "../pullRequest/review/ReviewStylePreview";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** How review findings are written: pick a style, and add, edit or delete your own. */
export function ReviewWritingStyleSetting() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["reviewWritingStyle"]);
  const setting = settings.reviewWritingStyle;
  const styles = reviewWritingStyles(setting);
  const selected = resolveReviewWritingStyle(setting);
  const [draft, setDraft] = useState<ReviewStyleDraft | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const { environment } = useSettingsScope();
  const save = (next: ReviewWritingStyleSettings) => {
    updateSettings({ reviewWritingStyle: { selected: next.selected, custom: [...next.custom] } });
    setDraft(null);
  };
  const editor = (current: ReviewStyleDraft) => (
    <ReviewStyleEditor
      draft={current}
      startFrom={selected}
      onChange={setDraft}
      onCancel={() => setDraft(null)}
      onSave={() => save(saveReviewStyleDraft(setting, current))}
      onDelete={
        current.editing === null
          ? undefined
          : () => save(deleteReviewStyle(setting, current.editing ?? ""))
      }
    />
  );

  return (
    <SettingsRow
      serverScoped
      settingKeys={["reviewWritingStyle"]}
      mixed={mixed}
      {...searchableSetting("review-writing-style")}
      description="How each finding reads in the Review tab and in the comments posted on GitHub, for every review. You can also change it from the Review tab."
      resetAction={
        mixed || setting.selected !== DEFAULT_REVIEW_WRITING_STYLE ? (
          <SettingResetButton
            label="review writing style"
            onClick={() =>
              updateSettings({ reviewWritingStyle: { selected: DEFAULT_REVIEW_WRITING_STYLE } })
            }
          />
        ) : null
      }
    >
      <div className="mt-3 flex max-w-2xl flex-col gap-3 pb-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            aria-label="Review writing style"
            className="flex-wrap"
            value={mixed ? [] : [selected.id]}
            onValueChange={(next) => {
              const value = next[0];
              if (typeof value === "string" && value !== selected.id)
                updateSettings({ reviewWritingStyle: { selected: value } });
            }}
          >
            {styles.map((style) => (
              <Toggle key={style.id} value={style.id}>
                {style.label}
              </Toggle>
            ))}
          </ToggleGroup>
          {mixed ? null : (
            <Button size="xs" variant="ghost-muted" onClick={() => setShowDetails((open) => !open)}>
              {showDetails ? "Hide example" : "See example"}
            </Button>
          )}
        </div>
        {showDetails && !mixed ? (
          <ReviewStylePreview style={selected} environmentId={environment?.environmentId} />
        ) : null}
        {mixed || setting.custom.length === 0 ? null : (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-muted-foreground">Your styles</p>
            <ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60">
              {setting.custom.map((style) =>
                draft?.editing === style.name ? (
                  <li key={style.name} className="p-1.5">
                    {editor(draft)}
                  </li>
                ) : (
                  <li key={style.name} className="flex items-center gap-1 px-3 py-1.5 text-sm">
                    <span className="min-w-0 flex-1 truncate">{style.name}</span>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={draft !== null}
                      onClick={() =>
                        setDraft({
                          editing: style.name,
                          name: style.name,
                          instructions: style.instructions,
                        })
                      }
                    >
                      Edit
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost-destructive"
                      disabled={draft !== null}
                      onClick={() => save(deleteReviewStyle(setting, style.name))}
                    >
                      Delete
                    </Button>
                  </li>
                ),
              )}
            </ul>
          </div>
        )}
        {mixed ? null : draft?.editing === null ? (
          editor(draft)
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            disabled={draft !== null || setting.custom.length >= MAX_CUSTOM_REVIEW_STYLES}
            onClick={() => setDraft({ editing: null, name: "", instructions: "" })}
          >
            <PlusIcon aria-hidden="true" />
            New style
          </Button>
        )}
      </div>
    </SettingsRow>
  );
}
