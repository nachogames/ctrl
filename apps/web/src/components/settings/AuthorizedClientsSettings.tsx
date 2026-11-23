import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m as resolveMessage } from "~/i18n/messages";
import { managedCapabilityDenial } from "@t3tools/client-runtime/contract-labels";
import { AUTH_SCOPE_OPTIONS as PAIRING_SCOPE_OPTIONS } from "@t3tools/shared/authScopeOptions";
import * as DateTime from "effect/DateTime";
import { EllipsisIcon, PlugIcon, PlusIcon, QrCodeIcon } from "lucide-react";
import { type ReactNode, memo, useId, useRef, useState } from "react";
import { msg, T, useGT, useMessages } from "gt-react";
import {
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  AuthFilesystemReadScope,
  AuthRelayConfigureScope,
  AuthStandardClientScopes,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type AuthEnvironmentScope,
  type AuthGrantScope,
  type AuthPairingCredentialResult,
  type AdvertisedEndpoint,
  type EnvironmentId,
  type PairedDeviceIdleLimit,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import {
  formatElapsedDurationLabel,
  formatExpiresInLabel,
  formatRelativeTimeLabel,
} from "../../timestampFormat";
import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";
import {
  canRevokeOtherClients,
  clientSignOutNotice,
  isQrShareableEndpoint,
  type PairingIntent,
  resolveShareablePairingUrl,
  selectQrEndpointOption,
  togglePairingScopeSelection,
  withPairingIntent,
} from "./ConnectionsSettings.logic";
import { useNowSecond } from "../../hooks/useNowSecond";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogFooter,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Switch } from "../ui/switch";
import { QRCodeSvg } from "../ui/qr-code";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
} from "~/environments/primary";
import { authEnvironment } from "~/state/auth";
import { readEnvironmentScope } from "~/state/session";
import { useManagedPolicy, usePrimaryManagedPolicy } from "~/state/managedPolicy";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { ManagedControl } from "../ManagedPolicy";
import { openUseInAnotherApp } from "../mcp/UseInAnotherAppDialog";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import {
  formatAccessTimestamp,
  selectPairingEndpoint,
  isTailscaleHttpsEndpoint,
  endpointDefaultPreferenceKey,
  resolveAdvertisedEndpointPairingUrl,
  resolveCurrentOriginPairingUrl,
  isHostedAppPairingUrl,
  endpointShareHint,
} from "./ConnectionsSettings.logic";

