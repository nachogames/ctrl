import * as DateTime from "effect/DateTime";

import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";
import { getPairingTokenFromUrl, setPairingTokenOnUrl } from "@t3tools/shared/remote";
import { readHostedPairingRequest } from "../../hostedPairing";
import {
  isLoopbackHostname,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
} from "~/environments/primary";
import {
  type AdvertisedEndpoint,
  type AuthClientSession,
  type AuthGrantScope,
  type AuthPairingLink,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type DesktopBridge,
  type DesktopServerExposureState,
  type DesktopSshEnvironmentTarget,
  type DesktopUpdateState,
  type DesktopWslState,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  getDesktopUpdateDownloadedVersion,
  resolveDesktopUpdateButtonAction,
} from "../desktopUpdate.logic";

/** Keep terminal:read with terminal:operate to avoid creating unseen shells on every script run. */
export function togglePairingScopeSelection(
  current: ReadonlyArray<AuthGrantScope>,
  scope: AuthGrantScope,
  checked: boolean,
): ReadonlyArray<AuthGrantScope> {
  const without = (scopes: ReadonlyArray<AuthGrantScope>) =>
    scopes.filter((currentScope) => currentScope !== scope);
  if (!checked) {
    return scope === AuthTerminalReadScope
      ? without(current).filter((currentScope) => currentScope !== AuthTerminalOperateScope)
      : without(current);
  }
  const next = [...without(current), scope];
  return scope === AuthTerminalOperateScope && !next.includes(AuthTerminalReadScope)
    ? [...next, AuthTerminalReadScope]
    : next;
}

export function canRevokeOtherClients(
  clientSessions: ReadonlyArray<{ readonly current: boolean }> | null,
): boolean {
  return clientSessions === null || clientSessions.some((session) => !session.current);
}

type WslEnableBridge = Pick<DesktopBridge, "setWslBackendEnabled" | "setWslDistro" | "setWslOnly">;

/** Never offer loopback URLs as QR targets; scanning devices would connect to themselves. */
export function isQrShareableEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.status !== "unavailable" && endpoint.reachability !== "loopback";
}

/**
 * The switch shows the saved Serve setting, so unreachable Serve can still be turned off; Serve
 * that answers is working however it was set up. Detection is skipped while Network access and
 * Serve are off (macOS prompts), so a missing endpoint still offers the switch.
 */
export function resolveTailscaleHttpsRow(input: {
  readonly state: Pick<DesktopServerExposureState, "mode" | "tailscaleServeEnabled"> | null;
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
}): {
  readonly description: string;
  readonly status: string | null;
  readonly switchChecked: boolean | null;
  readonly working: boolean;
} {
  const { state, endpoints } = input;
  const endpoint = endpoints.find(isTailscaleHttpsEndpoint) ?? null;
  const working = endpoint?.status === "available";
  const missingDescription = endpoints.some((candidate) => candidate.id.startsWith("tailscale-ip:"))
    ? "Tailscale is running, but its MagicDNS name could not be read. Make sure the tailscale command is installed and MagicDNS is on."
    : "Start Tailscale to set up HTTPS access through MagicDNS.";
  if (state?.tailscaleServeEnabled) {
    return {
      description: endpoint?.httpBaseUrl ?? missingDescription,
      status:
        endpoint !== null && !working
          ? "This URL does not reach this backend yet, so pairing links leave it out."
          : null,
      switchChecked: true,
      working,
    };
  }
  if (working) {
    return { description: endpoint.httpBaseUrl, status: null, switchChecked: false, working };
  }
  if (endpoint !== null || (state !== null && state.mode !== "network-accessible")) {
    return {
      description: "Off. Turn it on to reach this machine from your other devices on Tailscale.",
      status: null,
      switchChecked: false,
      working,
    };
  }
  return { description: missingDescription, status: null, switchChecked: null, working };
}

