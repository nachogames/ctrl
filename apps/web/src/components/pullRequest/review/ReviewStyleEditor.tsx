import {
  MAX_REVIEW_STYLE_INSTRUCTIONS_LENGTH,
  MAX_REVIEW_STYLE_NAME_LENGTH,
  type ReviewStyleDraft,
  type ReviewWritingStyle,
} from "@t3tools/shared/reviewWritingStyles";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";

/** The form for a new writing style, or for editing one of the user's own. */
export function ReviewStyleEditor({
  draft,
  startFrom,
  onChange,
  onCancel,
  onSave,
  onDelete,
}: {
  draft: ReviewStyleDraft;
  startFrom: ReviewWritingStyle;
  onChange: (draft: ReviewStyleDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  onDelete: (() => void) | undefined;
}) {
  const ready = draft.name.trim() !== "" && draft.instructions.trim() !== "";
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-2.5">
      <Input
        size="sm"
        aria-label="Style name"
        placeholder="Style name"
        maxLength={MAX_REVIEW_STYLE_NAME_LENGTH}
        value={draft.name}
        autoFocus
        onChange={(event) => onChange({ ...draft, name: event.target.value })}
      />
      <Textarea
        size="sm"
        rows={6}
        maxLength={MAX_REVIEW_STYLE_INSTRUCTIONS_LENGTH}
        aria-label="How findings read in this style"
        placeholder="How should each finding read? For example: one line on what breaks, then the fix as a checklist. No jargon."
        value={draft.instructions}
        onChange={(event) => onChange({ ...draft, instructions: event.target.value })}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        {draft.editing === null ? (
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => onChange({ ...draft, instructions: startFrom.instructions })}
          >
            Start from {startFrom.label}
          </Button>
        ) : (
          <Button size="xs" variant="ghost-destructive" onClick={onDelete}>
            Delete
          </Button>
        )}
        <span className="flex-1" />
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" disabled={!ready} onClick={onSave}>
          Save
        </Button>
      </div>
    </div>
  );
}
