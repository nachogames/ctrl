import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import {
  resolveThreadListV2Status,
  type ThreadListV2ListItem,
  type ThreadListV2ThreadListItem,
} from "../threads/threadListV2";

export interface HomeSectionListItem {
  readonly type: "home-section";
  readonly key: string;
  readonly label: string;
  readonly tone: "default" | "attention";
  /** Set on a project's header: tap folds the section. */
  readonly projectKey?: string;
  readonly collapsed?: boolean;
  /** Threads in the project section, shown while collapsed. */
  readonly count?: number;
}

export interface HomeGroupListItem {
  readonly type: "home-group";
  readonly key: string;
  /** `environmentId:groupId`. */
  readonly groupKey: string;
  readonly projectKey: string;
  readonly title: string;
  /** Members shown in this project section, in the group's own order. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly workingCount: number;
  readonly expanded: boolean;
  readonly showTrailingDivider: boolean;
}

export type HomeListItem =
  | ThreadListV2ListItem
  | (ThreadListV2ThreadListItem & {
      readonly groupMember?: true;
      /** Sits under its project's name, so the row need not repeat it. */
      readonly underProject?: true;
    })
  | HomeSectionListItem
  | HomeGroupListItem;

export interface HomeProject {
  readonly key: string;
  readonly title: string;
}

export interface HomeThreadGroup {
  readonly key: string;
  readonly title: string;
  /** The thread's place in the group's stored order. */
  readonly index: number;
}

export interface HomeProjectSectionsInput {
  readonly items: ReadonlyArray<ThreadListV2ListItem>;
  /** False when one project is already selected: its name would repeat. */
  readonly showProjectHeaders: boolean;
  readonly projectOf: (thread: EnvironmentThreadShell) => HomeProject | null;
  /** The thread's chat group when it shows as a group (two or more live chats). */
  readonly groupOf: (thread: EnvironmentThreadShell) => HomeThreadGroup | null;
  readonly expandedGroupKeys: ReadonlySet<string>;
  /** Projects whose section shows only its header. */
  readonly collapsedProjectKeys?: ReadonlySet<string>;
  /** Arranged project keys; unlisted projects follow in list order. */
  readonly projectOrder?: ReadonlyArray<string>;
  /** Arranged row keys (groups and threads) inside projects; see `arrangeInSlots`. */
  readonly rowOrder?: ReadonlyArray<string>;
  /** While a row is dragged in Edit mode: its sibling set in the order under the finger. */
  readonly liveOrder?: { readonly siblings: string; readonly order: ReadonlyArray<string> };
}

/** Rows that reorder among each other in Edit mode, by list item key. */
export interface HomeSiblings {
  /** `pinned`, `rows:<project>` (a project's groups and threads), or `chats:<group>`. */
  readonly id: string;
  readonly keys: ReadonlyArray<string>;
}

export interface HomeProjectSections {
  readonly items: HomeListItem[];
  /** Projects in display order, for arranging them. */
  readonly projects: ReadonlyArray<HomeProject>;
  /** Each arrangeable row's siblings, keyed by the row's list item key. */
  readonly siblings: ReadonlyMap<string, HomeSiblings>;
}

function needsUser(thread: EnvironmentThreadShell): boolean {
  const status = resolveThreadListV2Status(thread);
  return status === "approval" || status === "input";
}

function withMoves(
  entry: ThreadListV2ThreadListItem,
  canMoveUp: boolean,
  canMoveDown: boolean,
): ThreadListV2ThreadListItem {
  return entry.canMoveUp === canMoveUp && entry.canMoveDown === canMoveDown
    ? entry
    : { ...entry, canMoveUp, canMoveDown };
}

/** Ranked keys first, in their saved order; the rest keep their incoming order. */
function arrange<T>(
  values: ReadonlyArray<T>,
  keyOf: (value: T) => string,
  order?: ReadonlyArray<string>,
): T[] {
  if (order === undefined || order.length === 0) return [...values];
  const rank = new Map(order.map((key, index) => [key, index]));
  return values
    .map((value, index) => ({ value, index, rank: rank.get(keyOf(value)) ?? Infinity }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ value }) => value);
}

/**
 * Arranged rows trade places among the slots they already hold, in their saved
 * order; unarranged rows keep their natural slot. A new thread therefore still
 * appears where the list would put it, instead of sinking below arranged ones.
 */
function arrangeInSlots<T>(
  values: ReadonlyArray<T>,
  keyOf: (value: T) => string,
  order?: ReadonlyArray<string>,
): T[] {
  if (order === undefined || order.length === 0) return [...values];
  const rank = new Map(order.map((key, index) => [key, index]));
  const ranked = values
    .filter((value) => rank.has(keyOf(value)))
    .sort((left, right) => rank.get(keyOf(left))! - rank.get(keyOf(right))!);
  let next = 0;
  return values.map((value) => (rank.has(keyOf(value)) ? ranked[next++]! : value));
}

