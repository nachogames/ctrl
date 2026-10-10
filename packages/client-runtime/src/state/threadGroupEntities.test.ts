import { EnvironmentId, ThreadId, type OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { parseThreadGroupKey, threadGroupKey } from "./entities.ts";
import { v2ShellSnapshot, v2ThreadGroup, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { createEnvironmentThreadGroupAtoms } from "./threadGroupEntities.ts";

const environmentId = EnvironmentId.make("environment-v2");
const otherEnvironmentId = EnvironmentId.make("environment-personal");

function makeHarness(environmentIds: ReadonlyArray<EnvironmentId> = [environmentId]) {
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<OrchestrationV2ShellSnapshot | null>(v2ShellSnapshot),
  );
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map(
      environmentIds.map((id) => [
        id,
        {
          target: new PrimaryConnectionTarget({
            environmentId: id,
            label: "Environment",
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          profile: Option.none(),
          enabled: true,
        },
      ]),
    ),
  });
  return {
    registry: AtomRegistry.make(),
    snapshotAtom,
    groups: createEnvironmentThreadGroupAtoms({ catalogValueAtom, snapshotAtom }),
  };
}

describe("thread group atoms", () => {
  it("keeps a group object while its members' other fields stream", () => {
    const { registry, groups, snapshotAtom } = makeHarness();
    const member = { ...v2ThreadShell, groupId: v2ThreadGroup.id };
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [member],
      groups: [v2ThreadGroup],
    });
    const atom = groups.threadGroupAtom({ environmentId, groupId: v2ThreadGroup.id });
    const dispose = registry.mount(atom);
    const before = registry.get(atom);
    expect(before?.threadIds).toEqual([member.id]);

    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [{ ...member, title: "Streaming" }],
      groups: [v2ThreadGroup],
    });
    expect(registry.get(atom)).toBe(before);

    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [{ ...member, title: "Streaming" }],
      groups: [],
    });
    expect(registry.get(atom)).toBeNull();
    dispose();
  });

  it("lists groups across enabled environments", () => {
    const { registry, groups, snapshotAtom } = makeHarness();
    registry.set(snapshotAtom(environmentId), { ...v2ShellSnapshot, groups: [v2ThreadGroup] });
    const dispose = registry.mount(groups.threadGroupsAtom);
    expect(registry.get(groups.threadGroupsAtom).map((group) => group.id)).toEqual([
      v2ThreadGroup.id,
    ]);
    dispose();
  });

  it("keeps same-id groups of two environments apart", () => {
    const { registry, groups, snapshotAtom } = makeHarness([environmentId, otherEnvironmentId]);
    const workThread = {
      ...v2ThreadShell,
      id: ThreadId.make("thread-work"),
      groupId: v2ThreadGroup.id,
    };
    const homeThread = {
      ...v2ThreadShell,
      id: ThreadId.make("thread-home"),
      groupId: v2ThreadGroup.id,
    };
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [workThread],
      groups: [{ ...v2ThreadGroup, title: "Work" }],
    });
    registry.set(snapshotAtom(otherEnvironmentId), {
      ...v2ShellSnapshot,
      threads: [homeThread],
      groups: [{ ...v2ThreadGroup, title: "Home" }],
    });
    const work = groups.threadGroupAtom({ environmentId, groupId: v2ThreadGroup.id });
    const home = groups.threadGroupAtom({
      environmentId: otherEnvironmentId,
      groupId: v2ThreadGroup.id,
    });
    const disposers = [
      registry.mount(work),
      registry.mount(home),
      registry.mount(groups.threadGroupsAtom),
    ];

    expect(registry.get(work)).toMatchObject({
      environmentId,
      title: "Work",
      threadIds: ["thread-work"],
    });
    expect(registry.get(home)).toMatchObject({
      environmentId: otherEnvironmentId,
      title: "Home",
      threadIds: ["thread-home"],
    });
    expect(
      registry.get(groups.threadGroupsAtom).map((group) => [group.environmentId, group.title]),
    ).toEqual([
      [environmentId, "Work"],
      [otherEnvironmentId, "Home"],
    ]);

    registry.set(snapshotAtom(otherEnvironmentId), {
      ...v2ShellSnapshot,
      threads: [homeThread],
      groups: [],
    });
    expect(registry.get(home)).toBeNull();
    expect(registry.get(work)?.title).toBe("Work");
    for (const dispose of disposers) dispose();
  });

  it("round-trips a scoped group key", () => {
    const ref = { environmentId: otherEnvironmentId, groupId: v2ThreadGroup.id };
    expect(parseThreadGroupKey(threadGroupKey(ref))).toEqual(ref);
    expect(threadGroupKey(ref)).not.toBe(threadGroupKey({ ...ref, environmentId }));
    expect(() => parseThreadGroupKey("no-separator")).toThrow();
  });
});
