import type { EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { connectionRoutes, routeHttpBaseUrl } from "@t3tools/client-runtime/connection";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import type { EnvironmentPresentation } from "~/state/environments";
import { peerLinkEnvironment } from "~/state/peerLinks";
import { useAtomCommand } from "~/state/use-atom-command";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useLinkAgentsTo } from "./useLinkAgentsTo";

/** What this app's own machine may do on another machine, when it can run agents at all. */
export interface AgentsOnMachine {
  readonly hostEnvironmentId: EnvironmentId;
  readonly linked: boolean;
  readonly canChange: boolean;
}

/** The two things another machine is used for, each its own labeled switch. */
export function MachineUseSwitches({
  environment,
  chats,
  agents,
}: {
  readonly environment: EnvironmentPresentation;
  readonly chats: {
    readonly checked: boolean;
    readonly disabled: boolean;
    readonly onCheckedChange: (checked: boolean) => void;
  };
  readonly agents: AgentsOnMachine | null;
}) {
  return (
    <div className="mt-2 divide-y divide-border/50 border-t border-border/50">
      <label className="flex min-h-9 cursor-pointer items-center gap-3 py-1.5">
        <span className="min-w-0 flex-1 text-xs font-medium text-foreground">
          Show its chats and projects here
        </span>
        <Switch
          size="sm"
          checked={chats.checked}
          disabled={chats.disabled}
          onCheckedChange={chats.onCheckedChange}
          aria-label={`Show ${environment.label}'s chats and projects here`}
        />
      </label>
      {agents ? <AgentsSwitch environment={environment} agents={agents} /> : null}
    </div>
  );
}

function AgentsSwitch({
  environment,
  agents,
}: {
  readonly environment: EnvironmentPresentation;
  readonly agents: AgentsOnMachine;
}) {
  const linkAgentsTo = useLinkAgentsTo();
  const unlink = useAtomCommand(peerLinkEnvironment.unlink, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const failed = (description: string) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Could not change what agents can do on ${environment.label}`,
        description,
      }),
    );

  const change = async (next: boolean) => {
    if (busy) return;
    if (next) {
      if (environment.connection.phase !== "connected") {
        failed(`Connect to ${environment.label} first: turn on Show its chats and projects here.`);
        return;
      }
      setBusy(true);
      const problem = await linkAgentsTo({
        hostEnvironmentId: agents.hostEnvironmentId,
        target: {
          environmentId: environment.environmentId,
          label: environment.label,
          urls: connectionRoutes(environment.entry)
            .map(routeHttpBaseUrl)
            .filter((url): url is string => url !== null),
        },
      });
      setBusy(false);
      if (problem !== null) failed(problem);
      return;
    }
    const confirmed = await (requestConfirmDialog(
      `Stop agents here from running work on ${environment.label}?`,
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(true);
    const result = await unlink({
      environmentId: agents.hostEnvironmentId,
      input: { environmentId: environment.environmentId },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failed(String(squashAtomCommandFailure(result)));
    }
  };

  return (
    <label className="flex min-h-9 cursor-pointer items-center gap-3 py-1.5">
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-foreground">
          Agents here can run work there
        </span>
        <span className="block text-2xs text-muted-foreground">
          Each task asks for approval on {environment.label}.
        </span>
      </span>
      <Switch
        size="sm"
        checked={agents.linked}
        disabled={busy || !agents.canChange}
        onCheckedChange={(next) => void change(next)}
        aria-label={`Agents here can run work on ${environment.label}`}
      />
    </label>
  );
}
