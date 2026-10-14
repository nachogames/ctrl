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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pullRequestNumber: number;
  lines: ReadonlyArray<string>;
  onApply: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Apply approved findings to PR #{pullRequestNumber}?</AlertDialogTitle>
          <ul className="flex list-disc flex-col gap-2 ps-5 text-sm">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <AlertDialogDescription>
            It runs in the review chat, so you can watch it or stop it. If a check fails, nothing is
            pushed and the agent says so there.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button onClick={onApply}>Apply</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
