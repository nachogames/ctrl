import { describe, expect, it } from "vite-plus/test";

import { registerWithPushRelay } from "./pushRelayClient";

const request = {
  deviceId: "d",
  platform: "android",
  pushToken: "fcm",
  bundleId: "com.nachogames.ctrl",
  androidUserId: "direct",
} as const;

function fakeFetch(response: Response | Error) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
  return { impl, calls };
}

describe("registerWithPushRelay", () => {
  it("sends the current token as a bearer header and returns the relay's token", async () => {
    const fetch = fakeFetch(new Response(JSON.stringify({ sendToken: "new" })));
    const token = await registerWithPushRelay(
      { relayUrl: "https://relay.test", currentToken: "old", reset: true, request },
      fetch.impl,
    );
    expect(token).toBe("new");
    expect(fetch.calls[0]?.url).toBe("https://relay.test/register");
    expect(new Headers(fetch.calls[0]?.init?.headers).get("authorization")).toBe("Bearer old");
    expect(JSON.parse(String(fetch.calls[0]?.init?.body))).toEqual({ ...request, reset: true });
  });

  it("omits the header on first sign-up", async () => {
    const fetch = fakeFetch(new Response(JSON.stringify({ sendToken: "t" })));
    await registerWithPushRelay(
      { relayUrl: "https://relay.test", currentToken: null, reset: false, request },
      fetch.impl,
    );
    expect(new Headers(fetch.calls[0]?.init?.headers).has("authorization")).toBe(false);
  });

  it("returns null when the relay is unreachable or refuses, so local keys keep working", async () => {
    for (const response of [
      new Error("offline"),
      new Response("{}", { status: 429 }),
      new Response("nope"),
    ]) {
      expect(
        await registerWithPushRelay(
          { relayUrl: "https://relay.test", currentToken: null, reset: false, request },
          fakeFetch(response).impl,
        ),
      ).toBeNull();
    }
  });
});
