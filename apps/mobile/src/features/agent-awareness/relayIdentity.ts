// Kept dependency-free: the connection runtime imports direct push, so direct
// push must not import remoteRegistration (it pulls the runtime back in).
let relayIdentity: string | null = null;
const listeners = new Set<() => void>();

/** The signed-in T3 Connect user the Android FCM handler is bound to, if any. */
export function getAgentAwarenessRelayIdentity(): string | null {
  return relayIdentity;
}

/**
 * Called whenever T3 Connect sign-in changes. Signing out clears the Android
 * FCM handler's configuration, so listeners (direct push) re-apply theirs.
 */
export function setAgentAwarenessRelayIdentity(identity: string | null): void {
  relayIdentity = identity;
  for (const listener of listeners) listener();
}

export function onAgentAwarenessRelayIdentityChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
