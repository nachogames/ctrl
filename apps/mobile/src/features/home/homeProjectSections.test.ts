import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { buildThreadListV2Items, buildThreadListV2ListItems } from "../threads/threadListV2";
import {
  buildHomeProjectSections,
  mergeArrangedKeys,
  moveKey,
  type HomeListItem,
  type HomeProjectSectionsInput,
} from "./homeProjectSections";

const environmentId = EnvironmentId.make("local");
const NOW = "2026-10-21T12:00:00.000Z";

function thread(
  id: string,
  project: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return makeThreadShellFixture({
    environmentId,
    id: ThreadId.make(id),
    projectId: ProjectId.make(project),
    title: id,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  });
}

function sections(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  options: Partial<
    Pick<HomeProjectSectionsInput, "showProjectHeaders" | "projectOrder" | "rowOrder" | "liveOrder">
  > & {
    readonly expanded?: ReadonlyArray<string>;
    readonly collapsed?: ReadonlyArray<string>;
    /** Thread id → group key; member order follows this object's key order. */
    readonly groups?: Readonly<Record<string, string>>;
    /** Every active row may move (as when the server supports reordering). */
    readonly movable?: boolean;
  } = {},
) {
  const layout = buildThreadListV2Items({
    threads,
    environmentId: null,
    searchQuery: "",
    now: NOW,
  });
  const groupIds = Object.keys(options.groups ?? {});
  return buildHomeProjectSections({
    items: buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [],
      settledCount: layout.settledCount,
      settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
      ...(options.movable
        ? {
            moveAvailability: new Map(
              threads.map((candidate) => [
                `${candidate.environmentId}:${candidate.id}`,
                { canMoveUp: true, canMoveDown: true },
              ]),
            ),
          }
        : {}),
    }),
    showProjectHeaders: options.showProjectHeaders ?? true,
    projectOf: (candidate) => ({
      key: candidate.projectId,
      title: `Project ${candidate.projectId}`,
    }),
    groupOf: (candidate) => {
      const group = options.groups?.[candidate.id];
      return group === undefined
        ? null
        : { key: group, title: `Group ${group}`, index: groupIds.indexOf(candidate.id) };
    },
    expandedGroupKeys: new Set(options.expanded ?? []),
    collapsedProjectKeys: new Set(options.collapsed ?? []),
    ...(options.projectOrder ? { projectOrder: options.projectOrder } : {}),
    ...(options.rowOrder ? { rowOrder: options.rowOrder } : {}),
    ...(options.liveOrder ? { liveOrder: options.liveOrder } : {}),
  });
}

function describeItems(items: ReadonlyArray<HomeListItem>): string[] {
  return items.map((item) => {
    switch (item.type) {
      case "home-section":
        return `# ${item.label}`;
      case "home-group":
        return `[${item.title}: ${item.threads.map((member) => member.id).join(",")}]`;
      case "v2-thread":
        return "groupMember" in item ? `  ${item.item.thread.id}` : item.item.thread.id;
      default:
        return item.type;
    }
  });
}

