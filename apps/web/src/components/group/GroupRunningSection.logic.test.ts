import type { ThreadGroupManualResource, ThreadGroupRunningResource } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runningRowView, withoutManualResource } from "./GroupRunningSection.logic";

type Resource = ThreadGroupRunningResource;
const base = { url: null, source: "cwd" } as const;

function resource(overrides: Partial<Resource> & Pick<Resource, "id" | "kind">): Resource {
  return { name: "api", detail: ":5733", ...base, ...overrides } as Resource;
}

describe("runningRowView", () => {
  it("shows a scanned server as running with its url as the open target", () => {
    const view = runningRowView(
      resource({ id: "server:5733", kind: "server", url: "http://127.0.0.1:5733" }),
    );
    expect(view).toMatchObject({
      tone: "running",
      openUrl: "http://127.0.0.1:5733",
      manualId: null,
    });
  });

  it("offers no open action for a container without a published port", () => {
    expect(
      runningRowView(resource({ id: "docker:abc", kind: "container", detail: "docker" })).openUrl,
    ).toBeNull();
  });

  it("marks a manual resource as registered and removable by its stored id", () => {
    const view = runningRowView(
      resource({ id: "manual:db1", kind: "manual", source: "registered", url: "postgres://x" }),
    );
    expect(view).toMatchObject({ tone: "registered", manualId: "db1", openUrl: null });
  });
});

describe("withoutManualResource", () => {
  it("drops only the matching resource", () => {
    const list = [
      { id: "a", name: "A", url: null, kind: "other" },
      { id: "b", name: "B", url: null, kind: "other" },
    ] as ReadonlyArray<ThreadGroupManualResource>;
    expect(withoutManualResource(list, "a").map((r) => r.id)).toEqual(["b"]);
  });
});
