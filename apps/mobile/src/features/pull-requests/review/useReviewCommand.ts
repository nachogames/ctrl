import {
  type AtomCommand,
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import * as Dialog from "../../../components/ui/Dialog";
import { useAtomCommand } from "../../../state/use-atom-command";

/**
 * A Review tab command that says when the server refused it, in the server's own words
 * ("Pick Fix or Decline for #3 first."). The server owns every decision, so a refusal leaves
 * the control as it was.
 */
export function useReviewCommand<W, A, E>(
  command: AtomCommand<W, A, E>,
  failureTitle: string,
): (value: W) => Promise<AtomCommandResult<A, E>> {
  const run = useAtomCommand(command, { label: failureTitle, reportFailure: false });
  return async (value: W) => {
    const result = await run(value);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      Dialog.alert(
        failureTitle,
        failure instanceof Error && failure.message.length > 0 ? failure.message : "Try again.",
      );
    }
    return result;
  };
}
