import { REMOTE_MCP_OAUTH_CALLBACK_PATH } from "@t3tools/contracts/remoteMcp";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { renderNoticePage } from "../auth/mcpOAuthHtml.ts";
import * as RemoteMcpServers from "./RemoteMcpServers.ts";

const PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const page = (status: number, heading: string, message: string) =>
  HttpServerResponse.text(renderNoticePage({ heading, message }), {
    status,
    contentType: "text/html; charset=utf-8",
    headers: PAGE_HEADERS,
  });

const handler = Effect.fn("RemoteMcpCallbackRoute.handler")(function* (
  remoteMcp: RemoteMcpServers.RemoteMcpServers["Service"],
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return page(400, "Sign-in failed", "The sign-in response was malformed.");
  const params = url.value.searchParams;
  const state = params.get("state");
  const code = params.get("code");
  const denied = params.get("error");
  if (denied !== null || state === null || code === null) {
    return page(
      400,
      "Sign-in failed",
      denied === "access_denied"
        ? "The sign-in was declined."
        : "The server did not return a sign-in code. Start the sign-in again from Settings.",
    );
  }
  return yield* remoteMcp.completeAuthorization({ state, code }).pipe(
    Effect.match({
      onFailure: (error) => page(400, "Sign-in failed", error.message),
      onSuccess: ({ name }) => page(200, "Signed in", `T3 Code is connected to ${name}.`),
    }),
  );
});

/**
 * The remote server's authorization server redirects the browser here. It
 * carries no T3 credential, so the one-time `state` minted by `authorize` is
 * what ties it to the sign-in an admin started.
 */
export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const remoteMcp = yield* RemoteMcpServers.RemoteMcpServers;
    yield* router.add("GET", REMOTE_MCP_OAUTH_CALLBACK_PATH, handler(remoteMcp));
  }),
);
