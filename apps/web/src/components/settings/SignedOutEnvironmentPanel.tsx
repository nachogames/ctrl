import type { EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useId, useState } from "react";

import { pairEnvironmentAgain } from "~/connection/onboarding";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { thisDeviceNoun } from "./deviceNoun";

/**
 * The host answered and refused a sign-in it let lapse. Pairing again with a fresh code
 * signs this saved environment back in where it stands.
 */
export function SignedOutEnvironmentPanel({
  environmentId,
  hostLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly hostLabel: string;
}) {
  const inputId = useId();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const pairAgain = useAtomCommand(pairEnvironmentAgain, { reportFailure: false });
  const noun = thisDeviceNoun();

  const submit = async () => {
    if (code.trim() === "" || pairing) return;
    setPairing(true);
    setError(null);
    const result = await pairAgain({ environmentId, code });
    setPairing(false);
    if (result._tag === "Success") {
      setCode("");
      toastManager.add({ type: "success", title: `Signed in to ${hostLabel} again` });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : "Pairing failed. Check the code.");
  };

  return (
    <div className="mt-2 grid gap-3 rounded-lg border border-warning/30 bg-warning-surface p-3 text-xs">
      <div>
        <p className="text-sm font-medium text-warning-foreground">
          This {noun}'s sign-in to {hostLabel} expired
        </p>
        <p className="mt-0.5 text-muted-foreground">
          {hostLabel} is running and answered, but its sign-in for this {noun} ran out. Pair again
          to get your chats and projects back. The address and switches stay as they are.
        </p>
      </div>
      <form
        className="grid gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor={inputId} className="font-medium text-foreground">
          Code from {hostLabel}
        </label>
        <div className="flex flex-wrap gap-2">
          <div className="w-52">
            <Input
              id={inputId}
              size="sm"
              font="mono"
              value={code}
              autoComplete="off"
              spellCheck={false}
              placeholder="Pairing code or link"
              disabled={pairing}
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
          <Button type="submit" size="xs" disabled={pairing || code.trim() === ""}>
            {pairing ? "Pairing…" : "Pair again"}
          </Button>
        </div>
        {error ? <p className="text-destructive">{error}</p> : null}
        <p className="text-muted-foreground">
          On {hostLabel}: Settings &gt; Connections &gt; Add a device.
        </p>
      </form>
    </div>
  );
}
