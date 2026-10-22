// @effect-diagnostics nodeBuiltinImport:off - constant-time token comparison.
import * as NodeCrypto from "node:crypto";

import {
  CURSOR_HOOK_PATH,
  CURSOR_HOOK_TOKEN_ENV,
  decideCursorMcpHook,
} from "@t3tools/provider-cursor/server/CursorMcpApprovals";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

const handler = Effect.fn("CursorApprovalRoute.handle")(function* (expectedAuthorization: string) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const authorization = Buffer.from(request.headers["authorization"] ?? "");
  const expected = Buffer.from(expectedAuthorization);
  if (
    authorization.length !== expected.length ||
    !NodeCrypto.timingSafeEqual(authorization, expected)
  ) {
    return HttpServerResponse.jsonUnsafe({ permission: "deny" }, { status: 401 });
  }
  const payload = yield* request.json.pipe(Effect.orElseSucceed(() => null));
  const response = yield* decideCursorMcpHook(payload).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Cursor MCP approval hook failed.", { cause }).pipe(
        Effect.as({
          permission: "deny" as const,
          user_message: "Ctrl could not decide on this MCP call.",
        }),
      ),
    ),
  );
  return HttpServerResponse.jsonUnsafe(response);
});

/**
 * Ctrl's Cursor approval hook posts each MCP call here and waits for the
 * answer. Cursor runs hooks as children of this server, so they inherit the
 * secret token from this process's environment; nothing else knows it.
 */
export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const token = Buffer.from(yield* crypto.randomBytes(32).pipe(Effect.orDie)).toString("hex");
    const environment = yield* HostProcess.Environment;
    environment[CURSOR_HOOK_TOKEN_ENV] = token;
    yield* router.add("POST", CURSOR_HOOK_PATH, handler(`Bearer ${token}`));
  }),
);
