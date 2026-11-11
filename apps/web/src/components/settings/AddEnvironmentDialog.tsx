import { pipe } from "effect/Function";
import { ChevronsLeftRightEllipsisIcon, PlusIcon, TerminalIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import {
  type DesktopDiscoveredSshHost,
  type DesktopSshEnvironmentTarget,
  type EnvironmentId,
  type TailnetPeerEnvironment,
} from "@t3tools/contracts";
import {
  RelayConnectionRegistration,
  RelayConnectionTarget,
  tailnetSignInBaseUrl,
} from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";

import { cn } from "../../lib/utils";
import { formatDesktopSshTarget } from "./EnvironmentRow";
import { Input } from "../ui/input";
import { CommandShortcut } from "../ui/command";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../ui/autocomplete";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { AnimatedHeight } from "../AnimatedHeight";
import { environmentCatalog } from "~/connection/catalog";
import {
  connectPairing as connectPairingAtom,
  connectSshEnvironment as connectSshEnvironmentAtom,
  connectTailnet as connectTailnetAtom,
} from "~/connection/onboarding";
import { useEnvironmentQuery } from "~/state/query";
import { desktopSshHostsStateAtom, filterDiscoveredSshHosts } from "~/state/desktopSshHosts";
import { type EnvironmentPresentation, useRelayEnvironmentDiscovery } from "~/state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { primaryServerKeybindingsAtom } from "~/state/server";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
} from "../../keybindings";
import {
  parseManualDesktopSshTarget,
  parsePairingUrlFields,
  parseRemotePairingFields,
  formatDesktopSshConnectionError,
  readPairingIntent,
} from "./ConnectionsSettings.logic";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import { offersLinkedEnvironmentsAtom, peerLinkEnvironment } from "~/state/peerLinks";
import { usePrimaryEnvironment } from "~/state/environments";
import { Switch } from "../ui/switch";
import { useLinkAgentsTo } from "./useLinkAgentsTo";
import { useOfferConnectionBack } from "./useOfferConnectionBack";

const EMPTY_DISCOVERED_SSH_HOSTS: ReadonlyArray<DesktopDiscoveredSshHost> = [];
const noLinkPermissionAtom = Atom.make(false).pipe(
  Atom.withLabel("add-machine:link-permission:none"),
);

