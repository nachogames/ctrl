import { useEffect, useEffectEvent, useRef } from "react";

import { connectPairing } from "~/connection/onboarding";
import { connectionOffers } from "~/state/connectionOffers";
import { useEnvironments, usePrimaryEnvironment } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "./ui/toast";

const CHECK_INTERVAL_MS = 60_000;

/**
 * Connects back to machines that paired with this one and left a link here, so one pairing
 * connects both ways. Checks this app's own machine when it connects and every minute after.
 */
export function ConnectionOffersCoordinator() {
  const primaryEnvironment = usePrimaryEnvironment();
  const { environments } = useEnvironments();
  const take = useAtomCommand(connectionOffers.take, { reportFailure: false });
  const pair = useAtomCommand(connectPairing, { reportFailure: false });
  const running = useRef(false);
  const primaryId = primaryEnvironment?.environmentId ?? null;
  const primaryConnected = primaryEnvironment?.connection.phase === "connected";

  const check = useEffectEvent(async () => {
    if (primaryId === null || !primaryConnected || running.current) return;
    running.current = true;
    try {
      const taken = await take({ environmentId: primaryId, input: {} });
      if (taken._tag !== "Success") return;
      for (const offer of taken.value.offers) {
        const saved = environments.find(
          (environment) => environment.environmentId === offer.environmentId,
        );
        if (saved?.connection.phase === "connected") continue;
        const result = await pair({
          pairingUrl: offer.pairingUrl,
          expectedEnvironmentId: offer.environmentId,
          ...(primaryEnvironment ? { clientLabel: primaryEnvironment.label } : {}),
        });
        toastManager.add(
          result._tag === "Success"
            ? {
                type: "success",
                title: `Connected to ${offer.label}`,
                description: `${offer.label} added this machine, so it is connected both ways now.`,
              }
            : {
                type: "warning",
                title: `Could not connect back to ${offer.label}`,
                description: "Add it from Connections with a code from that machine.",
              },
        );
      }
    } finally {
      running.current = false;
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls this machine's server, an outside system, for links other machines left, on connect and every minute
  useEffect(() => {
    if (primaryId === null || !primaryConnected) return;
    void check();
    const timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [primaryId, primaryConnected]);

  return null;
}
