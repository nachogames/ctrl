import {
  type DesktopTailscalePeer,
  type DesktopTailscaleStatus,
  formatRoughDuration,
  type ServerTailscaleIssueCause,
  type ServerTailscaleStatus,
  t3ConnectTroubleshootingUrl,
  type T3ConnectTroubleshootingSection,
  tailscaleIssueHeadline,
  type TailscaleState,
} from "@t3tools/contracts";
import type { RelayEnvironmentStatusResponse } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";

import {
  type ConnectionAttemptError,
  type ConnectionFailureCause,
  type ConnectionHop,
  type ConnectionRouteOutcome,
  failureDidNotAnswer,
  routeDidNotAnswer,
  type SupervisorConnectionState,
} from "./model.ts";
import { tailnetRefusalVerdict } from "./tailnet.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export type ConnectionHopResult = "ok" | "failed" | "unchecked";

export interface ConnectionDiagnosisHop {
  readonly hop: ConnectionHop;
  readonly label: string;
  readonly result: ConnectionHopResult;
}

export interface ConnectionDiagnosis {
  /** Names the part that failed, e.g. "Mac mini's tunnel is offline". */
  readonly headline: string;
  readonly hops: ReadonlyArray<ConnectionDiagnosisHop>;
  readonly steps: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<readonly [label: string, value: string]>;
  /** The troubleshooting guide section for this failure, when one exists. */
  readonly moreInfoUrl: string | null;
  /** A tailnet policy grant the host says would let this device in, to paste. */
  readonly policySnippet: string | null;
}

/** This device's own Tailscale, when the platform can read it (desktop). */
export type LocalTailscaleStatus = Pick<DesktopTailscaleStatus, "state" | "peers">;

export interface ConnectionDiagnosisInput {
  readonly hostLabel: string;
  readonly state: SupervisorConnectionState;
  /** The environment's usual route, used when the failure does not name one. */
  readonly via: "relay" | "direct";
  /**
   * The relay's last health check. For a relay-only environment it can name a
   * cause before any connect attempt; with other routes it is one more fact.
   */
  readonly relayStatus?: Pick<
    RelayEnvironmentStatusResponse,
    "status" | "endpointFailure" | "endpointStatus" | "offlineReason"
  > | null;
  readonly clientVersion?: string | undefined;
  readonly serverVersion?: string | null | undefined;
  /** Turns the Tailscale hint into a verdict on platforms that can read it. */
  readonly localTailscale?: LocalTailscaleStatus | null;
  /** The host's own Tailscale, as it last reported in its server config. */
  readonly hostTailscale?: ServerTailscaleStatus | null | undefined;
  readonly now?: number;
}

const TAILSCALE_TROUBLESHOOTING_URL =
  "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md#tailscale-troubleshooting";

/** Tailscale routes when every one of them failed to reach the host, else none. */
function failedTailnetRoutes(
  routes: ReadonlyArray<ConnectionRouteOutcome>,
): ReadonlyArray<ConnectionRouteOutcome> {
  const tailnet = routes.filter((route) => route.kind === "tailnet");
  return tailnet.every(routeDidNotAnswer) ? tailnet : [];
}

/** True when every Tailscale route failed, so this device's own Tailscale is worth reading. */
export function everyTailnetRouteFailed(state: SupervisorConnectionState): boolean {
  return failedTailnetRoutes(state.routes).length > 0;
}

/** The latest outcome on one route, for a route list. */
export function routeOutcomeText(
  outcome: ConnectionRouteOutcome,
  resolve: MFunctionType = mFallback,
): string {
  if (outcome.result === "answered") return resolve(msg("Answered", { $context: "route outcome" }));
  return routeDidNotAnswer(outcome)
    ? resolve(msg("Did not answer", { $context: "route outcome" }))
    : resolve(msg("Failed", { $context: "route outcome" }));
}

/**
 * A hint, not a verdict: every Tailscale route failed while another route
 * answered, so Tailscale may be off on this device. A host that is off fails
 * every route, so it gets no hint.
 */
