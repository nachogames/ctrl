import { createConnectionOfferCommands } from "@t3tools/client-runtime/state/connectionOffers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId } from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as DateTime from "effect/DateTime";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";

const connectionOffers = createConnectionOfferCommands(connectionAtomRuntime);

// A code from Add a device lasts minutes; the other computer's app takes offers within one.
const RELAY_LIFETIME_MINUTES = 10;
const DESCRIPTOR_TIMEOUT_MS = 8_000;

/**
 * Connects one of the user's computers (`targetEnvironmentId`, which this phone is connected to)
 * to the computer whose pairing link the phone just scanned, and that one back to it, so no
 * code is typed on either computer. Resolves to a message on failure, or null.
 */
export async function connectComputerTo(
  targetEnvironmentId: EnvironmentId,
  pairingUrl: string,
): Promise<string | null> {
  let httpBaseUrl: string;
  try {
    httpBaseUrl = resolveRemotePairingTarget({ pairingUrl }).httpBaseUrl;
  } catch (error) {
    return error instanceof Error ? error.message : "That QR code is not a pairing link.";
  }
  let scanned: { readonly environmentId: EnvironmentId; readonly label: string };
  try {
    const request = new AbortController();
    const timer = setTimeout(() => request.abort(), DESCRIPTOR_TIMEOUT_MS);
    const response = await fetch(new URL("/.well-known/t3/environment", httpBaseUrl), {
      signal: request.signal,
    }).finally(() => clearTimeout(timer));
    if (!response.ok) throw new Error(String(response.status));
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("environmentId" in body) ||
      !("label" in body) ||
      typeof body.environmentId !== "string" ||
      typeof body.label !== "string"
    ) {
      throw new Error("Not a T3 Code environment.");
    }
    scanned = { environmentId: body.environmentId as EnvironmentId, label: body.label };
  } catch {
    return "This phone can't reach the computer you scanned. Make sure both are on the same network or tailnet.";
  }
  if (scanned.environmentId === targetEnvironmentId) {
    return "That is the same computer. Pick a different one to connect.";
  }
  const result = await connectionOffers.offer.run(appAtomRegistry, {
    environmentId: targetEnvironmentId,
    input: {
      environmentId: scanned.environmentId,
      label: scanned.label,
      pairingUrl,
      expiresAt: DateTime.add(DateTime.nowUnsafe(), { minutes: RELAY_LIFETIME_MINUTES }),
      connectBack: true,
    },
  });
  if (result._tag === "Success") return null;
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : String(failure);
}
