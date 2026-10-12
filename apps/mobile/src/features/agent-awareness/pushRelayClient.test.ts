import { describe, expect, it } from "vite-plus/test";

import { registerWithPushRelay } from "./pushRelayClient";

const request = {
  deviceId: "d",
  platform: "android",
  pushToken: "fcm",
  bundleId: "com.nachogames.ctrl",
  androidUserId: "direct",
} as const;
const tokens = { sendToken: "send", manageToken: "manage" };

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
  it("presents the current tokens and returns the relay's", async () => {
    const fresh = { sendToken: "new-send", manageToken: "new-manage" };
    const fetch = fakeFetch(new Response(JSON.stringify(fresh)));
    const result = await registerWithPushRelay(
      { relayUrl: "https://relay.test", current: tokens, reset: true, request },
      fetch.impl,
    );
    expect(result).toEqual(fresh);
    expect(fetch.calls[0]?.url).toBe("https://relay.test/register");
    expect(JSON.parse(String(fetch.calls[0]?.init?.body))).toEqual({
      ...request,
      reset: true,
      current: tokens,
    });
  });

  it("signs up without tokens the first time", async () => {
    const fetch = fakeFetch(new Response(JSON.stringify(tokens)));
    await registerWithPushRelay(
      { relayUrl: "https://relay.test", current: null, reset: false, request },
      fetch.impl,
    );
    expect(JSON.parse(String(fetch.calls[0]?.init?.body))).toEqual(request);
  });

  it("returns null when the relay is unreachable or refuses", async () => {
    for (const response of [
      new Error("offline"),
      new Response("{}", { status: 429 }),
      new Response("nope"),
      new Response(JSON.stringify({ sendToken: "only-send" })),
    ]) {
      expect(
        await registerWithPushRelay(
          { relayUrl: "https://relay.test", current: null, reset: false, request },
          fakeFetch(response).impl,
        ),
      ).toBeNull();
    }
  });
});
