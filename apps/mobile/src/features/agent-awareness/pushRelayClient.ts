import { type PushRelayRegisterRequest, PushRelayRegisterResponse } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeResponse = Schema.decodeUnknownOption(PushRelayRegisterResponse);

/**
 * Signs this phone up with the push relay, or refreshes it. Returns the send
 * token computers use to alert this phone, or null when the relay cannot be
 * reached; registration then continues without it and retries next time.
 */
export async function registerWithPushRelay(
  input: {
    readonly relayUrl: string;
    readonly currentToken: string | null;
    readonly reset: boolean;
    readonly request: Omit<PushRelayRegisterRequest, "reset">;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(new URL("/register", input.relayUrl).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.currentToken ? { authorization: `Bearer ${input.currentToken}` } : {}),
      },
      body: JSON.stringify({ ...input.request, ...(input.reset ? { reset: true } : {}) }),
    });
    if (response.status !== 200) return null;
    const decoded = decodeResponse(await response.json());
    return decoded._tag === "Some" ? decoded.value.sendToken : null;
  } catch {
    return null;
  }
}
