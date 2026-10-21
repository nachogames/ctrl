import type { ProviderInventory, ProviderInventoryItem } from "@t3tools/contracts";
import type { RemoteMcpServer } from "@t3tools/contracts/remoteMcp";

export type DuplicateKind = "connectors" | "mcpServers";

export interface LikelyDuplicate {
  readonly kind: DuplicateKind;
  readonly item: ProviderInventoryItem;
  readonly server: RemoteMcpServer;
  /** The provider can keep this item out of T3 sessions without touching its own config. */
  readonly canDisable: boolean;
}

/** Fewer tools than this match by coincidence too often to count. */
const MIN_MATCHING_TOOL_COUNT = 5;

const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

const namesMatch = (itemName: string, server: RemoteMcpServer) => {
  const item = normalize(itemName);
  if (item.length < 3) return false;
  return [server.name, server.id]
    .map(normalize)
    .some(
      (candidate) =>
        candidate.length >= 3 && (item.includes(candidate) || candidate.includes(item)),
    );
};

const toolCountsMatch = (item: ProviderInventoryItem, server: RemoteMcpServer) =>
  server.state === "connected" &&
  item.toolCount !== undefined &&
  item.toolCount >= MIN_MATCHING_TOOL_COUNT &&
  item.toolCount === server.toolCount;

/**
 * A provider's own connectors and MCP servers that look like a server added in
 * T3. Providers report only a display name and a tool count, so this is a guess
 * for the user to confirm, never something to act on alone.
 */
export function findLikelyDuplicates(
  servers: ReadonlyArray<RemoteMcpServer>,
  inventory: ProviderInventory,
): ReadonlyArray<LikelyDuplicate> {
  const duplicates: Array<LikelyDuplicate> = [];
  for (const kind of ["connectors", "mcpServers"] as const) {
    const section = inventory[kind];
    if (section._tag !== "Listed") continue;
    for (const item of section.items) {
      const server = servers.find(
        (candidate) => namesMatch(item.name, candidate) || toolCountsMatch(item, candidate),
      );
      if (server !== undefined) {
        duplicates.push({ kind, item, server, canDisable: section.canDisable });
      }
    }
  }
  return duplicates;
}