export function offTailnetHint(
  state: SupervisorConnectionState,
  resolve: MFunctionType = mFallback,
): string | null {
  if (!everyTailnetRouteFailed(state)) return null;
  const otherAnswered = state.routes.some(
    (route) => route.kind !== "tailnet" && route.result === "answered",
  );
  return otherAnswered ? resolve(msg("Check that Tailscale is on for this device.")) : null;
}

interface Located {
  readonly hop: ConnectionHop;
  readonly cause:
    | ConnectionFailureCause
    | "offline"
    | "outdated"
    | "released"
    | "session_pending"
    | null;
  /** The failure named no hop, so the hops before this one were never probed. */
  readonly guessed?: true;
}

const NOT_ANSWERING: ReadonlySet<ConnectionFailureCause> = new Set([
  "origin_unreachable",
  "invalid_response",
]);

function locate(input: ConnectionDiagnosisInput): Located | null {
  const failure = input.state.lastFailure;
  if (input.state.network === "offline" || input.state.phase === "offline") {
    return { hop: "device", cause: "offline" };
  }
  if (failure?._tag === "ConnectionBlockedError" && failure.serverUpdateRequired) {
    return { hop: "server", cause: "outdated" };
  }
  if (failure?.reason === "session-pending") {
    return { hop: "device", cause: "session_pending" };
  }
  if (failure?.hop !== undefined) {
    return { hop: failure.hop, cause: failure.failureCause ?? null };
  }
  if (failure !== null) {
    const unreachable =
      failure.reason === "network" ||
      failure.reason === "timeout" ||
      failure.reason === "transport";
    const via = failure.via ?? input.via;
    return {
      hop: unreachable && via === "relay" ? "tunnel" : "server",
      cause: null,
      guessed: true,
    };
  }
  // With other routes, the relay's health says nothing about the route in use.
  const status = input.via === "relay" ? input.relayStatus : null;
  if (status?.status !== "offline") return null;
  if (status.offlineReason === "tunnel_released") return { hop: "tunnel", cause: "released" };
  const cause = status.endpointFailure ?? null;
  return { hop: cause !== null && NOT_ANSWERING.has(cause) ? "server" : "tunnel", cause };
}

function headline(
  host: string,
  located: Located,
  failure: ConnectionAttemptError | null,
  resolve: MFunctionType,
): string {
  switch (located.cause) {
    case "offline":
      return resolve(msg("This device is offline"));
    case "session_pending":
      return resolve(msg("This device is still loading its T3 Connect sign-in"));
    case "approval_pending":
      return resolve(msg("{host} is waiting for someone to approve this device", { host }));
    case "outdated":
      return resolve(msg("{host} runs an older T3 Code", { host }));
    case "clock_skew":
      return resolve(msg("This device's clock is off"));
    case "not_linked":
      return resolve(msg("{host} is not linked to your T3 Connect account", { host }));
    case "relay_error":
      return resolve(msg("T3 Connect returned an error"));
    case "tunnel_pending":
      return resolve(msg("{host}'s tunnel is still being set up", { host }));
    case "tunnel_not_enabled":
      return resolve(msg("T3 Connect is not turned on for {host}", { host }));
    case "session_expired":
      return resolve(msg("This device's sign-in to {host} expired", { host }));
    case "released":
    case "tunnel_down":
      return resolve(msg("{host}'s tunnel is offline", { host }));
    case "origin_unreachable":
      return resolve(msg("Tunnel works, but T3 Code on {host} did not answer", { host }));
    case "invalid_response":
      return resolve(msg("T3 Code on {host} sent an unexpected answer", { host }));
    case "dns":
      return resolve(msg("{host}'s tunnel address did not resolve", { host }));
    case "tls":
      return resolve(msg("Secure connection to {host}'s tunnel failed", { host }));
    case "refused":
      return resolve(msg("{host}'s tunnel refused the connection", { host }));
    case "timeout":
      return resolve(msg("{host} did not answer in time", { host }));
    case "unknown":
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return resolve(msg("This device could not prepare the connection"));
    case "relay":
      return failure?.reason === "authentication"
        ? resolve(msg("T3 Connect did not accept this device's sign-in"))
        : resolve(msg("This device can't reach T3 Connect"));
    case "tunnel":
      // The relay already reached the host when this device fails on its own.
      return failure?.reason === "network" ||
        failure?.reason === "transport" ||
        failure?.reason === "timeout"
        ? resolve(msg("This device can't reach {host}'s tunnel", { host }))
        : resolve(msg("T3 Connect could not reach {host}'s tunnel", { host }));
    case "server":
      return failure?.reason === "authentication" || failure?.reason === "permission"
        ? resolve(msg("T3 Code on {host} did not accept this device", { host }))
        : resolve(msg("T3 Code on {host} did not answer", { host }));
  }
}

