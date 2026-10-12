import {
  type PushRelayRegisterRequest,
  PushRelayRegisterResponse,
  type PushRelayTokens,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeResponse = Schema.decodeUnknownOption(PushRelayRegisterResponse);

/**
 * Signs this phone up with the push relay, or refreshes it. Returns the
 * phone's relay tokens, or null when the relay cannot be reached; callers keep
 * using the tokens they saved and retry next time.
 */
export async function registerWithPushRelay(
  input: {
    readonly relayUrl: string;
    readonly current: PushRelayTokens | null;
    readonly reset: boolean;
    readonly request: Omit<PushRelayRegisterRequest, "reset" | "current">;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<PushRelayTokens | null> {
  try {
    const response = await fetchImpl(new URL("/register", input.relayUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...input.request,
        ...(input.reset ? { reset: true } : {}),
        ...(input.current ? { current: input.current } : {}),
      }),
    });
    if (response.status !== 200) return null;
    const decoded = decodeResponse(await response.json());
    return decoded._tag === "Some" ? decoded.value : null;
  } catch {
    return null;
  }
}
