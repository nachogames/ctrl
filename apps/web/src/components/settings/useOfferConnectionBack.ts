import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { authEnvironment } from "~/state/auth";
import { connectionOffers } from "~/state/connectionOffers";
import { desktopNetworkAccessStateAtom } from "~/state/desktopNetworkAccess";
import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { isTailscaleHttpsEndpoint, resolveShareablePairingUrl } from "./ConnectionsSettings.logic";

// The other machine's app may be closed; a day gives it time to open and pick the offer up.
const OFFER_LIFETIME_MINUTES = 24 * 60;

const failureMessage = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : String(failure);
};

/**
 * After this app adds `target`, leaves it a pairing link back to this machine, so `target`'s app
 * connects here too and one pairing connects both ways. Resolves to a message on failure, or null.
 */
export function useOfferConnectionBack() {
  const primaryEnvironment = usePrimaryEnvironment();
  const network = useEnvironmentQuery(window.desktopBridge ? desktopNetworkAccessStateAtom : null);
  const createCode = useAtomCommand(authEnvironment.createPairingCredential, {
    reportFailure: false,
  });
  const revokeCode = useAtomCommand(authEnvironment.revokePairingLink, { reportFailure: false });
  const offer = useAtomCommand(connectionOffers.offer, { reportFailure: false });

  return async (target: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }): Promise<string | null> => {
    if (primaryEnvironment === null)
      return "This app has no machine of its own to connect back to.";
    const hostId = primaryEnvironment.environmentId;
    // No label, so the other machine is listed here under the name it signs in with.
    const code = await createCode({
      environmentId: hostId,
      input: { expiresInMinutes: OFFER_LIFETIME_MINUTES },
    });
    if (code._tag === "Failure") {
      return isAtomCommandInterrupted(code) ? null : failureMessage(code);
    }
    const endpoints = (network.data?.advertisedEndpoints ?? [])
      .filter((endpoint) => endpoint.status === "available")
      // Tailscale reaches across networks, so it goes first when this machine has it.
      .toSorted(
        (left, right) =>
          Number(isTailscaleHttpsEndpoint(right)) - Number(isTailscaleHttpsEndpoint(left)),
      );
    const pairingUrl = resolveShareablePairingUrl({
      credential: code.value.credential,
      endpointUrl: network.data?.serverExposureState.endpointUrl,
      endpoints,
      defaultEndpointKey: null,
      servedByEnvironment: true,
      currentHostname: window.location.hostname,
    });
    if (pairingUrl === null) {
      await revokeCode({ environmentId: hostId, input: { id: code.value.id } });
      return `${target.label} can't reach this machine. Turn on Tailscale or Local network under This Mac, then add it again.`;
    }
    const offered = await offer({
      environmentId: target.environmentId,
      input: {
        environmentId: hostId,
        label: primaryEnvironment.label,
        pairingUrl,
        expiresAt: code.value.expiresAt,
      },
    });
    if (offered._tag === "Failure" && !isAtomCommandInterrupted(offered)) {
      await revokeCode({ environmentId: hostId, input: { id: code.value.id } });
      return failureMessage(offered);
    }
    return null;
  };
}