function steps(
  host: string,
  located: Located,
  failure: ConnectionAttemptError | null,
  resolve: MFunctionType,
): string[] {
  const checkHost = resolve(
    msg("On {host}, check Settings > Connections or run `t3 connect status`.", { host }),
  );
  switch (located.cause) {
    case "offline":
      return [resolve(msg("Connect this device to the internet. T3 Code reconnects on its own."))];
    case "session_pending":
      return [
        resolve(msg("Wait a moment. T3 Code retries on its own.")),
        resolve(msg("If it keeps waiting, reload or restart T3 Code on this device.")),
      ];
    case "approval_pending": {
      const code =
        failure?._tag === "ConnectionTransientError" ? failure.verificationCode : undefined;
      return [
        code
          ? resolve(
              msg(
                "On a device already connected to {host}, open Settings > Sharing & access and approve the device showing {code}.",
                { host, code },
              ),
            )
          : resolve(
              msg(
                "On a device already connected to {host}, open Settings > Sharing & access and approve this device.",
                { host },
              ),
            ),
        resolve(
          msg("Or run `t3 auth connect-device approve {code}` on {host}.", {
            code: code ?? "<code>",
            host,
          }),
        ),
      ];
    }
    case "outdated":
      return [resolve(msg("Update T3 Code on {host}.", { host }))];
    case "clock_skew":
      return [
        resolve(
          msg("Turn on automatic date and time on this device and on {host}, then retry.", {
            host,
          }),
        ),
      ];
    case "not_linked":
      return [
        resolve(
          msg("Check that this device is signed in to the same T3 Connect account as the host."),
        ),
        resolve(msg("On {host}, open Settings > Connections and turn T3 Connect on.", { host })),
      ];
    case "tunnel_pending":
      return [resolve(msg("Wait a minute. T3 Code retries on its own.")), checkHost];
    case "relay_error":
      return [
        resolve(msg("Wait a few minutes. T3 Code retries on its own.")),
        resolve(msg("If it keeps failing, copy the diagnostics and report it.")),
      ];
    case "tunnel_not_enabled":
      return [
        resolve(msg("On {host}, open Settings > Connections and turn T3 Connect on.", { host })),
      ];
    case "session_expired":
      return [
        resolve(msg("On {host}, open Settings > Connections and choose Add a device.", { host })),
        resolve(
          msg("Pair this device with that code again. Its routes and settings stay as they are."),
        ),
      ];
    case "released":
    case "tunnel_down":
      return [
        resolve(msg("Make sure {host} is awake and T3 Code is running on it.", { host })),
        checkHost,
        resolve(
          msg(
            "A VPN or Tailscale exit node on {host} can block the tunnel (port 7844). Turn it off or allow the tunnel.",
            { host },
          ),
        ),
      ];
    case "origin_unreachable":
    case "invalid_response":
      return [resolve(msg("Open or restart T3 Code on {host}.", { host })), checkHost];
    // The relay saw these on its way to the host, so the fix is on the host.
    case "dns":
    case "tls":
    case "refused":
    case "timeout":
    case "unknown":
      return [resolve(msg("Make sure {host} is awake and online.", { host })), checkHost];
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return [
        resolve(msg("Restart T3 Code on this device.")),
        resolve(
          msg("If it keeps failing, remove {host} from this device and add it again.", { host }),
        ),
      ];
    case "relay":
      return failure?.reason === "authentication"
        ? [resolve(msg("Sign out of T3 Connect and sign in again."))]
        : [
            resolve(msg("Check this device's internet connection.")),
            resolve(msg("A VPN, firewall, or ad blocker on this device can block T3 Connect.")),
          ];
    case "tunnel":
      return failure?.reason === "network" ||
        failure?.reason === "transport" ||
        failure?.reason === "timeout"
        ? [
            resolve(msg("A VPN, firewall, or DNS filter on this device can block the tunnel.")),
            resolve(msg("Try another network, or add a direct route such as a Tailscale address.")),
          ]
        : [resolve(msg("Make sure {host} is awake and online.", { host })), checkHost];
    case "server":
      return failure?.reason === "authentication"
        ? [
            resolve(
              msg(
                "This device's sign-in to {host} expired or was revoked. Pair it again with a new pairing link from {host}.",
                { host },
              ),
            ),
          ]
        : [
            resolve(msg("Make sure T3 Code is running on {host}.", { host })),
            resolve(msg("Retry. If it keeps failing, copy the diagnostics.")),
          ];
  }
}

