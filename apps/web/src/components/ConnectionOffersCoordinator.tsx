import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { connectPairing } from "~/connection/onboarding";
import { connectionOffers } from "~/state/connectionOffers";
import { useEnvironments, usePrimaryEnvironment } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "./ui/toast";
import { useOfferConnectionBack } from "./settings/useOfferConnectionBack";

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
  const offerConnectionBack = useOfferConnectionBack();
  const running = useRef(false);
  const primaryId = primaryEnvironment?.environmentId ?? null;
  const primaryConnected = primaryEnvironment?.connection.phase === "connected";

  const takeOffers = useEffectEvent(async (hostId: EnvironmentId) => {
    const taken = await take({ environmentId: hostId, input: {} });
    if (taken._tag !== "Success") return;
    for (const offer of taken.value.offers) {
      const saved = environments.find(
        (environment) => environment.environmentId === offer.environmentId,
      );
      // Already saved here, perhaps switched off on purpose; pairing again would switch it on.
      // A phone relay is the user asking for this connection now, so it goes ahead.
      if (saved !== undefined && offer.connectBack !== true) continue;
      const result = await pair({
        pairingUrl: offer.pairingUrl,
        expectedEnvironmentId: offer.environmentId,
        ...(primaryEnvironment ? { clientLabel: primaryEnvironment.label } : {}),
      });
      const backProblem =
        result._tag === "Success" && offer.connectBack === true
          ? await offerConnectionBack({ environmentId: offer.environmentId, label: offer.label })
          : null;
      if (backProblem !== null) {
        toastManager.add({
          type: "warning",
          title: `Connected to ${offer.label} one way only`,
          description: backProblem,
        });
      }
      toastManager.add(
        result._tag === "Success"
          ? {
              type: "success",
              title: `Connected to ${offer.label}`,
              description: offer.connectBack
                ? `Your phone connected this machine to ${offer.label}.`
                : `${offer.label} added this machine, so it is connected both ways now.`,
            }
          : {
              type: "warning",
              title: `Could not connect back to ${offer.label}`,
              description: "Add it from Connections with a code from that machine.",
            },
      );
    }
  });

  const check = useEffectEvent(async () => {
    if (primaryId === null || !primaryConnected || running.current) return;
    running.current = true;
    await takeOffers(primaryId).finally(() => {
      running.current = false;
    });
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
