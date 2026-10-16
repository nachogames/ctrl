import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";

/** Confirms a round's apply; the review chat's agent does the work once the user says so. */
export function ReviewApplyDialog({
  open,
  onOpenChange,
  pullRequestNumber,
  lines,
  onApply,
  reviewer = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pullRequestNumber: number;
  lines: ReadonlyArray<string>;
  onApply: () => void;
  /** Someone else's pull request: Apply prepares your pending review. */
  reviewer?: boolean;
}) {
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
          <AlertDialogDescription>
            {reviewer
              ? "It runs in the review chat, so you can watch it or stop it. You read and submit the review on GitHub."
              : "It runs in the review chat, so you can watch it or stop it. If a check fails, nothing is pushed and the agent says so there."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button onClick={onApply}>{reviewer ? "Prepare review" : "Apply"}</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