function helpSection(
  located: Located,
  failure: ConnectionAttemptError | null,
): T3ConnectTroubleshootingSection {
  switch (located.cause) {
    case "offline":
      return "this-device-cant-reach-t3-connect";
    case "outdated":
      return "the-host-runs-an-older-t3-code";
    case "clock_skew":
      return "the-clock-is-off";
    case "session_pending":
    case "approval_pending":
    case "not_linked":
    case "tunnel_not_enabled":
    case "session_expired":
      return "sign-in-account-or-link-problems";
    case "relay_error":
      return "t3-connect-returned-an-error";
    case "released":
    case "tunnel_down":
    case "tunnel_pending":
      return "the-hosts-tunnel-is-offline";
    case "origin_unreachable":
    case "invalid_response":
      return "the-tunnel-works-but-t3-code-does-not-answer";
    case "dns":
    case "tls":
    case "refused":
    case "timeout":
    case "unknown":
      return "the-t3-connect-address-does-not-resolve-or-answer";
    case null:
      break;
  }
  const onThisDevice =
    failure?.reason === "network" ||
    failure?.reason === "transport" ||
    failure?.reason === "timeout";
  switch (located.hop) {
    case "device":
      return "this-device-cant-reach-t3-connect";
    case "relay":
      return failure?.reason === "authentication"
        ? "sign-in-account-or-link-problems"
        : "this-device-cant-reach-t3-connect";
    case "tunnel":
      return onThisDevice ? "this-device-cant-reach-t3-connect" : "the-hosts-tunnel-is-offline";
    case "server":
      return failure?.reason === "authentication" || failure?.reason === "permission"
        ? "sign-in-account-or-link-problems"
        : "the-tunnel-works-but-t3-code-does-not-answer";
  }
}

const T3_CONNECT_NAME = "T3 Connect";

const HOP_ORDER = {
  relay: ["device", "relay", "tunnel", "server"],
  direct: ["device", "server"],
} as const;

function hopLabel(hop: ConnectionHop, host: string, resolve: MFunctionType): string {
  switch (hop) {
    case "device":
      return resolve(msg("This device"));
    case "relay":
      return T3_CONNECT_NAME;
    case "tunnel":
      return resolve(msg("{host} tunnel", { host }));
    case "server":
      return resolve(msg("T3 Code on {host}", { host }));
  }
}

/** Local states that rule out every Tailscale route from this device. */
function localTailscaleDown(
  state: TailscaleState | undefined,
): state is Exclude<TailscaleState, "running" | "unreadable"> {
  return state !== undefined && state !== "running" && state !== "unreadable";
}

/** Host issues that stop its Tailscale address from answering. */
const HOST_TAILSCALE_DOWN: ReadonlySet<ServerTailscaleIssueCause> = new Set([
  "not_running",
  "needs_login",
  "needs_machine_approval",
  "stopped",
  "key_expired",
]);

