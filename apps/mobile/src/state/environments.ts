import { useAtomValue } from "@effect/atom-react";
import {
  connectedHostBattery,
  connectionCatalogDisplayUrl,
  hasRelayRoute,
  type EnvironmentPresentation as BaseEnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import type { ComposerEnvironmentCandidate } from "@t3tools/client-runtime/composerThreadItems";
import { environmentDisplayLabel } from "@t3tools/client-runtime/state/presentation";
import {
  type EnvironmentId,
  type HostBattery,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";

import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "./presentation";

export interface EnvironmentPresentation extends BaseEnvironmentPresentation {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly displayUrl: string | null;
  readonly relayManaged: boolean;
}

export function projectEnvironmentPresentation(
  environmentId: EnvironmentId,
  presentation: BaseEnvironmentPresentation,
): EnvironmentPresentation {
  return {
    ...presentation,
    environmentId,
    label: environmentDisplayLabel(presentation),
    displayUrl: connectionCatalogDisplayUrl(presentation.entry),
    relayManaged: hasRelayRoute(presentation.entry),
  };
}

export function useEnvironments() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const presentationById = useAtomValue(environmentPresentations.presentationsAtom);

  const environments = [...presentationById.entries()].map(([environmentId, presentation]) =>
    projectEnvironmentPresentation(environmentId, presentation),
  );

  return {
    isReady: catalog.isReady,
    networkStatus,
    environments,
    presentationById,
  };
}

/** The user's machines as `@` mention candidates, drawn with their machine kind. */
export function useMentionableEnvironments(): ReadonlyArray<ComposerEnvironmentCandidate> {
  const { environments } = useEnvironments();
  return environments.map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    machine: resolveEnvironmentMachineKind(environment.serverConfig),
  }));
}

/** The machine's battery while it is connected; null without one. */
export function useHostBattery(environmentId: EnvironmentId | null): HostBattery | null {
  const presentationById = useAtomValue(environmentPresentations.presentationsAtom);
  const presentation = environmentId === null ? undefined : presentationById.get(environmentId);
  return connectedHostBattery(
    presentation === undefined
      ? null
      : { connectionPhase: presentation.connection.phase, serverConfig: presentation.serverConfig },
  );
}

/** Each connected machine's battery, for lists that show several at once. */
export function useHostBatteries(): ReadonlyMap<EnvironmentId, HostBattery> {
  const presentationById = useAtomValue(environmentPresentations.presentationsAtom);
  const batteries = new Map<EnvironmentId, HostBattery>();
  for (const [environmentId, presentation] of presentationById) {
    const battery = connectedHostBattery({
      connectionPhase: presentation.connection.phase,
      serverConfig: presentation.serverConfig,
    });
    if (battery !== null) batteries.set(environmentId, battery);
  }
  return batteries;
}
