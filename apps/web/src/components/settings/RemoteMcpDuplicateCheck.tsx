import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderDisabledInventory, ServerProvider } from "@t3tools/contracts";
import type { RemoteMcpServer } from "@t3tools/contracts/remoteMcp";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { providersIgnoringCheckedAtAtom, serverEnvironment } from "../../state/server";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { findLikelyDuplicates, type DuplicateKind } from "./remoteMcpDuplicates";

const KIND_LABELS: Record<DuplicateKind, string> = {
  connectors: "connector",
  mcpServers: "MCP server",
};

const providerLabel = (provider: ServerProvider) => provider.displayName ?? provider.driver;

/**
 * Asks each agent that can list its own connectors whether it already has one
 * of these servers, so its tools would show up twice. Listing starts the agent
 * and its MCP servers, so this runs only when the user asks.
 */
export function RemoteMcpDuplicateCheck(props: {
  readonly environmentId: EnvironmentId;
  readonly servers: ReadonlyArray<RemoteMcpServer>;
}) {
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(props.environmentId)).filter(
    (provider) => provider.enabled && provider.supportsInventory === true,
  );
  const disabledByInstance = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.providerInstances,
  );

  return (
    <div className="grid gap-2 border-t px-4 py-3 text-xs sm:px-5">
      <p className="text-muted-foreground">
        Agents that already have one of these servers in their own setup see its tools twice.
        Matches are a guess from the name and tool count, so check before switching anything off.
      </p>
      {providers.length === 0 ? (
        <p className="text-muted-foreground">
          None of this environment's agents can list their own connectors yet.
        </p>
      ) : (
        providers.map((provider) => (
          <ProviderDuplicates
            key={provider.instanceId}
            environmentId={props.environmentId}
            provider={provider}
            servers={props.servers}
            disabled={disabledByInstance?.[provider.instanceId]?.disabledInventory}
          />
        ))
      )}
    </div>
  );
}

function ProviderDuplicates(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly servers: ReadonlyArray<RemoteMcpServer>;
  readonly disabled: ProviderDisabledInventory | undefined;
}) {
  const label = providerLabel(props.provider);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(
    props.environmentId,
  );
  const query = useEnvironmentQuery(
    serverEnvironment.providerInventory({
      environmentId: props.environmentId,
      input: { instanceId: props.provider.instanceId },
    }),
  );

  if (query.data === null) {
    return query.error ? (
      <p className="text-destructive">
        {label}: {query.error}
      </p>
    ) : (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Spinner size="xs" tone="muted" />
        Checking {label}…
      </p>
    );
  }

  const duplicates = findLikelyDuplicates(props.servers, query.data);
  if (duplicates.length === 0) {
    return <p className="text-muted-foreground">{label}: no duplicates found.</p>;
  }
  return (
    <ul className="grid gap-2">
      {duplicates.map(({ kind, item, server, canDisable }) => {
        const enabledInT3 = !(props.disabled?.[kind] ?? []).includes(item.id);
        return (
          <li key={`${kind}:${item.id}`} className="flex items-start justify-between gap-3">
            <span className="min-w-0">
              {label} also has the {KIND_LABELS[kind]} <strong>{item.name}</strong>
              {item.toolCount === undefined ? "" : ` (${item.toolCount} tools)`}, which looks like{" "}
              <strong>{server.name}</strong>.
              {canDisable
                ? ` Switch it off to have ${label} use only the copy added here.`
                : ` ${label} can't hide it from T3, so remove it from ${label}'s own config to avoid duplicates.`}
            </span>
            {canDisable && (
              <label className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                In T3
                <Switch
                  checked={enabledInT3}
                  aria-label={`Use ${label}'s ${item.name} in T3`}
                  onCheckedChange={async (checked) => {
                    const result = await persistProviderInstance({
                      operation: "set-inventory-item",
                      instanceId: props.provider.instanceId,
                      driver: props.provider.driver,
                      kind,
                      itemId: item.id,
                      enabledInT3: Boolean(checked),
                    });
                    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                      const error = squashAtomCommandFailure(result);
                      toastManager.add({
                        type: "error",
                        title: `Could not update ${label}`,
                        description:
                          error instanceof Error ? error.message : "The settings update failed.",
                      });
                    }
                  }}
                />
              </label>
            )}
          </li>
        );
      })}
    </ul>
  );
}
