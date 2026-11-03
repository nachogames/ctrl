import { type VoiceFrontErrorReason, VoiceFrontError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

const isVoiceFrontError = Schema.is(VoiceFrontError);

/** Failures that mean the machine has no quick voice to offer, not a passing hiccup. */
const NOT_SET_UP: ReadonlySet<VoiceFrontErrorReason> = new Set([
  "disabled",
  "lm-studio-missing",
  "server-unavailable",
  "model-missing",
  "model-too-large",
]);

/**
 * Whether a failed front-voice reply means that environment's quick voice is
 * not set up: turned off, no LM Studio or model there, or a server too old to
 * have the front voice at all. Generation failures are not counted.
 */
export function frontNotSetUp(cause: Cause.Cause<unknown>): boolean {
  return cause.reasons.some((reason) => {
    if (Cause.isFailReason(reason))
      return isVoiceFrontError(reason.error) && NOT_SET_UP.has(reason.error.reason);
    // An older server answers a method it does not have with this defect.
    return Cause.isDieReason(reason) && String(reason.defect).includes("Unknown request tag");
  });
}

/** What the user hears the first time a machine's quick voice is missing. */
export const notSetUpNotice = (machine: string) =>
  `Voice isn't set up on ${machine}, so the agent will answer without the quick voice.`;
