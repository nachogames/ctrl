/**
 * Ctrl push relay. Holds the APNs and FCM keys so paired computers can alert a
 * phone without keys of their own. See docs/operations/ctrl-push-relay.md.
 */
import type { Deps, Env } from "./env.ts";
import { json } from "./http.ts";
import { handleRegister } from "./register.ts";
import { handleSend } from "./send.ts";

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === "POST" && pathname === "/register") {
    return handleRegister(request, env, deps);
  }
  if (request.method === "POST" && pathname === "/send") {
    return handleSend(request, env, deps);
  }
  return json(404, { error: "not_found" });
}

// The relay is a small plain Worker; this is the one place it touches the
// platform's network and clock, and tests replace both through `Deps`.
const platformDeps: Deps = {
  // @effect-diagnostics-next-line globalFetch:off -- plain Worker, no Effect runtime
  fetch: (input, init) => fetch(input, init),
  // @effect-diagnostics-next-line globalDate:off -- plain Worker, no Effect runtime
  now: () => Date.now(),
};

export default {
  fetch: (request: Request, env: Env) => handle(request, env, platformDeps),
};
