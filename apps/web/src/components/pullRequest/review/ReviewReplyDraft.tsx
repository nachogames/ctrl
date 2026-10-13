import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ReviewItem,
  ReviewReplyStyle,
  ReviewSessionId,
} from "@t3tools/contracts";
import { PencilIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { reviewSessionEnvironment } from "~/state/reviewSessions";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import { draftUpdateLabel, replyTarget } from "./pullRequestReview.logic";
import { useReviewCommand } from "./useReviewCommand";

const REWRITES: ReadonlyArray<readonly [ReviewReplyStyle, string]> = [
  ["shorter", "Shorter"],
  ["friendlier", "Friendlier"],
  ["mention-commit", "Mention the commit"],
];

/**
 * The GitHub-style reply Claude drafted for a point; the user can have it rewritten or edit it.
 * Mounted only while its point is open, so "Updated from chat" means the agent wrote it since.
 */
export function ReviewReplyDraft({
  item,
  environmentId,
  sessionId,
  collecting,
}: {
  item: ReviewItem;
  environmentId: EnvironmentId;
  sessionId: ReviewSessionId;
  /** The round still collects, so the reply can still change. */
  collecting: boolean;
}) {
  // The revision on screen when the point opened; a later agent write is marked.
  const [seenRevision, setSeenRevision] = useState(item.draftReplyRevision);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const canEdit = useAtomValue(reviewSessionEnvironment.editReply.permissionAtom(environmentId));
  const canRequest = useAtomValue(reviewSessionEnvironment.request.permissionAtom(environmentId));
  const editReply = useReviewCommand(
    reviewSessionEnvironment.editReply,
    "Could not save the reply",
  );
  const request = useReviewCommand(reviewSessionEnvironment.request, "Could not ask for a rewrite");
  const target = replyTarget(item);
  if (target === null || item.draftReply === null) {
    return (
      <p className="text-xs text-muted-foreground">
        {target !== null
          ? "No reply drafted yet. Triage drafts one."
          : item.sources.includes("ci")
            ? "Nothing to reply to: this is a failing check. It's listed in your posted review."
            : "Found by your review, so there's no thread to reply to. It's listed in your posted review."}
      </p>
    );
  }
  const updated = draftUpdateLabel(item, seenRevision);
  const save = async () => {
    if (saving) return;
    setSaving(true);
    const result = await editReply({
      environmentId,
      input: { sessionId, number: item.number, draftReply: text },
    });
    setSaving(false);
    if (result._tag === "Failure") return;
    setSeenRevision(result.value.item.draftReplyRevision);
    setEditing(false);
  };
  return (
    <div
      className={cn(
        "rounded-xl border bg-background",
        updated === null ? "border-border/70" : "border-info/50",
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs">
        <span className="font-semibold">You</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          reply to {target} · draft
        </span>
        {updated === null ? null : <Badge variant="info">{updated}</Badge>}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2 p-2.5">
          <Textarea
            size="sm"
            aria-label={`Reply for #${item.number}`}
            value={text}
            autoFocus
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                if (text.trim().length > 0) void save();
              }
            }}
          />
          <div className="flex justify-end gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="xs"
              disabled={saving || text.trim().length === 0}
              onClick={() => void save()}
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <p className="px-3 py-2.5 text-sm whitespace-pre-wrap break-words">{item.draftReply}</p>
      )}
      {collecting && !editing ? (
        <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5">
          <span className="me-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <SparklesIcon aria-hidden="true" className="size-3" />
            Rewrite
          </span>
          {REWRITES.map(([style, label]) => (
            <Button
              key={style}
              size="xs"
              variant="outline"
              disabled={!canRequest}
              onClick={() =>
                void request({
                  environmentId,
                  input: {
                    sessionId,
                    request: { _tag: "rewrite-reply", number: item.number, style },
                  },
                })
              }
            >
              {label}
            </Button>
          ))}
          <span className="flex-1" />
          <Button
            aria-label={`Edit the reply for #${item.number}`}
            size="icon-xs"
            variant="ghost"
            disabled={!canEdit}
            onClick={() => {
              setText(item.draftReply ?? "");
              setEditing(true);
            }}
          >
            <PencilIcon aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
