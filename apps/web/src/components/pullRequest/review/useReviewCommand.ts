import {
  type AtomCommand,
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../../ui/toast";

/**
 * A Review tab command that says when the server refused it. The server owns every viewed mark
 * and decision, so a refusal leaves the control as it was; the toast says why, in the server's
 * own words ("Pick Fix or Decline for #3 first.").
 */
export function useReviewCommand<W, A, E>(
  command: AtomCommand<W, A, E>,
  failureTitle: string,
): (value: W) => Promise<AtomCommandResult<A, E>> {
  const run = useAtomCommand(command, { label: failureTitle });
  return useCallback(
    async (value: W) => {
      const result = await run(value);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: failureTitle,
          ...(failure instanceof Error && failure.message.length > 0
            ? { description: failure.message }
            : {}),
        });
      }
      return result;
    },
    [failureTitle, run],
  );
}