describe("buildHomeProjectSections", () => {
  it("lifts threads that need the user above pinned and project sections", () => {
    const { items } = sections([
      thread("a", "ctrl"),
      thread("b", "ember", { hasPendingApprovals: true }),
      thread("c", "ember"),
      thread("p", "ctrl", { pinnedAt: "2026-10-02T00:00:00.000Z" }),
    ]);
    expect(describeItems(items)).toEqual([
      "# Needs you",
      "b",
      "# Pinned",
      "p",
      "# Project ctrl",
      "a",
      "# Project ember",
      "c",
    ]);
  });

  it("places a group where its first chat falls, members in the group's order", () => {
    const groups = { g2: "g", g1: "g" };
    const threads = [
      thread("solo", "ctrl", { createdAt: "2026-10-03T00:00:00.000Z" }),
      thread("g1", "ctrl"),
      thread("g2", "ctrl"),
    ];
    expect(describeItems(sections(threads, { groups }).items)).toEqual([
      "# Project ctrl",
      "solo",
      "[Group g: g2,g1]",
    ]);
    expect(describeItems(sections(threads, { groups, expanded: ["g"] }).items)).toEqual([
      "# Project ctrl",
      "solo",
      "[Group g: g2,g1]",
      "  g2",
      "  g1",
    ]);
  });

  it("shows a lone remaining group member as a plain row", () => {
    const { items } = sections(
      [thread("g1", "ctrl"), thread("g2", "ctrl", { hasPendingUserInput: true })],
      { groups: { g1: "g", g2: "g" } },
    );
    expect(describeItems(items)).toEqual(["# Needs you", "g2", "# Project ctrl", "g1"]);
  });

  it("follows the saved project order and orders groups and threads together", () => {
    const threads = [
      thread("a", "ctrl"),
      thread("b", "ember"),
      thread("c", "taskflow"),
      thread("x1", "ctrl"),
      thread("x2", "ctrl"),
      thread("d", "ctrl"),
    ];
    const key = (id: string) => `v2-thread:${environmentId}:${id}`;
    const { items, projects } = sections(threads, {
      groups: { x1: "x", x2: "x" },
      projectOrder: ["taskflow", "ctrl"],
      rowOrder: [key("d"), "home-group:x", key("a")],
    });
    expect(projects.map((project) => project.key)).toEqual(["taskflow", "ctrl", "ember"]);
    expect(describeItems(items)).toEqual([
      "# Project taskflow",
      "c",
      "# Project ctrl",
      "d",
      "[Group x: x1,x2]",
      "a",
      "# Project ember",
      "b",
    ]);
  });

  it("keeps an unarranged new thread in its natural slot", () => {
    const key = (id: string) => `v2-thread:${environmentId}:${id}`;
    const { items } = sections(
      [
        thread("new", "ctrl", { createdAt: "2026-10-03T00:00:00.000Z" }),
        thread("a", "ctrl"),
        thread("b", "ctrl"),
      ],
      {
        rowOrder: [key("b"), key("a")],
      },
    );
    expect(describeItems(items)).toEqual(["# Project ctrl", "new", "b", "a"]);
  });

  it("lets Move up/down step through a project's rows, groups included", () => {
    const { items, siblings } = sections(
      [thread("a", "ctrl"), thread("b", "ember"), thread("x1", "ctrl"), thread("x2", "ctrl")],
      { groups: { x1: "x", x2: "x" } },
    );
    const moves = items.flatMap((item) =>
      item.type === "v2-thread"
        ? [`${item.item.thread.id}:${item.canMoveUp ? "U" : ""}${item.canMoveDown ? "D" : ""}`]
        : [],
    );
    expect(moves).toEqual(["a:D", "b:"]);
    expect(siblings.get("home-group:x")?.keys).toEqual([
      `v2-thread:${environmentId}:a`,
      "home-group:x",
    ]);
  });

  it("keeps only the header of a collapsed project", () => {
    const { items } = sections([thread("a", "ctrl"), thread("b", "ctrl"), thread("c", "ember")], {
      collapsed: ["ctrl"],
    });
    expect(describeItems(items)).toEqual(["# Project ctrl", "# Project ember", "c"]);
    const header = items[0];
    expect(header?.type === "home-section" && header.collapsed && header.count).toBe(2);
  });

  it("reports sibling sets and follows a live drag order", () => {
    const threads = [thread("a", "ctrl"), thread("b", "ctrl"), thread("c", "ember")];
    const key = (id: string) => `v2-thread:${environmentId}:${id}`;
    const { siblings } = sections(threads);
    expect(siblings.get(key("a"))).toEqual({ id: "rows:ctrl", keys: [key("a"), key("b")] });
    expect(siblings.has(key("c"))).toBe(false);
    const { items } = sections(threads, {
      liveOrder: { siblings: "rows:ctrl", order: [key("b"), key("a")] },
    });
    expect(describeItems(items)).toEqual(["# Project ctrl", "b", "a", "# Project ember", "c"]);
  });

  it("drops project names when one project is selected", () => {
    expect(
      describeItems(sections([thread("a", "ctrl")], { showProjectHeaders: false }).items),
    ).toEqual(["a"]);
  });

  it("leaves settled threads on their shelf", () => {
    const { items } = sections([
      thread("a", "ctrl"),
      thread("done", "ctrl", { settledOverride: "settled" }),
    ]);
    expect(describeItems(items)).toEqual(["# Project ctrl", "a", "v2-settled-shelf", "done"]);
  });
});

describe("arranging keys", () => {
  it("moves one step and stops at the edges", () => {
    expect(moveKey(["a", "b", "c"], "b", "up")).toEqual(["b", "a", "c"]);
    expect(moveKey(["a", "b", "c"], "c", "down")).toBeNull();
  });

  it("keeps hidden keys in place when saving a visible arrangement", () => {
    expect(mergeArrangedKeys(["h1", "a", "h2", "b"], ["a", "b", "c"], ["c", "b", "a"])).toEqual([
      "h1",
      "c",
      "b",
      "a",
      "h2",
    ]);
    expect(mergeArrangedKeys([], ["a", "b"], ["b", "a"])).toEqual(["b", "a"]);
  });
});
