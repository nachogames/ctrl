import type { ProviderInventory, ProviderInventoryItem } from "@t3tools/contracts";
import type { RemoteMcpServer } from "@t3tools/contracts/remoteMcp";
import { describe, expect, it } from "vite-plus/test";

import { findLikelyDuplicates } from "./remoteMcpDuplicates";

const server = (overrides: Partial<RemoteMcpServer> = {}): RemoteMcpServer => ({
  id: "notes",
  name: "Notes",
  url: "https://mcp.example.com/mcp",
  authMode: "oauth",
  state: "connected",
  toolCount: 12,
  ...overrides,
});

const inventory = (
  connectors: ReadonlyArray<ProviderInventoryItem>,
  mcpServers: ReadonlyArray<ProviderInventoryItem> = [],
): ProviderInventory =>
  ({
    instanceId: "claudeAgent",
    checkedAt: "2026-10-21T00:00:00.000Z",
    connectors: { _tag: "Listed", items: connectors, canDisable: true },
    mcpServers: { _tag: "Listed", items: mcpServers, canDisable: false },
    plugins: { _tag: "Unsupported" },
    skills: { _tag: "Unsupported" },
  }) as ProviderInventory;

describe("findLikelyDuplicates", () => {
  it("flags a connector whose name matches the server's name or prefix", () => {
    const found = findLikelyDuplicates(
      [server()],
      inventory([
        { id: "c1", name: "My Notes App", toolCount: 3 },
        { id: "c2", name: "Calendar", toolCount: 12 },
      ]),
    );
    expect(found.map((duplicate) => duplicate.item.id)).toEqual(["c1", "c2"]);
    expect(found[0]?.canDisable).toBe(true);
  });

  it("matches on tool count only when the server is connected and has several tools", () => {
    const items = [{ id: "c1", name: "Unrelated", toolCount: 3 }];
    expect(findLikelyDuplicates([server({ toolCount: 3 })], inventory(items))).toEqual([]);
    expect(
      findLikelyDuplicates(
        [server({ state: "needs_authorization", toolCount: 12 })],
        inventory([{ id: "c1", name: "Unrelated", toolCount: 12 }]),
      ),
    ).toEqual([]);
  });

  it("reports whether the provider can keep each kind out of T3", () => {
    const found = findLikelyDuplicates(
      [server()],
      inventory([], [{ id: "notes", name: "notes", toolCount: 12 }]),
    );
    expect(found).toEqual([expect.objectContaining({ kind: "mcpServers", canDisable: false })]);
  });
});
