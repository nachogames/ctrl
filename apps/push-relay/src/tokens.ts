const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

/** A 256-bit random send token. It is the only permission to alert one phone. */
export function newSendToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** KV keys are token hashes, so a copy of the store cannot be used to send. */
export async function hashSendToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