/** Also shown on a host's row; the rest only matter while setting up the host. */
const HOST_TAILSCALE_NOTICE: ReadonlySet<ServerTailscaleIssueCause> = new Set([
  ...HOST_TAILSCALE_DOWN,
  "key_expiring",
  "health_warning",
  "outdated",
  "no_ipv4",
  "userspace_networking",
]);

/** " (as of 2h ago)" for facts a minute old or more. */
function asOf(checkedAt: string, now: number): string {
  const age = now - Date.parse(checkedAt);
  return age >= 60_000 ? ` (as of ${formatRoughDuration(age)} ago)` : "";
}

/** The host's Tailscale problem as one headline and its fix, from the facts it last reported. */
export function hostTailscaleNotice(
  hostLabel: string,
  status: ServerTailscaleStatus | null | undefined,
  now: number,
  causes: ReadonlySet<ServerTailscaleIssueCause> = HOST_TAILSCALE_NOTICE,
): { readonly headline: string; readonly fix: string } | null {
  const issue = status?.issues.find((candidate) => causes.has(candidate.cause));
  if (status == null || issue === undefined) return null;
  return {
    headline: `${tailscaleIssueHeadline(hostLabel, issue, status.keyExpiry, now)}${asOf(status.checkedAt, now)}`,
    fix: `On ${hostLabel}: ${issue.fix}`,
  };
}

/**
 * The path to a peer, only while it is active. `relay` is the peer's home DERP
 * region even on a direct path, so it means DERP only without the others.
 */
function tailscalePeerPath(peer: DesktopTailscalePeer): string | null {
  if (!peer.active) return null;
  if (peer.curAddr !== null) return "direct";
  if (peer.peerRelay !== null) return "peer relay";
  return peer.relay !== null ? `DERP (${peer.relay})` : null;
}

// Peers list only IPv4 tailnet addresses, so an IPv6 route cannot be matched.
function routeHostname(address: string | null): string | null {
  if (address === null || !URL.canParse(address)) return null;
  const hostname = new URL(address).hostname.toLowerCase();
  return hostname.startsWith("[") ? null : hostname;
}

/**
 * The peer behind any of the failed routes, by tailnet address or MagicDNS
 * name. Undefined when no route has an address a peer could match.
 */
function routePeer(
  peers: ReadonlyArray<DesktopTailscalePeer>,
  routes: ReadonlyArray<ConnectionRouteOutcome>,
): DesktopTailscalePeer | null | undefined {
  const hostnames = new Set(routes.flatMap((route) => routeHostname(route.address) ?? []));
  if (hostnames.size === 0) return undefined;
  return (
    peers.find((peer) => {
      const dnsName = peer.magicDnsName?.toLowerCase();
      return (
        peer.tailnetAddresses.some((address) => hostnames.has(address)) ||
        (dnsName !== undefined &&
          (hostnames.has(dnsName) || hostnames.has(dnsName.split(".")[0] ?? "")))
      );
    }) ?? null
  );
}

function lastSeen(peer: DesktopTailscalePeer, now: number): string | null {
  return peer.lastSeen === null
    ? null
    : `last seen ${formatRoughDuration(now - Date.parse(peer.lastSeen))} ago`;
}

function peerFact(peer: DesktopTailscalePeer | null | undefined, now: number): string | null {
  if (peer === undefined) return null;
  if (peer === null) return "not on this device's tailnet";
  const detail = peer.online ? tailscalePeerPath(peer) : lastSeen(peer, now);
  return [peer.online ? "online" : "offline", detail].filter(Boolean).join(", ");
}

interface TailnetVerdict {
  readonly headline: string;
  readonly steps: ReadonlyArray<string>;
}