export function AddEnvironmentDialog({
  open,
  routeTarget,
  error,
  savedEnvironments,
  onOpenChange,
  onErrorChange,
}: {
  readonly open: boolean;
  readonly routeTarget: EnvironmentPresentation | null;
  readonly error: string | null;
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onErrorChange: (error: string | null) => void;
}) {
  const desktopBridge = window.desktopBridge;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const connectTailnet = useAtomCommand(connectTailnetAtom, { reportFailure: false });
  const connectSshEnvironment = useAtomCommand(connectSshEnvironmentAtom, {
    reportFailure: false,
  });
  const registerEnvironment = useAtomCommand(environmentCatalog.register, {
    reportFailure: false,
  });
  const setEnvironmentEnabled = useAtomCommand(environmentCatalog.setEnabled, {
    reportFailure: false,
  });
  const primaryEnvironment = usePrimaryEnvironment();
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const mayLinkAgents = useAtomValue(
    primaryEnvironmentId === null
      ? noLinkPermissionAtom
      : peerLinkEnvironment.link.permissionAtom(primaryEnvironmentId),
  );
  const offersLinks = useAtomValue(
    primaryEnvironmentId === null
      ? noLinkPermissionAtom
      : offersLinkedEnvironmentsAtom(primaryEnvironmentId),
  );
  // Linked environments is a Labs beta; with it off the server refuses links.
  const canLinkAgents = mayLinkAgents && offersLinks;
  const linkAgentsTo = useLinkAgentsTo();
  const offerConnectionBack = useOfferConnectionBack();
  const [bothWaysChosen, setBothWays] = useState(true);
  // The switch only shows when this app has a machine of its own to connect back to.
  const bothWays = bothWaysChosen && primaryEnvironmentId !== null;
  const relayDiscoveryState = useRelayEnvironmentDiscovery();
  const savedDesktopSshEnvironmentKeys = (() => {
    const keys = new Set<string>();
    for (const environment of savedEnvironments) {
      const profile = environment.entry.profile;
      if (
        environment.entry.target._tag !== "SshConnectionTarget" ||
        Option.isNone(profile) ||
        profile.value._tag !== "SshConnectionProfile"
      ) {
        continue;
      }
      const target = profile.value.target;
      keys.add(target.alias);
      keys.add(formatDesktopSshTarget(target));
    }
    return keys;
  })();
  const [savedBackendMode, setSavedBackendMode] = useState<"remote" | "ssh">("remote");
  const [savedBackendHost, setSavedBackendHost] = useState("");
  const [savedBackendPairingCode, setSavedBackendPairingCode] = useState("");
  // Null follows the pasted link; a toggle overrides it.
  const [tailnetMachines, setTailnetMachines] = useState<ReadonlyArray<TailnetPeerEnvironment>>([]);
  const savedEnvironmentIds = new Set(savedEnvironments.map((saved) => saved.environmentId));
  const unsavedTailnetMachines = tailnetMachines.filter(
    (machine) => !savedEnvironmentIds.has(machine.environmentId),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks Tailscale, through the desktop bridge, which T3 machines are on this tailnet each time the dialog opens
  useEffect(() => {
    if (!open || desktopBridge === undefined || routeTarget !== null) return;
    let cancelled = false;
    void desktopBridge
      .discoverTailnetEnvironments()
      .catch(() => [])
      .then((found) => {
        if (!cancelled) setTailnetMachines(found);
      });
    return () => {
      cancelled = true;
    };
  }, [open, desktopBridge, routeTarget]);
  const [chatsChoice, setChatsChoice] = useState<boolean | null>(null);
  const [agentsChoice, setAgentsChoice] = useState<boolean | null>(null);
  const pastedLink = parsePairingUrlFields(savedBackendPairingCode);
  const linkIntent = readPairingIntent(savedBackendPairingCode);
  const showChats = chatsChoice ?? linkIntent.chats;
  const letAgentsRun = canLinkAgents && (agentsChoice ?? linkIntent.agents);
  const [savedBackendSshHost, setSavedBackendSshHost] = useState("");
  const [savedBackendSshUsername, setSavedBackendSshUsername] = useState("");
  const [savedBackendSshPort, setSavedBackendSshPort] = useState("");
  const [sshHostSuggestionsOpen, setSshHostSuggestionsOpen] = useState(false);
  const highlightedSshHostRef = useRef<DesktopDiscoveredSshHost | undefined>(undefined);
  const [isAddingSavedBackend, setIsAddingSavedBackend] = useState(false);
  const savedBackendSessionRef = useRef(0);
  const isSshDiscoveryActive = desktopBridge !== undefined && open && savedBackendMode === "ssh";
  const desktopSshHosts = useEnvironmentQuery(
    isSshDiscoveryActive ? desktopSshHostsStateAtom : null,
  );
  // The discovery atom is kept alive across dialog opens, so re-read SSH config
  // each time the SSH tab is shown; stale hosts stay visible while it refreshes.
  const refreshDesktopSshHosts = desktopSshHosts.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- rereads desktop SSH config through the bridge each time the SSH tab is shown
  useEffect(() => {
    if (isSshDiscoveryActive) refreshDesktopSshHosts();
  }, [isSshDiscoveryActive, refreshDesktopSshHosts]);
  const discoveredSshHosts = desktopSshHosts.data ?? EMPTY_DISCOVERED_SSH_HOSTS;
  const unsavedDiscoveredSshHosts = discoveredSshHosts.filter((target) => {
    const address = formatDesktopSshTarget(target);
    return (
      !savedDesktopSshEnvironmentKeys.has(target.alias) &&
      (target.source === "ssh-config" || !savedDesktopSshEnvironmentKeys.has(address))
    );
  });
  const filteredDiscoveredSshHosts = filterDiscoveredSshHosts(
    unsavedDiscoveredSshHosts,
    savedBackendSshHost,
  );
  const isLoadingDiscoveredSshHosts = desktopSshHosts.isPending && desktopSshHosts.data === null;
  const discoveredSshHostsError = desktopSshHosts.error;
  const hasSshHostSuggestionContent =
    desktopBridge !== undefined &&
    (isLoadingDiscoveredSshHosts || unsavedDiscoveredSshHosts.length > 0);
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      savedBackendSessionRef.current += 1;
      setSavedBackendMode("remote");
      setSavedBackendHost("");
      setSavedBackendPairingCode("");
      setChatsChoice(null);
      setAgentsChoice(null);
      setBothWays(true);
      setSavedBackendSshHost("");
      setSavedBackendSshUsername("");
      setSavedBackendSshPort("");
    }
    onOpenChange(nextOpen);
  };
  const connectSavedBackendSshTarget = async (target: DesktopSshEnvironmentTarget) => {
    const session = savedBackendSessionRef.current;
    setIsAddingSavedBackend(true);
    onErrorChange(null);
    const result = await connectSshEnvironment({
      target,
      label: "",
      ...(routeTarget ? { expectedEnvironmentId: routeTarget.environmentId } : {}),
    });
    if (result._tag === "Failure") {
      if (session === savedBackendSessionRef.current && !isAtomCommandInterrupted(result)) {
        pipe(squashAtomCommandFailure(result), formatDesktopSshConnectionError, onErrorChange);
      }
      setIsAddingSavedBackend(false);
      return;
    }

    handleOpenChange(false);
    toastManager.add({
      type: "success",
      title: routeTarget ? "Route added" : "Environment connected",
      description: routeTarget
        ? `${routeTarget.label} can now be reached over SSH ${target.alias}.`
        : `${target.alias} is ready over an SSH-managed tunnel.`,
    });
    setIsAddingSavedBackend(false);
  };

  const handleAddSavedBackend = async () => {
    if (savedBackendMode === "ssh") {
      let target: DesktopSshEnvironmentTarget;
      try {
        target = parseManualDesktopSshTarget({
          host: savedBackendSshHost,
          username: savedBackendSshUsername,
          port: savedBackendSshPort,
        });
      } catch (error) {
        onErrorChange(formatDesktopSshConnectionError(error));
        return;
      }

      await connectSavedBackendSshTarget(target);
      return;
    }

    setIsAddingSavedBackend(true);
    onErrorChange(null);
    // The desktop app signs in through Tailscale with no code when the machine offers it.
    if (
      desktopBridge !== undefined &&
      savedBackendPairingCode.trim() === "" &&
      tailnetSignInBaseUrl(savedBackendHost) !== null
    ) {
      const result = await connectTailnet({
        address: savedBackendHost,
        ...(routeTarget ? { expectedEnvironmentId: routeTarget.environmentId } : {}),
      });
      const signInBaseUrl = tailnetSignInBaseUrl(savedBackendHost);
      if (result._tag === "Success" && Option.isSome(result.value) && signInBaseUrl !== null) {
        await finishSavedBackend({
          environmentId: result.value.value,
          label: savedBackendHost.trim(),
          httpBaseUrl: signInBaseUrl,
        });
        return;
      }
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        onErrorChange(error instanceof Error ? error.message : "Failed to add backend.");
      }
      if (result._tag === "Success") {
        onErrorChange(
          "That machine does not offer Tailscale sign-in. Paste a pairing link from it instead.",
        );
      }
      setIsAddingSavedBackend(false);
      return;
    }
    let remotePairingInput: ReturnType<typeof parseRemotePairingFields>;
    try {
      remotePairingInput = pastedLink
        ? pastedLink
        : parseRemotePairingFields({
            host: savedBackendHost,
            pairingCode: savedBackendPairingCode,
          });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add backend.";
      onErrorChange(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not add backend",
          description: message,
        }),
      );
      setIsAddingSavedBackend(false);
      return;
    }

    const result = await connectPairing({
      ...remotePairingInput,
      ...(routeTarget ? { expectedEnvironmentId: routeTarget.environmentId } : {}),
      ...(primaryEnvironment ? { clientLabel: primaryEnvironment.label } : {}),
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        const message = error instanceof Error ? error.message : "Failed to add backend.";
        onErrorChange(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not add backend",
            description: message,
          }),
        );
      }
      setIsAddingSavedBackend(false);
      return;
    }

    await finishSavedBackend({
      environmentId: result.value,
      label: remotePairingInput.host,
      httpBaseUrl: resolveRemotePairingTarget(remotePairingInput).httpBaseUrl,
    });
  };

  const finishSavedBackend = async (added: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly httpBaseUrl: string;
  }) => {
    const { environmentId } = added;
    let agentsProblem: string | null = null;
    if (!routeTarget && letAgentsRun && primaryEnvironmentId !== null) {
      // Before hiding it: the code for the agents' link is minted over the new connection.
      agentsProblem = await linkAgentsTo({
        hostEnvironmentId: primaryEnvironmentId,
        target: { environmentId, label: added.label, urls: [added.httpBaseUrl] },
      });
    }
    // Before hiding it as well: the offer travels over the new connection.
    const backProblem =
      !routeTarget && bothWays
        ? await offerConnectionBack({ environmentId, label: added.label })
        : null;
    if (!routeTarget && !showChats) {
      await setEnvironmentEnabled({ environmentId, enabled: false });
    }

    handleOpenChange(false);
    toastManager.add(
      routeTarget
        ? {
            type: "success",
            title: "Route added",
            description: `${routeTarget.label} now has another way to connect.`,
          }
        : {
            type: "success",
            title: "Machine added",
            description: showChats
              ? bothWays
                ? "Its chats and projects show up here. This machine shows up there once its app is open."
                : "Its chats and projects show up here, and it reconnects on its own."
              : "Agents here can run work there.",
          },
    );
    if (backProblem !== null) {
      toastManager.add({
        type: "warning",
        title: "Connected one way only",
        description: backProblem,
      });
    }
    if (agentsProblem !== null) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Agents here can't run work there yet",
          description: `${agentsProblem} Turn it on from the machine's row in Connected machines.`,
        }),
      );
    }
    setIsAddingSavedBackend(false);
  };

  const handleSavedBackendSshFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && savedBackendSshHost.trim().length > 0) {
      event.preventDefault();
      void handleAddSavedBackend();
    }
  };

  const handleSelectSshHostSuggestion = async (target: DesktopDiscoveredSshHost) => {
    if (isAddingSavedBackend || !desktopBridge) return;

    const session = savedBackendSessionRef.current;
    setIsAddingSavedBackend(true);
    onErrorChange(null);
    setSavedBackendSshHost(target.alias);
    let resolved: DesktopSshEnvironmentTarget;
    try {
      resolved = await desktopBridge.resolveSshHost(target.alias);
    } catch (error) {
      if (session === savedBackendSessionRef.current) {
        onErrorChange(formatDesktopSshConnectionError(error));
      }
      setIsAddingSavedBackend(false);
      return;
    }
    if (session !== savedBackendSessionRef.current) {
      setIsAddingSavedBackend(false);
      return;
    }
    setSavedBackendSshUsername(resolved.username ?? "");
    setSavedBackendSshPort(resolved.port === null ? "" : String(resolved.port));
    await connectSavedBackendSshTarget(resolved);
  };

  const handleSavedBackendSshHostKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;

    const isSshHostPopupVisible = sshHostSuggestionsOpen && hasSshHostSuggestionContent;
    if (isSshHostPopupVisible) {
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: { modelPickerOpen: false },
      });
      const index = threadJumpIndexFromCommand(command ?? "");
      const target = index === null ? undefined : filteredDiscoveredSshHosts[index];
      if (target) {
        event.preventDefault();
        event.stopPropagation();
        setSshHostSuggestionsOpen(false);
        void handleSelectSshHostSuggestion(target);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    const hasHighlightedSshHost =
      isSshHostPopupVisible && highlightedSshHostRef.current !== undefined;
    if (
      !event.defaultPrevented &&
      !hasHighlightedSshHost &&
      event.key === "Enter" &&
      savedBackendSshHost.trim().length > 0
    ) {
      event.preventDefault();
      void handleAddSavedBackend();
    }
  };

  const handleSavedBackendHostChange = (value: string) => {
    const parsedPairingUrl = parsePairingUrlFields(value);
    if (parsedPairingUrl) {
      setSavedBackendHost(parsedPairingUrl.host);
      setSavedBackendPairingCode(parsedPairingUrl.pairingCode);
      return;
    }
    setSavedBackendHost(value);
  };
  const renderConnectionModeCard = (input: {
    readonly mode: "remote" | "ssh";
    readonly title: string;
    readonly description: string;
    readonly icon?: ReactNode;
  }) => {
    const selected = savedBackendMode === input.mode;
    return (
      <button
        type="button"
        aria-pressed={selected}
        className={cn(
          "group flex min-h-24 items-start gap-3 rounded-lg border p-4 text-left",
          selected ? "border-primary/50 bg-primary/5" : "border-border/60 hover:bg-muted/40",
        )}
        disabled={isAddingSavedBackend}
        onClick={() => {
          setSavedBackendMode(input.mode);
        }}
      >
        {input.icon ? (
          <span
            className={cn(
              "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border",
              selected
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-border/70 bg-background text-muted-foreground group-hover:text-foreground",
            )}
          >
            {input.icon}
          </span>
        ) : null}
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">{input.title}</span>
          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
            {input.description}
          </span>
        </span>
      </button>
    );
  };

  const renderRemoteFields = () => (
    <div className="space-y-3">
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-foreground">Link or code</span>
        <Input
          value={savedBackendPairingCode}
          onChange={(event) => setSavedBackendPairingCode(event.target.value)}
          placeholder="Paste the link from Add a device, or its code"
          disabled={isAddingSavedBackend}
          spellCheck={false}
          autoFocus
        />
        {pastedLink ? (
          <span className="mt-1 block text-xs text-success">Connects to {pastedLink.host}</span>
        ) : null}
      </label>
      {pastedLink ? null : (
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            Address of the other machine
          </span>
          <Input
            value={savedBackendHost}
            onChange={(event) => handleSavedBackendHostChange(event.target.value)}
            placeholder="machine.tailnet.ts.net:8444"
            disabled={isAddingSavedBackend}
            spellCheck={false}
          />
          <span className="mt-1 block text-2xs text-muted-foreground">
            {desktopBridge
              ? "Only needed with a bare code. On your tailnet, a machine name or 100.x address alone needs no code."
              : "Only needed with a bare code. The link from Add a device already has it."}
          </span>
        </label>
      )}
      {pastedLink === null && unsavedTailnetMachines.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Or pick one on your tailnet</p>
          <div className="divide-y divide-border/60 rounded-lg border border-border/60">
            {unsavedTailnetMachines.map((machine) => {
              const address = machine.magicDnsName ?? machine.tailnetIpv4;
              const selected = savedBackendHost.trim() === address;
              return (
                <button
                  key={machine.environmentId}
                  type="button"
                  aria-pressed={selected}
                  disabled={isAddingSavedBackend}
                  onClick={() => setSavedBackendHost(address)}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-2 text-left outline-none first:rounded-t-lg last:rounded-b-lg focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    selected ? "bg-primary/10" : "hover:bg-muted/40",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-foreground">
                      {machine.name}
                    </span>
                    <span className="block truncate text-2xs text-muted-foreground">{address}</span>
                  </span>
                  {selected ? <span className="text-xs text-primary">Selected</span> : null}
                </button>
              );
            })}
          </div>
          <p className="text-2xs text-muted-foreground">
            With no code, it signs in through Tailscale when that machine allows it.
          </p>
        </div>
      ) : null}
      {routeTarget ? null : (
        <div className="divide-y divide-border/60 rounded-lg border border-border/60">
          <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-foreground">
                Show its chats and projects here
              </span>
            </span>
            <Switch
              checked={showChats}
              disabled={isAddingSavedBackend}
              onCheckedChange={setChatsChoice}
              aria-label="Show its chats and projects here"
            />
          </label>
          {canLinkAgents ? (
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-foreground">
                  Agents here can run work there
                </span>
                <span className="block text-xs text-muted-foreground">
                  Each task asks for approval on that machine.
                </span>
              </span>
              <Switch
                checked={letAgentsRun}
                disabled={isAddingSavedBackend}
                onCheckedChange={setAgentsChoice}
                aria-label="Agents here can run work there"
              />
            </label>
          ) : null}
          {primaryEnvironmentId !== null ? (
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-foreground">Connect both ways</span>
                <span className="block text-xs text-muted-foreground">
                  That machine adds this one too, with no second code.
                </span>
              </span>
              <Switch
                checked={bothWaysChosen}
                disabled={isAddingSavedBackend}
                onCheckedChange={setBothWays}
                aria-label="Connect both ways"
              />
            </label>
          ) : null}
        </div>
      )}
    </div>
  );
  const relayRouteOffer =
    routeTarget !== null &&
    !routeTarget.relayManaged &&
    relayDiscoveryState.environments.has(routeTarget.environmentId)
      ? relayDiscoveryState.environments.get(routeTarget.environmentId)!.environment
      : null;
  const addRelayRoute = async () => {
    if (relayRouteOffer === null || routeTarget === null) return;
    setIsAddingSavedBackend(true);
    const result = await registerEnvironment(
      new RelayConnectionRegistration({
        target: new RelayConnectionTarget({
          environmentId: relayRouteOffer.environmentId,
          label: routeTarget.label,
        }),
      }),
    );
    setIsAddingSavedBackend(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        onErrorChange(error instanceof Error ? error.message : "Could not add the route.");
      }
      return;
    }
    handleOpenChange(false);
    toastManager.add({
      type: "success",
      title: "Route added",
      description: `${routeTarget.label} falls back to T3 Connect when its other routes are unreachable.`,
    });
  };
  const renderRemoteModeBody = () => (
    <div className="space-y-4">
      {relayRouteOffer !== null ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
          <p className="text-xs text-muted-foreground">
            This machine is on your T3 Connect account. Use it as a fallback route.
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={isAddingSavedBackend}
            onClick={() => void addRelayRoute()}
          >
            Add T3 Connect
          </Button>
        </div>
      ) : null}
      {renderRemoteFields()}
      {error ? <p className="text-xs whitespace-pre-wrap text-destructive">{error}</p> : null}
      <Button
        variant="outline"
        className="w-full"
        disabled={isAddingSavedBackend}
        onClick={() => void handleAddSavedBackend()}
      >
        <PlusIcon className="size-3.5" />
        {isAddingSavedBackend ? "Connecting…" : routeTarget ? "Add route" : "Connect"}
      </Button>
    </div>
  );
  const renderSshFields = () => (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="block">
          <label
            htmlFor="saved-backend-ssh-host"
            className="mb-1.5 block text-xs font-medium text-foreground"
          >
            SSH host or alias
          </label>
          <Autocomplete
            items={filteredDiscoveredSshHosts}
            itemToStringValue={(target) => target.alias}
            mode="none"
            openOnInputClick
            open={sshHostSuggestionsOpen}
            onOpenChange={setSshHostSuggestionsOpen}
            onItemHighlighted={(target) => {
              highlightedSshHostRef.current = target;
            }}
            value={savedBackendSshHost}
            onValueChange={(value, eventDetails) => {
              setSavedBackendSshHost(value);
              if (eventDetails.reason !== "item-press") return;

              const target = filteredDiscoveredSshHosts.find((host) => host.alias === value);
              if (target) void handleSelectSshHostSuggestion(target);
            }}
          >
            <AutocompleteInput
              id="saved-backend-ssh-host"
              onKeyDown={handleSavedBackendSshHostKeyDown}
              placeholder="Search hosts or type devbox"
              disabled={isAddingSavedBackend}
              spellCheck={false}
            />
            {hasSshHostSuggestionContent ? (
              <AutocompletePopup>
                {isLoadingDiscoveredSshHosts ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">Loading hosts…</div>
                ) : filteredDiscoveredSshHosts.length > 0 ? (
                  <AutocompleteList className="max-h-72">
                    {filteredDiscoveredSshHosts.map((target, index) => {
                      const address = formatDesktopSshTarget(target);
                      const shortcutCommand = index < 9 ? threadJumpCommandForIndex(index) : null;
                      const shortcutLabel = shortcutCommand
                        ? shortcutLabelForCommand(keybindings, shortcutCommand, navigator.platform)
                        : null;
                      return (
                        <AutocompleteItem
                          key={`${target.alias}:${target.hostname}:${target.port ?? ""}`}
                          value={target}
                          className="h-8 min-h-8 whitespace-nowrap"
                        >
                          <span className="min-w-0 truncate text-sm font-medium">
                            {target.alias}
                          </span>
                          {address !== target.alias ? (
                            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                              {address}
                            </span>
                          ) : (
                            <span className="flex-1" />
                          )}
                          {shortcutLabel ? (
                            <CommandShortcut className="shrink-0">{shortcutLabel}</CommandShortcut>
                          ) : null}
                        </AutocompleteItem>
                      );
                    })}
                  </AutocompleteList>
                ) : (
                  <AutocompleteEmpty className="break-all">
                    No hosts match "{savedBackendSshHost.trim()}".
                  </AutocompleteEmpty>
                )}
              </AutocompletePopup>
            ) : null}
          </Autocomplete>
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Username</span>
            <Input
              value={savedBackendSshUsername}
              onChange={(event) => setSavedBackendSshUsername(event.target.value)}
              onKeyDown={handleSavedBackendSshFieldKeyDown}
              placeholder="root"
              disabled={isAddingSavedBackend}
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Port</span>
            <Input
              value={savedBackendSshPort}
              onChange={(event) => setSavedBackendSshPort(event.target.value)}
              onKeyDown={handleSavedBackendSshFieldKeyDown}
              placeholder="22"
              inputMode="numeric"
              disabled={isAddingSavedBackend}
              spellCheck={false}
            />
          </label>
        </div>
        {error || discoveredSshHostsError ? (
          <Alert variant="error">
            <AlertDescription>{error ?? discoveredSshHostsError}</AlertDescription>
          </Alert>
        ) : null}
        <Button
          variant="outline"
          className="w-full"
          disabled={isAddingSavedBackend}
          onClick={() => void handleAddSavedBackend()}
        >
          <PlusIcon className="size-3.5" />
          {isAddingSavedBackend ? "Connecting…" : routeTarget ? "Add route" : "Connect"}
        </Button>
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={
                <Button size="xs" variant="ghost-muted" aria-label="Add a machine">
                  <PlusIcon className="size-3" />
                  <span>Add a machine</span>
                </Button>
              }
            />
          }
        />
        <TooltipPopup side="top">Add a machine</TooltipPopup>
      </Tooltip>
      <DialogPopup className="max-h-[80dvh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {routeTarget ? `Add a route to ${routeTarget.label}` : "Add a machine"}
          </DialogTitle>
          <DialogDescription>
            {routeTarget
              ? "Pair this machine again over another address, such as its Tailscale name. It joins the existing routes instead of adding a second machine."
              : "Paste the link from Add a device on the other machine, or enter its code."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {renderConnectionModeCard({
                mode: "remote",
                title: "Link or code",
                description: "From Add a device on the other machine.",
                icon: <ChevronsLeftRightEllipsisIcon aria-hidden className="size-4" />,
              })}
              {desktopBridge
                ? renderConnectionModeCard({
                    mode: "ssh",
                    title: "SSH",
                    description: "Use local SSH config, agent, and tunnels for the backend.",
                    icon: <TerminalIcon aria-hidden className="size-4" />,
                  })
                : null}
            </div>
            <AnimatedHeight>
              {savedBackendMode === "ssh" ? renderSshFields() : renderRemoteModeBody()}
            </AnimatedHeight>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
