import { linkRequestFailureMessage } from "@t3tools/client-runtime/link-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Result from "effect/Result";

import { mintPairingCodeOn } from "~/state/peerPairingCode";
import { peerLinkEnvironment } from "~/state/peerLinks";
import { useAtomCommand } from "~/state/use-atom-command";

/**
 * Lets agents on `hostEnvironmentId` (this machine) run work on `target`. Mints the code on the
 * target with this client's session there, so nobody types a second code; each task still asks
 * for approval on the target. Resolves to a message on failure, or null.
 */
export function useLinkAgentsTo() {
  const link = useAtomCommand(peerLinkEnvironment.link, { reportFailure: false });
  return async (input: {
    readonly hostEnvironmentId: EnvironmentId;
    readonly target: {
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly urls: ReadonlyArray<string>;
    };
  }): Promise<string | null> => {
    const [url, ...alternateUrls] = input.target.urls;
    if (url === undefined) return `This app has no address for ${input.target.label}.`;
    const code = await mintPairingCodeOn(input.target.environmentId, "approval-required");
    if (Result.isFailure(code)) return linkRequestFailureMessage(code.failure);
    const result = await link({
      environmentId: input.hostEnvironmentId,
      input: {
        url,
        ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
        expectedEnvironmentId: input.target.environmentId,
        expectedLabel: input.target.label,
        pairingCode: code.success,
        access: "approval-required",
      },
    });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
    const failure = squashAtomCommandFailure(result);
    return failure instanceof Error ? failure.message : String(failure);
  };
}