type ProjectRow =
  | { readonly kind: "thread"; readonly key: string; readonly entry: ThreadListV2ThreadListItem }
  | {
      readonly kind: "group";
      readonly key: string;
      readonly groupKey: string;
      readonly title: string;
      readonly members: ReadonlyArray<ThreadListV2ThreadListItem>;
    };

/**
 * Regroups the leading card block (pinned + active) of the flat v2 list:
 * Needs you first, then Pinned, then one section per project. Inside a
 * project, chat groups and ungrouped threads share one order, as on desktop;
 * a group with two or more chats in the section collapses into one row placed
 * where its first chat would be. Pending tasks and the shelves stay as they were.
 */
export function buildHomeProjectSections(input: HomeProjectSectionsInput): HomeProjectSections {
  let leadEnd = 0;
  while (leadEnd < input.items.length) {
    const entry = input.items[leadEnd]!;
    if (entry.type !== "v2-thread" || entry.item.variant !== "card" || entry.item.snoozed) break;
    leadEnd += 1;
  }
  const lead = input.items.slice(0, leadEnd) as ThreadListV2ThreadListItem[];
  const pinned = lead.filter((entry) => entry.item.pinned);
  const active = lead.filter((entry) => !entry.item.pinned);
  const needs = active
    .filter((entry) => needsUser(entry.item.thread))
    .map((entry) => withMoves(entry, false, false));
  const others = active.filter((entry) => !needsUser(entry.item.thread));

  const siblings = new Map<string, HomeSiblings>();
  const live = <T>(id: string, values: ReadonlyArray<T>, keyOf: (value: T) => string): T[] => {
    const ordered =
      input.liveOrder?.siblings === id
        ? arrange(values, keyOf, input.liveOrder.order)
        : [...values];
    if (ordered.length > 1) {
      const set = { id, keys: ordered.map(keyOf) };
      for (const value of ordered) siblings.set(keyOf(value), set);
    }
    return ordered;
  };

  const result: HomeListItem[] = [];
  const hasSections = needs.length > 0 || pinned.length > 0;
  if (needs.length > 0) {
    result.push({
      type: "home-section",
      key: "home-section:needs",
      label: "Needs you",
      tone: "attention",
    });
    result.push(...needs);
  }
  if (pinned.length > 0) {
    if (needs.length > 0 || others.length > 0) {
      result.push({
        type: "home-section",
        key: "home-section:pinned",
        label: "Pinned",
        tone: "default",
      });
    }
    result.push(...live("pinned", pinned, (entry) => entry.key));
  }

  const buckets = new Map<string, { title: string; entries: ThreadListV2ThreadListItem[] }>();
  for (const entry of others) {
    const project = input.projectOf(entry.item.thread);
    const key = project?.key ?? "";
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { title: project?.title ?? "Other", entries: [] };
      buckets.set(key, bucket);
    }
    bucket.entries.push(entry);
  }
  const projects = arrange(
    [...buckets].map(([key, bucket]) => ({ key, title: bucket.title, entries: bucket.entries })),
    (project) => project.key,
    input.projectOrder,
  );

  for (const project of projects) {
    const collapsed =
      input.showProjectHeaders && input.collapsedProjectKeys?.has(project.key) === true;
    if (input.showProjectHeaders || hasSections) {
      result.push({
        type: "home-section",
        key: `home-section:project:${project.key}`,
        label: input.showProjectHeaders ? project.title : "Active",
        tone: "default",
        ...(input.showProjectHeaders
          ? { projectKey: project.key, collapsed, count: project.entries.length }
          : {}),
      });
    }

    const groupMembers = new Map<
      string,
      { title: string; members: Array<{ entry: ThreadListV2ThreadListItem; index: number }> }
    >();
    for (const entry of project.entries) {
      const group = input.groupOf(entry.item.thread);
      if (group === null) continue;
      const known = groupMembers.get(group.key) ?? { title: group.title, members: [] };
      known.members.push({ entry, index: group.index });
      groupMembers.set(group.key, known);
    }
    const natural: ProjectRow[] = [];
    const placed = new Set<string>();
    for (const entry of project.entries) {
      const group = input.groupOf(entry.item.thread);
      const known = group === null ? undefined : groupMembers.get(group.key);
      if (group === null || known === undefined || known.members.length < 2) {
        natural.push({ kind: "thread", key: entry.key, entry });
        continue;
      }
      if (placed.has(group.key)) continue;
      placed.add(group.key);
      natural.push({
        kind: "group",
        key: `home-group:${group.key}`,
        groupKey: group.key,
        title: known.title,
        members: [...known.members]
          .sort((left, right) => left.index - right.index)
          .map((member) => member.entry),
      });
    }
    const rows = live(
      `rows:${project.key}`,
      arrangeInSlots(natural, (row) => row.key, input.rowOrder),
      (row) => row.key,
    );
    if (collapsed) continue;

    for (const [index, row] of rows.entries()) {
      if (row.kind === "thread") {
        // Move up/down step through the project's rows, groups included.
        const moved = withMoves(row.entry, index > 0, index < rows.length - 1);
        result.push(input.showProjectHeaders ? { ...moved, underProject: true as const } : moved);
        continue;
      }
      const expanded = input.expandedGroupKeys.has(row.groupKey);
      result.push({
        type: "home-group",
        key: row.key,
        groupKey: row.groupKey,
        projectKey: project.key,
        title: row.title,
        threads: row.members.map((member) => member.item.thread),
        workingCount: row.members.filter(
          (member) => resolveThreadListV2Status(member.item.thread) === "working",
        ).length,
        expanded,
        showTrailingDivider: false,
      });
      if (!expanded) continue;
      const members = live(`chats:${row.groupKey}`, row.members, (member) => member.key);
      result.push(
        ...members.map((member) => ({
          ...withMoves(member, false, false),
          groupMember: true as const,
          ...(input.showProjectHeaders ? { underProject: true as const } : {}),
        })),
      );
    }
  }

  result.push(...input.items.slice(leadEnd));
  return {
    items: stampDividers(result),
    projects: projects.map(({ key, title }) => ({ key, title })),
    siblings,
  };
}