export function resolveTailscaleServeBaseUrl(
  endpoint: Pick<AdvertisedEndpoint, "httpBaseUrl"> | null,
  port: number,
  isPortValid: boolean,
): string | null {
  if (!endpoint) return null;
  if (!isPortValid) return endpoint.httpBaseUrl;
  try {
    const url = new URL(endpoint.httpBaseUrl);
    url.port = String(port);
    return url.toString().replace(/\/$/u, "");
  } catch {
    return endpoint.httpBaseUrl;
  }
}

export function isWslSettingsRowVisible(input: {
  readonly state: DesktopWslState | null;
  readonly error: string | null;
}): boolean {
  const { state, error } = input;
  return state ? state.available || state.enabled || state.wslOnly : error !== null;
}

/**
 * Once client/server versions match, this passive Version label follows the sidebar update action,
 * including retryable failures. Rechecks retain downloaded-update labels; `state` is null outside desktop.
 */
export function resolveLocalVersionStatusLabel(state: DesktopUpdateState | null): string {
  if (!state) return "Up to date";
  if (state.status === "downloading") {
    return state.availableVersion
      ? `Downloading update ${state.availableVersion}`
      : "Downloading update";
  }
  const action = resolveDesktopUpdateButtonAction(state);
  if (
    action === "install" ||
    state.status === "downloaded" ||
    (state.status === "checking" && state.downloadedVersion !== null)
  ) {
    const version = getDesktopUpdateDownloadedVersion(state);
    return version ? `Update ${version} downloaded` : "Update downloaded";
  }
  if (action === "download") {
    return state.availableVersion
      ? `Update ${state.availableVersion} available`
      : "Update available";
  }
  return "Up to date";
}

export type QrEndpointOption = {
  readonly id: string;
  /** Stable per endpoint type, not unique; used only to match the saved default. */
  readonly preferenceKey: string;
  readonly qrShareable: boolean;
};

export function selectQrEndpointOption<T extends QrEndpointOption>(
  options: ReadonlyArray<T>,
  selectedId: string | null,
  defaultPreferenceKey: string | null,
): T | null {
  return (
    (selectedId !== null ? options.find((option) => option.id === selectedId) : undefined) ??
    (defaultPreferenceKey !== null
      ? options.find((option) => option.preferenceKey === defaultPreferenceKey)
      : undefined) ??
    options.find((option) => option.qrShareable) ??
    options[0] ??
    null
  );
}

export async function applyWslEnableSelection(input: {
  readonly bridge: WslEnableBridge;
  readonly mode: "both" | "wsl-only";
  readonly nextDistro: string | null;
  readonly persistedDistro: string | null;
}): Promise<DesktopWslState> {
  const { bridge, mode, nextDistro, persistedDistro } = input;

  // Stage preferences before enabling; only the final call should relaunch WSL with the complete selection.
  await bridge.setWslOnly(mode === "wsl-only");
  if (persistedDistro !== nextDistro) {
    await bridge.setWslDistro(nextDistro);
  }
  return await bridge.setWslBackendEnabled(true);
}

const accessTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const SIGN_OUT_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;
const signOutDayFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const signOutTimeFormatter = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/**
 * "Signs out Nov 18" for a device within a week of being signed out for going unused. A
 * connected device renews while it stays connected, so it gets none.
 */
export function clientSignOutNotice(
  session: {
    readonly subject: string;
    readonly method: string;
    readonly expiresAt: string;
    readonly connected: boolean;
    readonly current: boolean;
  },
  nowMs: number,
): string | null {
  // Only link-paired devices lapse for going unused; others renew their own short tokens.
  const renewable =
    session.subject === "one-time-token" &&
    (session.method === "bearer-access-token" || session.method === "browser-session-cookie");
  if (!renewable || session.connected || session.current) return null;
  const expiresAtMs = new Date(session.expiresAt).getTime();
  if (Number.isNaN(expiresAtMs) || expiresAtMs - nowMs > SIGN_OUT_NOTICE_MS) return null;
  const expires = new Date(expiresAtMs);
  return expiresAtMs - nowMs < 24 * 60 * 60 * 1000
    ? `Signs out at ${signOutTimeFormatter.format(expires)}`
    : `Signs out ${signOutDayFormatter.format(expires)}`;
}

