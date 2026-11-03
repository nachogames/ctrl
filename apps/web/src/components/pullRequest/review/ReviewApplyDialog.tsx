import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import type { ReviewPendingChoice } from "@t3tools/contracts";
import { Button } from "../../ui/button";

/** Confirms a round's apply; the review chat's agent does the work once the user says so. */
export function ReviewApplyDialog({
  open,
  onOpenChange,
  pullRequestNumber,
  lines,
  onApply,
  reviewer = false,
  existingPending = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pullRequestNumber: number;
  lines: ReadonlyArray<string>;
  onApply: (pendingReview?: ReviewPendingChoice) => void;
  /** Someone else's pull request: Apply prepares your pending review. */
  reviewer?: boolean;
  /** A pending review you already have on GitHub; you choose to add to it or start fresh. */
  existingPending?: { readonly comments: number } | null;
}) {
  const choosing = reviewer && existingPending !== null;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {reviewer
              ? `Prepare your pending review on PR #${pullRequestNumber}?`
              : `Apply approved findings to PR #${pullRequestNumber}?`}
          </AlertDialogTitle>
          <ul className="flex list-disc flex-col gap-2 ps-5 text-sm">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {choosing ? (
            <p className="text-sm">
              You already have a pending review on GitHub with {existingPending.comments}{" "}
              {existingPending.comments === 1 ? "comment" : "comments"}. Add these to it, or start
              fresh, which deletes that draft first.
            </p>
          ) : null}
          <AlertDialogDescription>
            {reviewer
              ? "It runs in the review chat, so you can watch it or stop it. You read and submit the review on GitHub."
              : "It runs in the review chat, so you can watch it or stop it. If a check fails, nothing is pushed and the agent says so there."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          {choosing ? (
            <>
              <Button variant="outline" onClick={() => onApply("replace")}>
                Start fresh
              </Button>
              <Button onClick={() => onApply("add")}>Add to my pending review</Button>
            </>
          ) : (
            <Button onClick={() => onApply()}>{reviewer ? "Prepare review" : "Apply"}</Button>
          )}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