/** Why every Tailscale route failed: this device, then the host's report, then the peer list. */
function tailnetVerdict(
  input: ConnectionDiagnosisInput,
  routes: ReadonlyArray<ConnectionRouteOutcome>,
  now: number,
  resolve: MFunctionType,
): TailnetVerdict {
  const host = input.hostLabel;
  const local = input.localTailscale;
  const awake = resolve(msg("Make sure {host} is awake and T3 Code is running on it.", { host }));
  if (localTailscaleDown(local?.state)) {
    return {
      headline: tailscaleIssueHeadline("this device", { cause: local.state, fix: "" }, null, now),
      steps: [
        local.state === "needs_machine_approval"
          ? resolve(
              msg(
                "Approve this device at https://login.tailscale.com/admin/machines. T3 Code reconnects on its own.",
              ),
            )
          : resolve(
              msg("Turn on Tailscale on this device and sign in. T3 Code reconnects on its own."),
            ),
      ],
    };
  }
  const hostNotice = hostTailscaleNotice(host, input.hostTailscale, now, HOST_TAILSCALE_DOWN);
  if (hostNotice !== null) return { headline: hostNotice.headline, steps: [hostNotice.fix] };

  const generic =
    input.relayStatus?.status === "online"
      ? resolve(
          msg("{host} is online on T3 Connect, but its Tailscale address did not answer", {
            host,
          }),
        )
      : resolve(msg("{host} did not answer over Tailscale", { host }));
  const peer = local?.state === "running" ? routePeer(local.peers, routes) : undefined;
  if (peer === undefined) {
    return {
      headline: generic,
      steps: [
        resolve(
          msg("Check that Tailscale is on and signed in on this device and on {host}.", { host }),
        ),
        awake,
      ],
    };
  }
  if (peer === null) {
    return {
      headline: resolve(msg("{host} is not on this device's tailnet", { host })),
      steps: [
        resolve(msg("Sign in to the same tailnet on this device and on {host}.", { host })),
        awake,
      ],
    };
  }
  // Online means connected to Tailscale's control plane, not reachable from here.
  if (!peer.online) {
    const seen = lastSeen(peer, now);
    return {
      headline:
        seen === null
          ? resolve(msg("{host} is offline on your tailnet", { host }))
          : resolve(msg("{host} is offline on your tailnet ({seen})", { host, seen })),
      steps: [resolve(msg("Make sure {host} is awake and Tailscale is on.", { host }))],
    };
  }
  // A direct or peer-relay path means a handshake worked, so Tailscale reaches the host.
  const reached = peer.active && (peer.curAddr !== null || peer.peerRelay !== null);
  return {
    headline: reached ? resolve(msg("T3 Code on {host} did not answer", { host })) : generic,
    steps: [awake, resolve(msg("Check that no firewall on {host} blocks its port.", { host }))],
  };
}

/**
 * Turns a connection state into what failed, in order, and what to try. Returns
 * null when nothing has failed. Web and mobile render this same model.
 */