export function formatAccessTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return accessTimestampFormatter.format(parsed);
}

export function parseManualDesktopSshTarget(input: {
  readonly host: string;
  readonly username: string;
  readonly port: string;
}): DesktopSshEnvironmentTarget {
  const rawHost = input.host.trim();
  if (rawHost.length === 0) {
    throw new Error("SSH host or alias is required.");
  }

  let hostname = rawHost;
  let username = input.username.trim() || null;
  let port: number | null = null;

  const atIndex = hostname.lastIndexOf("@");
  if (atIndex > 0) {
    const inlineUsername = hostname.slice(0, atIndex).trim();
    hostname = hostname.slice(atIndex + 1).trim();
    if (!username && inlineUsername.length > 0) {
      username = inlineUsername;
    }
  }

  const bracketedHostMatch = /^\[([^\]]+)\](?::(\d+))?$/u.exec(hostname);
  if (bracketedHostMatch) {
    hostname = bracketedHostMatch[1]!.trim();
    if (bracketedHostMatch[2]) {
      port = Number.parseInt(bracketedHostMatch[2], 10);
    }
  } else {
    const colonSegments = hostname.split(":");
    if (colonSegments.length === 2 && /^\d+$/u.test(colonSegments[1] ?? "")) {
      hostname = colonSegments[0]!.trim();
      port = Number.parseInt(colonSegments[1]!, 10);
    }
  }

  const rawPort = input.port.trim();
  if (rawPort.length > 0) {
    port = Number.parseInt(rawPort, 10);
  }

  if (hostname.length === 0) {
    throw new Error("SSH host or alias is required.");
  }

  if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65_535)) {
    throw new Error("SSH port must be between 1 and 65535.");
  }

  return {
    alias: hostname,
    hostname,
    username,
    port,
  };
}

export function parsePairingUrlFields(
  input: string,
): { readonly host: string; readonly pairingCode: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const urlLikeInput =
      /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(trimmed) || trimmed.startsWith("//")
        ? trimmed
        : `https://${trimmed}`;
    const url = new URL(urlLikeInput, window.location.origin);
    const hostedPairingRequest = readHostedPairingRequest(url);
    if (hostedPairingRequest) {
      return {
        host: hostedPairingRequest.host,
        pairingCode: hostedPairingRequest.token,
      };
    }

    const pairingCode = getPairingTokenFromUrl(url);
    if (!pairingCode) return null;
    return {
      host: url.origin,
      pairingCode,
    };
  } catch {
    return null;
  }
}

export function parseRemotePairingFields(input: {
  readonly host: string;
  readonly pairingCode: string;
}): {
  readonly host: string;
  readonly pairingCode: string;
} {
  const parsedPairingUrl = parsePairingUrlFields(input.host);
  if (parsedPairingUrl) return parsedPairingUrl;

  const host = input.host.trim();
  const pairingCode = input.pairingCode.trim();
  if (!host) {
    throw new Error("Enter a backend host.");
  }
  if (!pairingCode) {
    throw new Error("Enter a pairing code.");
  }
  return { host, pairingCode };
}

export function formatDesktopSshConnectionError(error: unknown): string {
  const fallback = "Failed to connect SSH host.";
  const rawMessage = error instanceof Error ? error.message : fallback;
  const withoutIpcPrefix = rawMessage.replace(
    /^Error invoking remote method 'desktop:ensure-ssh-environment':\s*/u,
    "",
  );
  const withoutTaggedErrorPrefix = withoutIpcPrefix.replace(/^Ssh[A-Za-z]+Error:\s*/u, "");
  return withoutTaggedErrorPrefix.trim() || fallback;
}

