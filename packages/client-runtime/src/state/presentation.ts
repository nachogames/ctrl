import {
  resolveEnvironmentLabel,
  resolveEnvironmentMachineKind,
  type EnvironmentMachineKind,
  type EnvironmentId,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE, type SupervisorConnectionState } from "../connection/model.ts";
import {
  connectionCatalogDisplayUrl,
  presentEnvironmentConnection,
  type EnvironmentConnectionPhase,
  type EnvironmentPresentation,
} from "../connection/presentation.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { hasRelayRoute } from "../connection/routes.ts";

function mapsEqual<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

export function createEnvironmentPresentationAtoms<E>(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly stateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<SupervisorConnectionState, E>>;
  /** Authoritative live server config, including streamed provider/settings updates. */
  readonly serverConfigValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
}) {
  const presentationAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const entry = get(input.catalogValueAtom).entries.get(environmentId);
      if (entry === undefined) {
        return null;
      }
      const state = Option.getOrElse(
        AsyncResult.value(get(input.stateAtom(environmentId))),
        () => AVAILABLE_CONNECTION_STATE,
      );
      return {
        entry,
        connection:
          entry.unsupportedReason === undefined
            ? presentEnvironmentConnection(state)
            : { phase: "unsupported", error: entry.unsupportedReason, traceId: null },
        serverConfig: get(input.serverConfigValueAtom(environmentId)),
      } satisfies EnvironmentPresentation;
    }).pipe(Atom.withLabel(`environment-presentation:${environmentId}`)),
  );

  let previous: ReadonlyMap<EnvironmentId, EnvironmentPresentation> = new Map();
  const presentationsAtom = Atom.make((get) => {
    const next = new Map<EnvironmentId, EnvironmentPresentation>();
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const presentation = get(presentationAtom(environmentId));
      if (presentation !== null) {
        next.set(environmentId, presentation);
      }
    }
    if (mapsEqual(previous, next)) {
      return previous;
    }
    previous = next;
    return previous;
  }).pipe(Atom.withLabel("environment-presentations"));

  return {
    presentationAtom,
    presentationsAtom,
  };
}

export interface EnvironmentConnectionSummary {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly displayUrl: string;
  readonly isRelayManaged: boolean;
  readonly isEnabled: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly connectionErrorTraceId: string | null;
}

/**
 * The name to show for an environment: the display name set on its server,
 * else the label saved with its connection (the machine name, or a label
 * such as "WSL: Ubuntu" the desktop gave it).
 */
export function environmentDisplayLabel(
  environment: Pick<EnvironmentPresentation, "entry" | "serverConfig">,
): string {
  return resolveEnvironmentLabel(environment.serverConfig, environment.entry.target.label);
}

export function projectEnvironmentConnectionSummary(
  environmentId: EnvironmentId,
  environment: EnvironmentPresentation,
): EnvironmentConnectionSummary {
  return {
    environmentId,
    environmentLabel: environmentDisplayLabel(environment),
    displayUrl: connectionCatalogDisplayUrl(environment.entry) ?? "",
    isRelayManaged: hasRelayRoute(environment.entry),
    isEnabled: environment.entry.enabled,
    connectionState: environment.connection.phase,
    connectionError: environment.connection.error,
    connectionErrorTraceId: environment.connection.traceId,
  };
}

// Keep list membership and connection chrome independent of provider/config refreshes.
export function createEnvironmentSummaryAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly presentationAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<EnvironmentPresentation | null>;
}) {
  const environmentIdsAtom = Atom.make((get) => {
    const next = [...get(input.catalogValueAtom).entries.keys()];
    const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentId>>());
    return previous !== null &&
      previous.length === next.length &&
      next.every((id, index) => id === previous[index])
      ? previous
      : next;
  });
  // One derived label per environment, so a config refresh that leaves the
  // name alone stops here instead of rebuilding every identity.
  const labelAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const presentation = get(input.presentationAtom(environmentId));
      return presentation === null ? null : environmentDisplayLabel(presentation);
    }),
  );
  const identitiesAtom = Atom.make((get) => {
    const next = [...get(input.catalogValueAtom).entries].map(([environmentId, entry]) => ({
      environmentId,
      label: get(labelAtom(environmentId)) ?? entry.target.label,
    }));
    const previous = Option.getOrNull(
      get.self<ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>>(),
    );
    return previous !== null &&
      previous.length === next.length &&
      next.every(
        (value, index) =>
          value.environmentId === previous[index]?.environmentId &&
          value.label === previous[index]?.label,
      )
      ? previous
      : next;
  });
  const environmentAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const presentation = get(input.presentationAtom(environmentId));
      if (presentation === null) return null;
      const next = projectEnvironmentConnectionSummary(environmentId, presentation);
      const previous = Option.getOrNull(get.self<EnvironmentConnectionSummary | null>());
      // Provider refreshes and transport heartbeats do not change connection UI.
      if (
        previous !== null &&
        previous.environmentId === next.environmentId &&
        previous.environmentLabel === next.environmentLabel &&
        previous.displayUrl === next.displayUrl &&
        previous.isRelayManaged === next.isRelayManaged &&
        previous.isEnabled === next.isEnabled &&
        previous.connectionState === next.connectionState &&
        previous.connectionError === next.connectionError &&
        previous.connectionErrorTraceId === next.connectionErrorTraceId
      )
        return previous;
      return next;
    }),
  );
  const environmentsAtom = Atom.make((get) => {
    const next: Array<EnvironmentConnectionSummary> = [];
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const environment = get(environmentAtom(environmentId));
      if (environment !== null) next.push(environment);
    }
    const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentConnectionSummary>>());
    return previous !== null &&
      previous.length === next.length &&
      next.every((value, index) => value === previous[index])
      ? previous
      : next;
  }).pipe(Atom.withLabel("environment-connection-summaries"));
  const connectedEnvironmentIdsAtom = Atom.make((get) => {
    const next = get(environmentIdsAtom).filter(
      (id) => get(environmentAtom(id))?.connectionState === "connected",
    );
    const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentId>>());
    return previous !== null &&
      previous.length === next.length &&
      next.every((id, index) => id === previous[index])
      ? previous
      : next;
  });
  const machineByIdAtom = Atom.make((get) => {
    const next = new Map(
      get(environmentIdsAtom).map(
        (environmentId) =>
          [
            environmentId,
            resolveEnvironmentMachineKind(
              get(input.presentationAtom(environmentId))?.serverConfig ?? null,
            ),
          ] as const,
      ),
    );
    const previous = Option.getOrNull(
      get.self<ReadonlyMap<EnvironmentId, EnvironmentMachineKind>>(),
    );
    return previous !== null && mapsEqual(previous, next) ? previous : next;
  });
  const pullRequestsSupportedAtom = Atom.make((get) =>
    get(environmentIdsAtom).some(
      (environmentId) =>
        get(input.presentationAtom(environmentId))?.serverConfig?.environment.capabilities
          .pullRequests === true,
    ),
  );
  return {
    environmentIdsAtom,
    connectedEnvironmentIdsAtom,
    identitiesAtom,
    environmentsAtom,
    machineByIdAtom,
    pullRequestsSupportedAtom,
  };
}