function AccessScopeSummary({
  scopes,
  label,
}: {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly label: string;
}) {
  const gt = useGT();
  const scopeCountLabel = gt("{count, plural, one {{count} scope} other {{count} scopes}}", {
    count: scopes.length,
  });

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={250}
        closeDelay={100}
        render={
          <button
            type="button"
            aria-label={gt("{label}: show {scopes}", { label, scopes: scopeCountLabel })}
            className="cursor-help underline decoration-border underline-offset-2 outline-hidden hover:text-foreground focus-visible:text-foreground"
          />
        }
      >
        {scopeCountLabel}
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        tooltipStyle
        className="w-max max-w-80 whitespace-normal"
      >
        <p className="mb-1 font-medium">
          <T>Granted scopes</T>
        </p>
        <div className="flex flex-col gap-0.5">
          {scopes.map((scope) => (
            <code key={scope} className="font-mono text-foreground/85">
              {scope}
            </code>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function endpointRowClassName(isAvailable: boolean) {
  return cn(
    "relative first:rounded-t-xl last:rounded-b-xl px-3 py-3 sm:px-4",
    !isAvailable && "bg-muted/15",
  );
}

type PairingLinkListRowProps = {
  pairingLink: ServerPairingLinkRecord;
  credential: string | undefined;
  defaultShareOpen: boolean;
  /** Whether this page is served by the environment the link pairs with. */
  servedByEnvironment: boolean;
  endpointUrl: string | null | undefined;
  endpoints: ReadonlyArray<AdvertisedEndpoint>;
  defaultEndpointKey: string | null;
  revokingPairingLinkId: string | null;
  onRevoke: (id: string) => void;
  canRevoke: boolean;
};

const PairingLinkListRow = memo(function PairingLinkListRow({
  pairingLink,
  credential,
  defaultShareOpen,
  servedByEnvironment,
  endpointUrl,
  endpoints,
  defaultEndpointKey,
  revokingPairingLinkId,
  onRevoke,
  canRevoke,
}: PairingLinkListRowProps) {
  const gt = useGT();
  const m = useMessages();
  const nowMs = useNowSecond();
  const expiresAtMs = new Date(pairingLink.expiresAt).getTime();
  const [isRevealDialogOpen, setIsRevealDialogOpen] = useState(false);
  const [isQrPanelOpen, setIsQrPanelOpen] = useState(defaultShareOpen);
  const [qrEndpointId, setQrEndpointId] = useState<string | null>(null);
  const qrPanelId = useId();

  const currentOriginPairingUrl = credential ? resolveCurrentOriginPairingUrl(credential) : null;
  const hostedPairingUrl =
    credential && endpointUrl != null && endpointUrl !== ""
      ? resolveHostedPairingUrl(endpointUrl, credential)
      : null;
  const endpointPairingUrl = (() => {
    const endpoint = selectPairingEndpoint(endpoints, defaultEndpointKey);
    return endpoint && credential
      ? resolveAdvertisedEndpointPairingUrl(endpoint, credential)
      : null;
  })();
  const endpointCopyOptions = (() => {
    const options: Array<{
      readonly id: string;
      readonly preferenceKey: string;
      readonly label: string;
      readonly url: string;
      readonly detail: string;
      readonly qrShareable: boolean;
    }> = [];
    if (!credential) return options;
    for (const endpoint of endpoints) {
      if (endpoint.status === "unavailable") {
        continue;
      }
      const url = resolveAdvertisedEndpointPairingUrl(endpoint, credential);
      options.push({
        id: endpoint.id,
        preferenceKey: endpointDefaultPreferenceKey(endpoint),
        label: endpoint.label,
        url,
        detail: endpointShareHint(endpoint, url, m),
        qrShareable: isQrShareableEndpoint(endpoint),
      });
    }
    return options;
  })();
  const shareablePairingUrl =
    endpointPairingUrl ??
    (credential && endpointUrl != null && endpointUrl !== ""
      ? (hostedPairingUrl ?? resolveDesktopPairingUrl(endpointUrl, credential))
      : servedByEnvironment
        ? currentOriginPairingUrl
        : null);
  const [failedCopyValue, setFailedCopyValue] = useState<string | null>(null);
  const revealValue = failedCopyValue ?? shareablePairingUrl ?? credential ?? "";
  const isRevealValueUrl = revealValue !== credential;
  const isRevealValueHostedAppPairingUrl = isRevealValueUrl && isHostedAppPairingUrl(revealValue);
  const isRevealValueQrShareable =
    endpointCopyOptions.find((option) => option.url === revealValue)?.qrShareable ?? true;
  const canCopyToClipboard =
    typeof window !== "undefined" &&
    window.isSecureContext &&
    navigator.clipboard?.writeText != null;

  const { copyToClipboard } = useCopyToClipboard<{
    value: string;
    kind: "code" | "hosted-link" | "link";
  }>({
    onError: (error, { value, kind }) => {
      // Captured per attempt so concurrent copies cannot make the dialog
      // reveal a different value than the one that failed.
      setFailedCopyValue(value);
      setIsRevealDialogOpen(true);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: canCopyToClipboard
            ? kind === "hosted-link"
              ? gt("Could not copy hosted app link")
              : kind === "link"
                ? gt("Could not copy pairing URL")
                : gt("Could not copy pairing code")
            : gt("Clipboard copy unavailable"),
          description: canCopyToClipboard ? error.message : gt("Showing the full value instead."),
        }),
      );
    },
  });

  const copyPairingValue = (value: string, kind: "code" | "hosted-link" | "link") => {
    copyToClipboard(value, { value, kind });
  };

  const copyKindForUrl = (url: string): "hosted-link" | "link" =>
    isHostedAppPairingUrl(url) ? "hosted-link" : "link";

  const handleCopyCode = () => {
    if (credential) copyPairingValue(credential, "code");
  };

  const expiresAbsolute = formatAccessTimestamp(pairingLink.expiresAt);

  const primaryLabel = pairingLink.label ?? gt("Pairing link");
  const selectedQrOption = selectQrEndpointOption(
    endpointCopyOptions,
    qrEndpointId,
    defaultEndpointKey,
  );
  const qrPairingUrl = selectedQrOption?.url ?? shareablePairingUrl;
  const canRenderQrForSelection = selectedQrOption?.qrShareable ?? true;
  if (expiresAtMs <= nowMs) {
    return null;
  }

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={gt("Link created at {time}", {
                time: formatAccessTimestamp(pairingLink.createdAt),
              })}
              dotClassName="bg-warning"
            />
            <h3 className="text-sm font-medium text-foreground">{primaryLabel}</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            <Tooltip>
              <TooltipTrigger render={<span />}>
                {formatExpiresInLabel(pairingLink.expiresAt, nowMs, m)}
              </TooltipTrigger>
              <TooltipPopup side="top">{expiresAbsolute}</TooltipPopup>
            </Tooltip>
            <span aria-hidden> · </span>
            <AccessScopeSummary scopes={pairingLink.scopes} label={gt("Pairing link scopes")} />
          </p>
          {!credential ? (
            <p className="text-2xs text-muted-foreground/70">
              <T>Create a new link to share from this client.</T>
            </p>
          ) : shareablePairingUrl === null ? (
            <p className="text-2xs text-muted-foreground/70">
              <T>
                Copy the token and pair from another client using this backend&apos;s reachable
                host.
              </T>
            </p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {shareablePairingUrl && canCopyToClipboard ? (
            <Button
              size="xs"
              variant="outline"
              aria-expanded={isQrPanelOpen}
              aria-controls={qrPanelId}
              onClick={() => setIsQrPanelOpen((open) => !open)}
            >
              <QrCodeIcon aria-hidden />
              <T>Share</T>
            </Button>
          ) : null}
          <Dialog
            open={credential !== undefined && isRevealDialogOpen}
            onOpenChange={(open) => {
              setIsRevealDialogOpen(open);
              if (!open) setFailedCopyValue(null);
            }}
          >
            {!credential ? null : canCopyToClipboard ? (
              shareablePairingUrl ? null : (
                <Button size="xs" variant="outline" onClick={handleCopyCode}>
                  <T>Copy code</T>
                </Button>
              )
            ) : (
              <DialogTrigger render={<Button size="xs" variant="outline" />}>
                {shareablePairingUrl ? gt("Show link") : gt("Show code")}
              </DialogTrigger>
            )}
            <DialogPopup className="max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {isRevealValueUrl
                    ? isRevealValueHostedAppPairingUrl
                      ? gt("Hosted app pairing link")
                      : gt("Pairing link")
                    : gt("Pairing code")}
                </DialogTitle>
                <DialogDescription>
                  {isRevealValueUrl
                    ? isRevealValueHostedAppPairingUrl
                      ? gt(
                          "Clipboard copy is unavailable here. Open or manually copy this hosted app link on the device you want to connect.",
                        )
                      : gt(
                          "Clipboard copy is unavailable here. Open or manually copy this full pairing URL on the device you want to connect.",
                        )
                    : gt(
                        "Clipboard copy is unavailable here. Manually copy this code into another client.",
                      )}
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <Textarea
                  readOnly
                  value={revealValue}
                  rows={isRevealValueUrl ? 4 : 3}
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.currentTarget.select()}
                />
                {isRevealValueUrl && isRevealValueQrShareable ? (
                  <div className="flex justify-center rounded-xl border border-border/60 bg-muted/30 p-4">
                    <QRCodeSvg
                      value={revealValue}
                      size={132}
                      level="M"
                      marginSize={2}
                      title={gt("Pairing link. Scan to open on another device")}
                    />
                  </div>
                ) : null}
              </DialogPanel>
              <DialogFooter variant="bare">
                <Button variant="outline" onClick={() => setIsRevealDialogOpen(false)}>
                  <T>Done</T>
                </Button>
                {canCopyToClipboard ? (
                  <Button variant="outline" onClick={handleCopyCode}>
                    <T>Copy code</T>
                  </Button>
                ) : null}
              </DialogFooter>
            </DialogPopup>
          </Dialog>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={!canRevoke || revokingPairingLinkId === pairingLink.id}
            onClick={() => void onRevoke(pairingLink.id)}
          >
            {revokingPairingLinkId === pairingLink.id ? gt("Revoking…") : gt("Revoke")}
          </Button>
        </div>
      </div>
      {isQrPanelOpen && qrPairingUrl !== null ? (
        <div
          id={qrPanelId}
          className="mt-3 flex flex-col gap-4 border-t border-border/50 pt-3 sm:flex-row sm:items-start sm:justify-between"
        >
          <div className="min-w-0 flex-1 space-y-3">
            {endpointCopyOptions.length > 1 ? (
              <div
                className="space-y-1.5"
                role="radiogroup"
                aria-label={gt("Endpoint the pairing QR code and URL use")}
              >
                <p className="text-2xs text-muted-foreground/70">
                  <T>Reach this machine via</T>
                </p>
                {endpointCopyOptions.map((option) => {
                  const isSelected = option.id === selectedQrOption?.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      className={cn(
                        "flex w-full items-baseline gap-2 rounded-lg border px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        isSelected
                          ? "border-foreground/60 bg-muted/30"
                          : "border-border/50 hover:bg-muted/20",
                      )}
                      onClick={() => setQrEndpointId(option.id)}
                    >
                      <span
                        className={cn(
                          "text-xs font-medium",
                          isSelected ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {option.label}
                      </span>
                      <span className="min-w-0 truncate text-2xs text-muted-foreground/70">
                        {option.detail}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <code className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
                      {qrPairingUrl}
                    </code>
                  }
                />
                <TooltipPopup side="top">{qrPairingUrl}</TooltipPopup>
              </Tooltip>
              <Button
                size="xs"
                variant="ghost"
                className="shrink-0"
                onClick={() => copyPairingValue(qrPairingUrl, copyKindForUrl(qrPairingUrl))}
              >
                <T>Copy link</T>
              </Button>
            </div>
            <Button size="xs" variant="ghost" onClick={handleCopyCode}>
              <T>Copy code only</T>
            </Button>
          </div>
          {canRenderQrForSelection ? (
            <div className="w-fit shrink-0 self-center rounded-xl bg-white p-3 sm:self-start">
              <QRCodeSvg
                value={qrPairingUrl}
                size={168}
                level="M"
                marginSize={1}
                title={gt("Pairing link. Scan to open on another device")}
              />
            </div>
          ) : (
            <div className="flex size-[192px] shrink-0 items-center justify-center self-center rounded-xl border border-border/50 p-4 sm:self-start">
              <p className="text-center text-2xs text-muted-foreground/70">
                <T>
                  No QR for this endpoint. Another device scanning a loopback link would dial
                  itself; copy the URL for use on this machine instead.
                </T>
              </p>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
});

type ConnectedClientListRowProps = {
  clientSession: ServerClientSessionRecord;
  revokingClientSessionId: string | null;
  onRevokeSession: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
  canRevoke: boolean;
};

const ConnectedClientListRow = memo(function ConnectedClientListRow({
  clientSession,
  revokingClientSessionId,
  onRevokeSession,
  canRevoke,
}: ConnectedClientListRowProps) {
  const gt = useGT();
  const m = useMessages();
  const nowMs = useNowSecond();
  const isLive = clientSession.current || clientSession.connected;
  const lastConnectedAt = clientSession.lastConnectedAt;
  const statusTooltip = isLive
    ? lastConnectedAt
      ? gt("Connected for {duration}", {
          duration: formatElapsedDurationLabel(lastConnectedAt, nowMs, m),
        })
      : gt("Connected")
    : lastConnectedAt
      ? gt("Last connected at {time}", { time: formatAccessTimestamp(lastConnectedAt) })
      : gt("Not connected yet.");
  const deviceInfoBits = [
    clientSession.client.deviceType !== "unknown"
      ? clientSession.client.deviceType[0]?.toUpperCase() + clientSession.client.deviceType.slice(1)
      : null,
    clientSession.client.os ?? null,
    clientSession.client.browser ?? null,
    clientSession.client.ipAddress ?? null,
  ].filter((value): value is string => value !== null);
  const primaryLabel =
    clientSession.client.label ??
    ([clientSession.client.os, clientSession.client.browser].filter(Boolean).join(" · ") ||
      clientSession.subject);
  const usage = isLive
    ? gt("Connected now")
    : lastConnectedAt
      ? gt("Used {time}", { time: formatRelativeTimeLabel(lastConnectedAt, nowMs, m) })
      : gt("Not used yet");
  const signOutNotice = clientSignOutNotice(clientSession, nowMs, m);

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={statusTooltip}
              dotClassName={isLive ? "bg-success" : "bg-muted-foreground/30"}
              pingClassName={isLive ? "bg-success/60 duration-2000" : null}
            />
            <h3 className="text-sm font-medium text-foreground">{primaryLabel}</h3>
            {clientSession.current ? (
              <span className="text-3xs text-muted-foreground/80 rounded-md border border-border/50 bg-muted/50 px-1 py-0.5">
                <T>This device</T>
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {clientSession.current ? null : (
              <>
                {usage}
                <span aria-hidden> · </span>
              </>
            )}
            {deviceInfoBits.length > 0 ? (
              <>
                {deviceInfoBits.join(" · ")}
                <span aria-hidden> · </span>
              </>
            ) : null}
            <AccessScopeSummary scopes={clientSession.scopes} label={gt("Client scopes")} />
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {signOutNotice ? (
            <span className="text-xs text-warning-foreground">{signOutNotice}</span>
          ) : clientSession.current ? null : (
            <span className="text-xs text-success">
              <T>Signed in</T>
            </span>
          )}
          {!clientSession.current ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canRevoke || revokingClientSessionId === clientSession.sessionId}
              onClick={() => void onRevokeSession(clientSession.sessionId)}
            >
              {revokingClientSessionId === clientSession.sessionId
                ? gt("Signing out…")
                : gt("Sign out")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

const IDLE_LIMIT_LABELS: Record<PairedDeviceIdleLimit, string> = {
  days_30: msg("30 days"),
  days_90: msg("90 days"),
};

/** How long a paired device may go unused on this environment before it is signed out. */
export function PairedDeviceIdleLimitRow({
  environmentId,
  canWrite,
}: {
  readonly environmentId: EnvironmentId;
  readonly canWrite: boolean;
}) {
  const idleLimit = useEnvironmentSettings(
    environmentId,
    (settings) => settings.pairedDeviceIdleLimit,
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const gt = useGT();
  const m = useMessages();
  return (
    <div className={cn(ITEM_ROW_CLASSNAME, "border-t border-border/50")}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-sm font-medium text-foreground">
            <T>Sign a device out when unused for</T>
          </h3>
          <p className="text-xs text-muted-foreground">
            <T>Every connection resets the clock.</T>
          </p>
        </div>
        <ToggleGroup
          aria-label={gt("Sign a device out when unused for")}
          value={[idleLimit]}
          disabled={!canWrite}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "days_30" || value === "days_90") {
              updateSettings({ pairedDeviceIdleLimit: value });
            }
          }}
        >
          {(Object.keys(IDLE_LIMIT_LABELS) as PairedDeviceIdleLimit[]).map((limit) => (
            <Toggle key={limit} value={limit}>
              {m(IDLE_LIMIT_LABELS[limit])}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
    </div>
  );
}

type AuthorizedClientsHeaderActionProps = {
  environmentId: EnvironmentId;
  onPairingLinkCreated: (result: AuthPairingCredentialResult) => void;
  clientSessions: ReadonlyArray<ServerClientSessionRecord> | null;
  isRevokingOtherClients: boolean;
  onRevokeOtherClients: () => void;
  delegatableScopes: ReadonlyArray<AuthEnvironmentScope>;
  share: PairingShareTarget;
};

/** Where this machine can be reached, so a code carries the address the other device needs. */
export interface PairingShareTarget {
  readonly servedByEnvironment: boolean;
  readonly endpointUrl: string | null | undefined;
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly defaultEndpointKey: string | null;
}

export const AuthorizedClientsHeaderAction = memo(function AuthorizedClientsHeaderAction({
  environmentId,
  onPairingLinkCreated,
  clientSessions,
  isRevokingOtherClients,
  onRevokeOtherClients,
  delegatableScopes,
  share,
}: AuthorizedClientsHeaderActionProps) {
  const gt = useGT();
  const m = useMessages();
  const pairingDenial = managedCapabilityDenial(
    useManagedPolicy(environmentId),
    "remoteClients",
    m,
  );
  return (
    <div className="flex items-center gap-2">
      <Button size="xs" variant="outline" onClick={() => openUseInAnotherApp(environmentId)}>
        <PlugIcon className="size-3" />
        <T>Use in another app (MCP)</T>
      </Button>
      <Menu>
        <MenuTrigger
          render={
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              aria-label={gt("More actions for who can use this machine")}
            />
          }
        >
          <EllipsisIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem
            variant="destructive"
            disabled={isRevokingOtherClients || !canRevokeOtherClients(clientSessions)}
            onClick={() => void onRevokeOtherClients()}
          >
            {isRevokingOtherClients ? gt("Signing out…") : gt("Sign out all other devices")}
          </MenuItem>
        </MenuPopup>
      </Menu>
      {pairingDenial !== undefined ? (
        <ManagedControl reason={pairingDenial}>
          <Button size="xs" variant="default" disabled>
            <PlusIcon className="size-3" />
            <T>Add a device</T>
          </Button>
        </ManagedControl>
      ) : (
        <AddDeviceDialog
          environmentId={environmentId}
          delegatableScopes={delegatableScopes}
          onPairingLinkCreated={onPairingLinkCreated}
          share={share}
        />
      )}
    </div>
  );
});

const READ_ONLY_SCOPES: ReadonlyArray<AuthGrantScope> = [
  AuthOrchestrationReadScope,
  AuthFilesystemReadScope,
  AuthDiagnosticsReadScope,
  AuthTerminalReadScope,
];

/**
 * Makes a one-time code as soon as it opens. Its link carries this machine's reachable address
 * and the two choices below, so the other device enters nothing else.
 */
function AddDeviceDialog({
  environmentId,
  delegatableScopes,
  onPairingLinkCreated,
  share,
}: {
  readonly environmentId: EnvironmentId;
  readonly delegatableScopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly onPairingLinkCreated: (result: AuthPairingCredentialResult) => void;
  readonly share: PairingShareTarget;
}) {
  const gt = useGT();
  const m = useMessages();
  const createPairingCredential = useAtomCommand(authEnvironment.createPairingCredential, {
    reportFailure: false,
  });
  const standardScopes = AuthStandardClientScopes.filter((scope) =>
    delegatableScopes.includes(scope),
  );
  const [open, setOpen] = useState(false);
  const [issued, setIssued] = useState<AuthPairingCredentialResult | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intent, setIntent] = useState<PairingIntent>({ chats: true, agents: true });
  const [moreOpen, setMoreOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<ReadonlyArray<AuthGrantScope>>(standardScopes);
  const selectedScopes = scopes.filter((scope) => delegatableScopes.includes(scope));
  const terminalSelected = selectedScopes.includes(AuthTerminalOperateScope);
  const relayAdminSelected = selectedScopes.includes(AuthRelayConfigureScope);
  const nowMs = useNowSecond();
  // A code that arrives after the dialog closed belongs to that earlier opening.
  const dialogSessionRef = useRef(0);

  const makeCode = async (input: {
    readonly label: string;
    readonly scopes: ReadonlyArray<AuthGrantScope>;
  }) => {
    if (
      input.scopes.length === 0 ||
      !readEnvironmentScope(environmentId, AuthAccessWriteScope) ||
      !input.scopes.every((scope) => readEnvironmentScope(environmentId, scope))
    ) {
      setError(gt("This connection cannot add devices here."));
      return;
    }
    const dialogSession = dialogSessionRef.current;
    setCreating(true);
    setError(null);
    const trimmed = input.label.trim();
    const result = await createPairingCredential({
      environmentId,
      input: { ...(trimmed ? { label: trimmed } : {}), scopes: input.scopes },
    });
    if (dialogSession !== dialogSessionRef.current) {
      if (result._tag === "Success") onPairingLinkCreated(result.value);
      return;
    }
    setCreating(false);
    if (result._tag === "Success") {
      setIssued(result.value);
      onPairingLinkCreated(result.value);
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error
          ? (thrownErrorMessage(failure, resolveMessage) ?? failure.message)
          : gt("Could not make a code."),
      );
    }
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      void makeCode({ label: "", scopes: standardScopes });
    } else {
      dialogSessionRef.current += 1;
      setCreating(false);
      setIssued(null);
      setError(null);
      setIntent({ chats: true, agents: true });
      setMoreOpen(false);
      setLabel("");
      setScopes(standardScopes);
    }
  };

  const baseUrl =
    issued === null
      ? null
      : resolveShareablePairingUrl({
          credential: issued.credential,
          ...share,
          currentHostname: window.location.hostname,
        });
  const pairingUrl = baseUrl === null ? null : withPairingIntent(baseUrl, intent);
  const { copyToClipboard } = useCopyToClipboard<{ kind: "code" | "link" }>({
    onCopy: ({ kind }) =>
      toastManager.add({
        type: "success",
        title: kind === "link" ? gt("Link copied") : gt("Code copied"),
        description:
          kind === "link"
            ? gt("Paste it into Add a machine on the other device.")
            : gt("On the other device, enter it in Add a machine and pick this machine."),
      }),
    onError: (copyError) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not copy"),
          description: copyError.message,
        }),
      ),
  });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button size="xs" variant="default">
            <PlusIcon className="size-3" />
            <T>Add a device</T>
          </Button>
        }
      />
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <T>Add a device</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              On the other device, open Settings &gt; Connections &gt; Add a machine and paste the
              link, or scan it with a phone.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4 rounded-xl bg-muted/30 p-4 sm:flex-row sm:items-center">
            {pairingUrl ? (
              <div className="flex shrink-0 justify-center rounded-lg bg-white p-2">
                <QRCodeSvg
                  value={pairingUrl}
                  size={132}
                  level="M"
                  marginSize={1}
                  title={gt("Pairing link. Scan to add this machine on another device")}
                />
              </div>
            ) : null}
            <div className="min-w-0 flex-1 space-y-2">
              <p className="font-mono text-2xl font-medium tracking-widest text-foreground">
                {issued?.credential ?? (creating ? "…" : "")}
              </p>
              <p className="text-xs text-muted-foreground">
                {issued
                  ? gt("Works once. {expires}.", {
                      expires: formatExpiresInLabel(DateTime.formatIso(issued.expiresAt), nowMs, m),
                    })
                  : creating
                    ? gt("Making a code…")
                    : null}{" "}
                {pairingUrl
                  ? gt(
                      "The link includes this machine's address, so there is nothing else to type.",
                    )
                  : issued
                    ? gt(
                        "This machine has no address other devices can reach. Turn on Tailscale or Local network first.",
                      )
                    : null}
              </p>
              {error ? <p className="text-xs text-destructive">{error}</p> : null}
              <div className="flex flex-wrap gap-2">
                {pairingUrl ? (
                  <Button size="sm" onClick={() => copyToClipboard(pairingUrl, { kind: "link" })}>
                    <T>Copy link</T>
                  </Button>
                ) : null}
                {issued ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => copyToClipboard(issued.credential, { kind: "code" })}
                  >
                    <T>Copy code</T>
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
          <div className="divide-y divide-border/60 rounded-lg border border-border/60">
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-foreground">
                  <T>Use chats and projects there</T>
                </span>
                <span className="block text-xs text-muted-foreground">
                  <T>This machine shows up in the other device's sidebar.</T>
                </span>
              </span>
              <Switch
                checked={intent.chats}
                onCheckedChange={(chats) => setIntent((current) => ({ ...current, chats }))}
                aria-label={gt("Use chats and projects there")}
              />
            </label>
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-foreground">
                  <T>Let its agents run work here</T>
                </span>
                <span className="block text-xs text-muted-foreground">
                  <T>
                    Agents on the other device can start chats on this machine. Each task asks for
                    approval here.
                  </T>
                </span>
              </span>
              <Switch
                checked={intent.agents}
                onCheckedChange={(agents) => setIntent((current) => ({ ...current, agents }))}
                aria-label={gt("Let its agents run work here")}
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            <T>It stays signed in while it's used.</T>{" "}
            <button
              type="button"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((value) => !value)}
              className="underline underline-offset-2 hover:text-foreground"
            >
              <T>More options</T>
            </button>
          </p>
          {moreOpen ? (
            <section className="space-y-3">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-foreground">
                  <T>Name (optional)</T>
                </span>
                <Input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder={gt("e.g. Living room iPad")}
                  disabled={creating}
                />
              </label>
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xs font-medium text-foreground">
                  <T>Permissions</T>
                </h3>
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={creating}
                    onClick={() =>
                      setScopes(
                        READ_ONLY_SCOPES.filter((scope) => delegatableScopes.includes(scope)),
                      )
                    }
                  >
                    <T>Read only</T>
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={creating}
                    onClick={() => setScopes(standardScopes)}
                  >
                    {gt("Standard", { $context: "standard permission preset" })}
                  </Button>
                </div>
              </div>
              <div className="divide-y divide-border/60 rounded-lg border border-input bg-muted/25">
                {PAIRING_SCOPE_OPTIONS.filter(({ scope }) => delegatableScopes.includes(scope)).map(
                  ({ scope, title, description }) => (
                    <label
                      key={scope}
                      className="flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40"
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={scopes.includes(scope)}
                        disabled={creating}
                        onCheckedChange={(checked) =>
                          setScopes((current) =>
                            togglePairingScopeSelection(current, scope, checked === true),
                          )
                        }
                      />
                      <span className="min-w-0">
                        <span className="block text-xs font-medium text-foreground">
                          {m(title)}
                        </span>
                        <span className="block text-xs leading-snug text-muted-foreground">
                          {m(description)}
                        </span>
                        {terminalSelected && scope === AuthTerminalOperateScope ? (
                          <span className="block text-xs text-warning">
                            {gt(
                              "Terminal commands can read or change files within the server account’s permissions.",
                            )}
                          </span>
                        ) : null}
                        {relayAdminSelected && scope === AuthRelayConfigureScope ? (
                          <span className="block text-xs text-warning">
                            {gt("This client can change who can issue pairing credentials.")}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  ),
                )}
              </div>
              {selectedScopes.length === 0 ? (
                <p className="text-xs text-destructive">
                  <T>Select at least one permission.</T>
                </p>
              ) : selectedScopes.includes(AuthAccessWriteScope) ? (
                <p className="text-xs text-warning">
                  <T>This client can create or revoke access for other devices.</T>
                </p>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={creating || selectedScopes.length === 0}
                onClick={() => void makeCode({ label, scopes: selectedScopes })}
              >
                <T>Make a new code with these options</T>
              </Button>
            </section>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            <T>Done</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

type PairingClientsListProps = {
  servedByEnvironment: boolean;
  endpointUrl: string | null | undefined;
  endpoints: ReadonlyArray<AdvertisedEndpoint>;
  defaultEndpointKey: string | null;
  isLoading: boolean;
  pairingLinks: ReadonlyArray<ServerPairingLinkRecord>;
  createdPairingCredentials: ReadonlyMap<string, string>;
  sharedPairingLinkId: string | null;
  clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  revokingPairingLinkId: string | null;
  revokingClientSessionId: string | null;
  onRevokePairingLink: (id: string) => void;
  onRevokeClientSession: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
  canRevoke: boolean;
};

export const PairingClientsList = memo(function PairingClientsList({
  servedByEnvironment,
  endpointUrl,
  endpoints,
  defaultEndpointKey,
  isLoading,
  pairingLinks,
  createdPairingCredentials,
  sharedPairingLinkId,
  clientSessions,
  revokingPairingLinkId,
  revokingClientSessionId,
  onRevokePairingLink,
  onRevokeClientSession,
  canRevoke,
}: PairingClientsListProps) {
  return (
    <>
      {pairingLinks.map((pairingLink) => (
        <PairingLinkListRow
          key={pairingLink.id}
          pairingLink={pairingLink}
          credential={createdPairingCredentials.get(pairingLink.id)}
          defaultShareOpen={pairingLink.id === sharedPairingLinkId}
          servedByEnvironment={servedByEnvironment}
          endpointUrl={endpointUrl}
          endpoints={endpoints}
          defaultEndpointKey={defaultEndpointKey}
          revokingPairingLinkId={revokingPairingLinkId}
          onRevoke={onRevokePairingLink}
          canRevoke={canRevoke}
        />
      ))}

      {clientSessions.map((clientSession) => (
        <ConnectedClientListRow
          key={clientSession.sessionId}
          clientSession={clientSession}
          revokingClientSessionId={revokingClientSessionId}
          onRevokeSession={onRevokeClientSession}
          canRevoke={canRevoke}
        />
      ))}

      {pairingLinks.length === 0 && clientSessions.length === 0 && !isLoading ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-xs text-muted-foreground/60">
            <T>No pairing links or client sessions.</T>
          </p>
        </div>
      ) : null}
    </>
  );
});

type AdvertisedEndpointListRowProps = {
  endpoint: AdvertisedEndpoint;
  isDefault: boolean;
  onSetDefault: (endpoint: AdvertisedEndpoint) => void;
  onSetupTailscaleServe: (endpoint: AdvertisedEndpoint) => void;
  onDisableTailscaleServe: (endpoint: AdvertisedEndpoint) => void;
  isUpdatingTailscaleServe: boolean;
};

export const AdvertisedEndpointListRow = memo(function AdvertisedEndpointListRow({
  endpoint,
  isDefault,
  onSetDefault,
  onSetupTailscaleServe,
  onDisableTailscaleServe,
  isUpdatingTailscaleServe,
}: AdvertisedEndpointListRowProps) {
  const gt = useGT();
  const isAvailable = endpoint.status === "available";
  const needsTailscaleSetup = isTailscaleHttpsEndpoint(endpoint) && endpoint.status !== "available";
  const canDisableTailscaleServe =
    isTailscaleHttpsEndpoint(endpoint) && endpoint.status === "available";
  const shouldShowEndpointUrl = !needsTailscaleSetup;
  const m = useMessages();
  const remoteDenial = managedCapabilityDenial(usePrimaryManagedPolicy(), "remoteClients", m);
  return (
    <div className={endpointRowClassName(isAvailable)}>
      {isDefault ? (
        <span className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-primary" aria-hidden />
      ) : null}
      <div className="flex min-h-7 min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-h-7 min-w-0 flex-1 items-center gap-3">
          <h3 className="shrink-0 text-sm leading-5 font-medium text-foreground">
            {endpoint.label}
          </h3>
          {shouldShowEndpointUrl ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <p className="min-w-0 truncate text-xs leading-5 text-muted-foreground">
                    {endpoint.httpBaseUrl}
                  </p>
                }
              />
              <TooltipPopup side="top">{endpoint.httpBaseUrl}</TooltipPopup>
            </Tooltip>
          ) : null}
          {!isAvailable ? (
            <span className="inline-flex h-6 shrink-0 items-center rounded-md border border-border/70 px-1.5 text-3xs text-muted-foreground">
              <T>Setup required</T>
            </span>
          ) : null}
        </div>
        <div className="ml-auto flex min-h-7 shrink-0 items-center justify-end gap-2">
          {isDefault ? (
            <span className="inline-flex h-6 items-center rounded-md border border-primary/30 bg-primary/10 px-1.5 text-3xs text-primary">
              {gt("Default", { $context: "default endpoint badge" })}
            </span>
          ) : null}
          {needsTailscaleSetup ? (
            <ManagedControl reason={remoteDenial}>
              <Button
                size="xs"
                variant="outline"
                onClick={() => onSetupTailscaleServe(endpoint)}
                disabled={isUpdatingTailscaleServe || remoteDenial !== undefined}
              >
                {isUpdatingTailscaleServe ? gt("Restarting…") : gt("Setup", { $context: "verb" })}
              </Button>
            </ManagedControl>
          ) : null}
          {canDisableTailscaleServe ? (
            <Button
              size="xs"
              variant="destructive-outline"
              onClick={() => onDisableTailscaleServe(endpoint)}
              disabled={isUpdatingTailscaleServe}
            >
              {isUpdatingTailscaleServe ? gt("Restarting…") : gt("Disable")}
            </Button>
          ) : null}
          {!needsTailscaleSetup && !isDefault ? (
            <Button size="xs" variant="outline" onClick={() => onSetDefault(endpoint)}>
              <T>Set as default</T>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

export function NetworkAccessDescription({
  endpoint,
  hiddenEndpointCount,
  expanded,
  onToggleExpanded,
  fallback,
}: {
  endpoint: AdvertisedEndpoint | null;
  hiddenEndpointCount: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  fallback: ReactNode;
}) {
  const gt = useGT();
  if (!endpoint) {
    return fallback;
  }

  const summary = (
    <>
      <span className="min-w-0 truncate">{endpoint.httpBaseUrl}</span>
      {hiddenEndpointCount > 0 ? (
        <span className="shrink-0 text-xs font-medium">
          {expanded ? gt("Hide") : `+${hiddenEndpointCount}`}
        </span>
      ) : null}
    </>
  );

  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-1">
      <span className="shrink-0">
        <T>Reachable at</T>
      </span>
      {hiddenEndpointCount > 0 ? (
        <button
          type="button"
          className="inline-flex min-w-0 max-w-full items-baseline gap-2 border-b border-dotted border-muted-foreground/60 text-left text-muted-foreground underline-offset-4 hover:border-foreground hover:text-foreground"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
        >
          {summary}
        </button>
      ) : (
        <span className="inline-flex min-w-0 max-w-full items-baseline gap-2">{summary}</span>
      )}
    </span>
  );
}

/**
 * Pairs each connected machine with its own sign-in on this machine, by name: a machine that
 * pairs both ways signs in here under the name this app shows it by. Phones, browsers and other
 * unmatched sessions stay in the device list.
 */
export function matchMachineSessions<
  Session extends { readonly current: boolean; readonly client: { readonly label?: string } },
>(
  machines: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>,
  sessions: ReadonlyArray<Session>,
): ReadonlyMap<EnvironmentId, Session> {
  const byName = new Map<string, Session>();
  for (const signIn of sessions) {
    const name = signIn.client.label?.trim().toLowerCase();
    // The newest session per name comes first in the sorted list; keep it.
    if (!signIn.current && name && !byName.has(name)) byName.set(name, signIn);
  }
  const matched = new Map<EnvironmentId, Session>();
  for (const machine of machines) {
    const session = byName.get(machine.label.trim().toLowerCase());
    if (session) matched.set(machine.environmentId, session);
  }
  return matched;
}