export function presentConnectionDiagnosis(
  input: ConnectionDiagnosisInput,
  resolve: MFunctionType = mFallback,
): ConnectionDiagnosis | null {
  const located = locate(input);
  if (located === null) return null;
  const host = input.hostLabel;
  const failure = input.state.lastFailure;
  // A direct route that did not answer, where every Tailscale route also failed.
  // A refusal from an earlier attempt says nothing once this device is offline.
  const refusal = located.hop === "server" ? failure?.tailnetRefusal : undefined;
  const tailnetRoutes =
    located.hop === "server" &&
    located.cause === null &&
    failure !== null &&
    failureDidNotAnswer(failure)
      ? failedTailnetRoutes(input.state.routes)
      : [];
  const tailnet = tailnetRoutes.length > 0;
  const local = input.localTailscale;
  const tailscaleOff = tailnet && localTailscaleDown(local?.state);
  const now = input.now ?? DateTime.toEpochMillis(DateTime.nowUnsafe());
  const relayPath =
    located.hop === "relay" ||
    located.hop === "tunnel" ||
    (failure === null && input.relayStatus?.status === "offline") ||
    (failure?.via ?? input.via) === "relay";
  const order: ReadonlyArray<ConnectionHop> = HOP_ORDER[relayPath ? "relay" : "direct"];
  const failedIndex = order.indexOf(tailscaleOff ? "device" : located.hop);
  const hops = order.map((hop, index): ConnectionDiagnosisHop => ({
    hop,
    label: hopLabel(hop, host, resolve),
    result:
      index === failedIndex
        ? "failed"
        : index < failedIndex && located.guessed !== true
          ? "ok"
          : "unchecked",
  }));

  // The relay health check only explains the state when no attempt has failed yet.
  const httpStatus = failure !== null ? failure.httpStatus : input.relayStatus?.endpointStatus;
  const facts: Array<readonly [string, string]> = [];
  const add = (label: string, value: string | number | null | undefined) => {
    if (value !== null && value !== undefined && value !== "") facts.push([label, String(value)]);
  };
  add(
    resolve(msg("Cause", { $context: "diagnostics field label" })),
    refusal ?? located.cause ?? failure?.reason,
  );
  add(resolve(msg("HTTP status")), httpStatus);
  add(
    resolve(msg("Attempts", { $context: "diagnostics field label" })),
    input.state.attempt > 0 ? input.state.attempt : null,
  );
  add(
    resolve(msg("Next retry")),
    input.state.retryAt === null
      ? null
      : DateTime.formatIso(DateTime.makeUnsafe(input.state.retryAt)),
  );
  add(
    resolve(msg("Route", { $context: "diagnostics field label" })),
    relayPath ? "T3 Connect" : resolve(msg("Direct", { $context: "connection route" })),
  );
  for (const route of tailnetRoutes) {
    add(resolve(msg("Failed route")), `Tailscale ${route.address ?? ""}`.trim());
  }
  if (tailnet) {
    add(resolve(msg("Tailscale on this device")), local?.state);
    if (local?.state === "running") {
      add(resolve(msg("Tailscale peer")), peerFact(routePeer(local.peers, tailnetRoutes), now));
    }
    const hostTailscale = input.hostTailscale;
    if (hostTailscale != null) {
      add(
        resolve(msg("Tailscale on host")),
        `${hostTailscale.state}${asOf(hostTailscale.checkedAt, now)}`,
      );
    }
  }
  if (input.via !== "relay") add(T3_CONNECT_NAME, input.relayStatus?.status);
  add(resolve(msg("App version")), input.clientVersion);
  add(resolve(msg("Host version")), input.serverVersion);
  add(
    resolve(msg("Error", { $context: "diagnostics field label" })),
    refusal === undefined ? failure?.detail : undefined,
  );
  add(resolve(msg("Trace ID")), failure?.traceId);

  const verdict =
    refusal !== undefined
      ? tailnetRefusalVerdict(host, refusal)
      : tailnet
        ? tailnetVerdict(input, tailnetRoutes, now, resolve)
        : null;
  return {
    headline: verdict?.headline ?? headline(host, located, failure, resolve),
    hops,
    steps: verdict?.steps ?? steps(host, located, failure, resolve),
    facts,
    moreInfoUrl:
      tailnet || refusal !== undefined
        ? TAILSCALE_TROUBLESHOOTING_URL
        : relayPath || located.cause === "session_pending"
          ? t3ConnectTroubleshootingUrl(helpSection(located, failure))
          : null,
    policySnippet: refusal === undefined ? null : (failure?.suggestedGrant ?? null),
  };
}

const HOP_MARK = { ok: "ok", failed: "FAILED", unchecked: "not checked" } as const;

/** One plain-text block for bug reports. */
export function connectionDiagnosisText(hostLabel: string, diagnosis: ConnectionDiagnosis): string {
  return [
    `T3 Code connection to ${hostLabel}: ${diagnosis.headline}`,
    "",
    ...diagnosis.hops.map((hop) => `${hop.label}: ${HOP_MARK[hop.result]}`),
    "",
    ...diagnosis.facts.map(([label, value]) => `${label}: ${value}`),
    ...(diagnosis.policySnippet
      ? ["", "Grant to add to your tailnet policy:", diagnosis.policySnippet]
      : []),
    ...(diagnosis.moreInfoUrl ? ["", `More info: ${diagnosis.moreInfoUrl}`] : []),
  ].join("\n");
}
