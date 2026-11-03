import type { PluginToast } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { unseenPluginToasts } from "./pluginToasts.logic";

const toast = (id: string): PluginToast => ({
  id,
  source: { kind: "plugin", pluginId: "acme.deploys", name: "Deploys" },
  title: id,
  createdAt: "2026-11-03T00:00:00.000Z",
});

describe("unseenPluginToasts", () => {
  it("skips toasts sent before the client connected, then shows each new one once", () => {
    const first = unseenPluginToasts([toast("a")], null);
    expect(first.show).toEqual([]);

    const second = unseenPluginToasts([toast("a"), toast("b")], first.seen);
    expect(second.show.map((entry) => entry.id)).toEqual(["b"]);

    const third = unseenPluginToasts([toast("b")], second.seen);
    expect(third.show).toEqual([]);
  });
});