export function sortDesktopPairingLinks(links: ReadonlyArray<ServerPairingLinkRecord>) {
  return [...links].toSorted(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

export function summarizeAuthorizedClients(
  sessions: ReadonlyArray<ServerClientSessionRecord>,
  links: ReadonlyArray<ServerPairingLinkRecord>,
): string {
  const parts = [
    `${sessions.length} ${sessions.length === 1 ? "device" : "devices"}`,
    links.length > 0 ? `${links.length} unused ${links.length === 1 ? "code" : "codes"}` : null,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}

export function sortDesktopClientSessions(sessions: ReadonlyArray<ServerClientSessionRecord>) {
  return [...sessions].toSorted((left, right) => {
    if (left.current !== right.current) {
      return left.current ? -1 : 1;
    }
    if (left.connected !== right.connected) {
      return left.connected ? -1 : 1;
    }
    return new Date(right.issuedAt).getTime() - new Date(left.issuedAt).getTime();
  });
}

export function toDesktopPairingLinkRecord(pairingLink: AuthPairingLink): ServerPairingLinkRecord {
  return {
    ...pairingLink,
    scopes: pairingLink.permissions ?? pairingLink.scopes,
    createdAt: DateTime.formatIso(pairingLink.createdAt),
    expiresAt: DateTime.formatIso(pairingLink.expiresAt),
  };
}

export function toDesktopClientSessionRecord(
  clientSession: AuthClientSession,
): ServerClientSessionRecord {
  return {
    ...clientSession,
    scopes: clientSession.permissions ?? clientSession.scopes,
    issuedAt: DateTime.formatIso(clientSession.issuedAt),
    expiresAt: DateTime.formatIso(clientSession.expiresAt),
    lastConnectedAt:
      clientSession.lastConnectedAt === null
        ? null
        : DateTime.formatIso(clientSession.lastConnectedAt),
  };
}

export function selectPairingEndpoint(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  defaultEndpointKey?: string | null,
): AdvertisedEndpoint | null {
  const availableEndpoints = endpoints.filter((endpoint) => endpoint.status !== "unavailable");
  if (defaultEndpointKey) {
    const selectedEndpoint = availableEndpoints.find(
      (endpoint) => endpointDefaultPreferenceKey(endpoint) === defaultEndpointKey,
    );
    if (selectedEndpoint) {
      return selectedEndpoint;
    }
  }
  return (
    availableEndpoints.find((endpoint) => endpoint.isDefault) ??
    availableEndpoints.find((endpoint) => endpoint.reachability !== "loopback") ??
    availableEndpoints.find((endpoint) => endpoint.compatibility.hostedHttpsApp === "compatible") ??
    null
  );
}

export function isTailscaleHttpsEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.id.startsWith("tailscale-magicdns:");
}

export function endpointDefaultPreferenceKey(endpoint: AdvertisedEndpoint): string {
  if (endpoint.id.startsWith("desktop-loopback:")) {
    return "desktop-core:loopback:http";
  }
  if (endpoint.id.startsWith("desktop-lan:")) {
    return "desktop-core:lan:http";
  }
  if (endpoint.id.startsWith("tailscale-ip:")) {
    return "tailscale:ip:http";
  }
  if (isTailscaleHttpsEndpoint(endpoint)) {
    return "tailscale:magicdns:https";
  }

  let scheme = "unknown";
  try {
    scheme = new URL(endpoint.httpBaseUrl).protocol.replace(/:$/u, "");
  } catch {}

  return `${endpoint.provider.id}:${endpoint.reachability}:${scheme}:${endpoint.label}`;
}

export function resolveAdvertisedEndpointPairingUrl(
  endpoint: AdvertisedEndpoint,
  credential: string,
): string {
  if (endpoint.compatibility.hostedHttpsApp === "compatible") {
    return (
      resolveHostedPairingUrl(endpoint.httpBaseUrl, credential) ??
      resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential)
    );
  }
  return resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential);
}