/** Same hairline rule as the flat list: a row draws one when another row follows. */
function stampDividers(result: HomeListItem[]): HomeListItem[] {
  return result.map((entry, index) => {
    if (entry.type !== "v2-thread" && entry.type !== "v2-pending" && entry.type !== "home-group") {
      return entry;
    }
    const next = result[index + 1];
    const showTrailingDivider =
      next?.type === "v2-thread" ||
      next?.type === "home-group" ||
      (next?.type === "v2-pending" && !next.showPendingDivider);
    return showTrailingDivider === entry.showTrailingDivider
      ? entry
      : { ...entry, showTrailingDivider };
  });
}

/** Moves `key` one step in `keys` and returns the new full order, or null at an edge. */
export function moveKey(
  keys: ReadonlyArray<string>,
  key: string,
  direction: "up" | "down",
): string[] | null {
  const from = keys.indexOf(key);
  const to = from + (direction === "up" ? -1 : 1);
  if (from < 0 || to < 0 || to >= keys.length) return null;
  const next = [...keys];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

/**
 * Saves a new arrangement of `visible` keys into a stored order that may also
 * hold keys not shown right now (another environment, a filtered project).
 * Visible keys take the slots they held, so hidden ones keep their place.
 */
export function mergeArrangedKeys(
  stored: ReadonlyArray<string>,
  visible: ReadonlyArray<string>,
  arranged: ReadonlyArray<string>,
): string[] {
  const visibleSet = new Set(visible);
  const result = stored.filter((key) => !visibleSet.has(key));
  const firstSlot = stored.findIndex((key) => visibleSet.has(key));
  result.splice(firstSlot < 0 ? result.length : firstSlot, 0, ...arranged);
  return result;
}

export function homeListItemsAreEqual(
  previous: HomeListItem,
  item: HomeListItem,
  threadItemsAreEqual: (previous: ThreadListV2ListItem, item: ThreadListV2ListItem) => boolean,
): boolean {
  if (item.type === "home-section") {
    return (
      previous.type === "home-section" &&
      previous.key === item.key &&
      previous.label === item.label &&
      previous.tone === item.tone &&
      previous.projectKey === item.projectKey &&
      previous.collapsed === item.collapsed &&
      previous.count === item.count
    );
  }
  if (item.type === "home-group") {
    return (
      previous.type === "home-group" &&
      previous.key === item.key &&
      previous.title === item.title &&
      previous.expanded === item.expanded &&
      previous.workingCount === item.workingCount &&
      previous.showTrailingDivider === item.showTrailingDivider &&
      previous.threads.length === item.threads.length &&
      previous.threads.every((thread, index) => thread === item.threads[index])
    );
  }
  if (previous.type === "home-section" || previous.type === "home-group") return false;
  if (
    item.type === "v2-thread" &&
    previous.type === "v2-thread" &&
    ("groupMember" in previous !== "groupMember" in item ||
      "underProject" in previous !== "underProject" in item)
  ) {
    return false;
  }
  return threadItemsAreEqual(previous, item);
}
