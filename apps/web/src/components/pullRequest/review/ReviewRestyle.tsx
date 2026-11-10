import { useAtomValue } from "@effect/atom-react";
import {
  pointsToRestyle,
  type ReviewRoundView,
} from "@t3tools/client-runtime/state/review-sessions";
import type {
  EnvironmentId,
  ReviewCustomWritingStyle,
  ReviewSessionId,
  ReviewWritingStyleSettings,
} from "@t3tools/contracts";
import {
  deleteReviewStyle,
  MAX_CUSTOM_REVIEW_STYLES,
  REVIEW_WRITING_STYLE_PRESETS,
  resolveReviewWritingStyle,
  type ReviewStyleDraft,
  reviewWritingStyles,
  type ReviewWritingStyle,
  saveReviewStyleDraft,
} from "@t3tools/shared/reviewWritingStyles";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";

import { useEnvironment } from "~/state/environments";
import { reviewSessionEnvironment } from "~/state/reviewSessions";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { searchableSetting } from "../../settings/settingsSearch";
import { Button } from "../../ui/button";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { ReviewStyleEditor } from "./ReviewStyleEditor";
import { ReviewStylePreview } from "./ReviewStylePreview";
import { useReviewCommand } from "./useReviewCommand";

/** The review environment's writing styles; built-ins alone on a server that predates them. */
function useReviewWritingStyles(environmentId: EnvironmentId): {
  styles: ReadonlyArray<ReviewWritingStyle>;
  selected: ReviewWritingStyle;
  custom: ReadonlyArray<ReviewCustomWritingStyle>;
  readonly supported: boolean;
} {
  const setting = useEnvironment(environmentId)?.serverConfig?.settings.reviewWritingStyle;
  return setting === undefined
    ? {
        styles: REVIEW_WRITING_STYLE_PRESETS,
        selected: REVIEW_WRITING_STYLE_PRESETS[0]!,
        custom: [],
        supported: false,
      }
    : {
        styles: reviewWritingStyles(setting),
        selected: resolveReviewWritingStyle(setting),
        custom: setting.custom,
        supported: true,
      };
}

/**
 * The card between the review's status and its workspace: pick the writing style for this review
 * and later ones, see what it reads like, and rewrite open points written in another style.
 */
export function ReviewWritingStyleCard({
  environmentId,
  sessionId,
  view,
}: {
  environmentId: EnvironmentId;
  sessionId: ReviewSessionId;
  /** The current round, when there is one. */
  view: ReviewRoundView | undefined;
}) {
  const { styles, selected, custom, supported } = useReviewWritingStyles(environmentId);
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const canSave = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const request = useReviewCommand(reviewSessionEnvironment.request, "Could not rewrite");
  const canRequest = useAtomValue(reviewSessionEnvironment.request.permissionAtom(environmentId));
  const navigate = useNavigate();
  const [showExample, setShowExample] = useState(false);
  // The style being written: a new one, or the selected custom one being edited.
  const [draft, setDraft] = useState<ReviewStyleDraft | null>(null);
  // The style a Rewrite was sent for; the button stays busy until the points catch up.
  const [sentFor, setSentFor] = useState<string | null>(null);
  if (!supported) return null;
  const stale = view === undefined ? [] : pointsToRestyle(view, selected.id);
  const sending = sentFor === selected.id && stale.length > 0;
  const from = new Set(stale.map((item) => item.writeupStyle ?? null));
  const fromLabel =
    from.size !== 1
      ? "another style"
      : from.has(null)
        ? "the old format"
        : (styles.find((style) => from.has(style.id))?.label ?? "another style");
  const saveStyles = async (next: ReviewWritingStyleSettings) => {
    const result = await saveSettings({
      environmentId,
      input: {
        patch: { reviewWritingStyle: { selected: next.selected, custom: [...next.custom] } },
      },
    });
    if (result._tag === "Success") setDraft(null);
  };
  const setting = { selected: selected.id, custom };
  const rewrite = async () => {
    setSentFor(selected.id);
    const result = await request({
      environmentId,
      input: { sessionId, request: { _tag: "restyle", style: selected.id } },
    });
    if (result._tag === "Failure") setSentFor(null);
  };
  return (
    <section
      aria-label="Writing style"
      className="flex flex-col gap-2.5 rounded-xl border border-border/70 bg-background p-3 shadow-sm"
    >
      <div className="flex items-center gap-2">
        <p className="flex-1 text-2xs font-medium tracking-wider text-muted-foreground uppercase">
          Writing style
        </p>
        {selected.builtIn || draft !== null ? null : (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!canSave}
            onClick={() =>
              setDraft({
                editing: selected.id,
                name: selected.id,
                instructions: selected.instructions,
              })
            }
          >
            Edit
          </Button>
        )}
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Manage writing styles in Settings"
          title="Manage writing styles in Settings"
          onClick={() =>
            void navigate({
              to: "/settings/source-control",
              search: { machine: environmentId },
              hash: searchableSetting("review-writing-style").id,
            })
          }
        >
          <Settings2Icon aria-hidden="true" />
        </Button>
        <Button size="xs" variant="ghost-muted" onClick={() => setShowExample((open) => !open)}>
          {showExample ? "Hide example" : "See example"}
        </Button>
      </div>
      <ToggleGroup
        aria-label="Writing style for this review and later ones"
        className="flex-wrap"
        value={[selected.id]}
        disabled={!canSave}
        onValueChange={(next) => {
          const value = next[0];
          if (typeof value !== "string" || value === selected.id) return;
          void saveSettings({
            environmentId,
            input: { patch: { reviewWritingStyle: { selected: value } } },
          });
        }}
      >
        {styles.map((style) => (
          <Toggle key={style.id} value={style.id}>
            {style.label}
          </Toggle>
        ))}
      </ToggleGroup>
      {draft === null ? (
        <Button
          size="xs"
          variant="ghost-muted"
          className="self-start"
          disabled={!canSave || custom.length >= MAX_CUSTOM_REVIEW_STYLES}
          onClick={() => setDraft({ editing: null, name: "", instructions: "" })}
        >
          <PlusIcon aria-hidden="true" />
          New style
        </Button>
      ) : (
        <ReviewStyleEditor
          draft={draft}
          startFrom={selected}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={() => void saveStyles(saveReviewStyleDraft(setting, draft))}
          onDelete={
            draft.editing === null
              ? undefined
              : () => void saveStyles(deleteReviewStyle(setting, draft.editing ?? ""))
          }
        />
      )}
      {showExample ? <ReviewStylePreview style={selected} environmentId={environmentId} /> : null}
      {stale.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2.5">
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
            {stale.length === 1 ? "1 open point is" : `${stale.length} open points are`} in{" "}
            {fromLabel}.
          </span>
          <Button size="xs" disabled={!canRequest || sending} onClick={() => void rewrite()}>
            {sending ? "Rewriting…" : `Rewrite open points in ${selected.label}`}
          </Button>
        </div>
      )}
    </section>
  );
}