export function resolveCurrentOriginPairingUrl(credential: string): string {
  const url = new URL("/pair", window.location.href);
  return setPairingTokenOnUrl(url, credential).toString();
}

export function isHostedAppPairingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.pathname === "/pair" && url.searchParams.has("host");
  } catch {
    return false;
  }
}

export function endpointShareHint(endpoint: AdvertisedEndpoint, url: string): string {
  if (isHostedAppPairingUrl(url)) {
    return "Opens the hosted app, no install needed";
  }
  switch (endpoint.reachability) {
    case "lan":
      return "Devices on the same network";
    case "private-network":
      return "Devices on your private network";
    case "public":
      return "Reachable from anywhere";
    case "loopback":
      return "Clients on this machine";
  }
}

/** An explicit choice while it is listed, else the primary, else a connected environment. */
export function resolveAccessEnvironmentId(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly connected: boolean;
  }>;
  readonly selected: EnvironmentId | null;
}): EnvironmentId | null {
  const isListed = (environmentId: EnvironmentId | null) =>
    input.environments.some((environment) => environment.environmentId === environmentId);
  if (isListed(input.selected)) return input.selected;
  if (isListed(input.primaryEnvironmentId)) return input.primaryEnvironmentId;
  return (
    (input.environments.find((environment) => environment.connected) ?? input.environments[0])
      ?.environmentId ?? null
  );
}

/**
 * The pairing URL another device can open or scan, or null when this machine has no address
 * another device can reach. The URL carries the address, so the other side types nothing else.
 */
export function resolveShareablePairingUrl(input: {
  readonly credential: string;
  readonly endpointUrl: string | null | undefined;
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly defaultEndpointKey: string | null;
  readonly servedByEnvironment: boolean;
  readonly currentHostname: string;
}): string | null {
  const endpoint = selectPairingEndpoint(input.endpoints, input.defaultEndpointKey);
  if (endpoint) return resolveAdvertisedEndpointPairingUrl(endpoint, input.credential);
  if (input.endpointUrl != null && input.endpointUrl !== "") {
    return (
      resolveHostedPairingUrl(input.endpointUrl, input.credential) ??
      resolveDesktopPairingUrl(input.endpointUrl, input.credential)
    );
  }
  if (!input.servedByEnvironment || isLoopbackHostname(input.currentHostname)) return null;
  return resolveCurrentOriginPairingUrl(input.credential);
}

export interface PairingIntent {
  /** The machine shows up in the other device's sidebar. */
  readonly chats: boolean;
  /** Agents on the other device may run work on this machine. */
  readonly agents: boolean;
}

const PAIRING_INTENT_PARAMS = { chats: "chats", agents: "agents" } as const;

/** Records the Add a device switches in the link's fragment; both default on, so only "off" is written. */
export function withPairingIntent(pairingUrl: string, intent: PairingIntent): string {
  const url = new URL(pairingUrl);
  const hash = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  for (const key of Object.keys(PAIRING_INTENT_PARAMS) as Array<keyof PairingIntent>) {
    if (intent[key]) hash.delete(PAIRING_INTENT_PARAMS[key]);
    else hash.set(PAIRING_INTENT_PARAMS[key], "0");
  }
  url.hash = hash.toString();
  return url.toString();
}

/** The switches a pasted link asks for; a bare code, or a link without them, asks for both. */
export function readPairingIntent(value: string): PairingIntent {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { chats: true, agents: true };
  }
  const hash = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  return {
    chats: hash.get(PAIRING_INTENT_PARAMS.chats) !== "0",
    agents: hash.get(PAIRING_INTENT_PARAMS.agents) !== "0",
  };
}
