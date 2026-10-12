export interface GroupOrderItem<Id extends string = string> {
  readonly id: Id;
  readonly createdAtMs: number;
  readonly handedOffFrom: string | null | undefined;
  readonly groupOrderKey: string | null | undefined;
}

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * A group's display order. Chats with no stored key come first, as handoff
 * chains read newest to oldest (a successor sits directly above its source)
 * and chains ordered by their newest member. Keyed chats follow, ascending by
 * key. Links that loop or point outside the keyless chats never drop a chat.
 */
export function orderGroupMembers<Id extends string>(
  items: ReadonlyArray<GroupOrderItem<Id>>,
): ReadonlyArray<Id> {
  const keyed = items
    .filter((item) => item.groupOrderKey != null)
    .toSorted(
      (left, right) =>
        compareText(left.groupOrderKey ?? "", right.groupOrderKey ?? "") ||
        compareText(left.id, right.id),
    );
  const newestFirst = (left: GroupOrderItem<Id>, right: GroupOrderItem<Id>) =>
    right.createdAtMs - left.createdAtMs || compareText(left.id, right.id);
  const keyless = items.filter((item) => item.groupOrderKey == null).toSorted(newestFirst);

  const ids = new Set<string>(keyless.map((item) => item.id));
  const successors = new Map<string, Array<GroupOrderItem<Id>>>();
  for (const item of keyless) {
    const source = item.handedOffFrom;
    if (source == null || source === item.id || !ids.has(source)) continue;
    const list = successors.get(source) ?? [];
    list.push(item);
    successors.set(source, list);
  }

  const seen = new Set<string>();
  // Successors (and theirs) first, then the chat itself.
  const collect = (item: GroupOrderItem<Id>, chain: Array<GroupOrderItem<Id>>) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    for (const next of successors.get(item.id) ?? []) collect(next, chain);
    chain.push(item);
  };
  const chains: Array<Array<GroupOrderItem<Id>>> = [];
  const startChain = (root: GroupOrderItem<Id>) => {
    const chain: Array<GroupOrderItem<Id>> = [];
    collect(root, chain);
    if (chain.length > 0) chains.push(chain);
  };
  for (const item of keyless) {
    if (item.handedOffFrom == null || !ids.has(item.handedOffFrom)) startChain(item);
  }
  // Chats in a handoff loop have no root; keep them, newest first.
  for (const item of keyless) startChain(item);

  const newestOf = (chain: ReadonlyArray<GroupOrderItem<Id>>) =>
    chain.reduce((newest, item) => (newestFirst(item, newest) < 0 ? item : newest));
  return [
    ...chains.toSorted((left, right) => newestFirst(newestOf(left), newestOf(right))).flat(),
    ...keyed,
  ].map((item) => item.id);
}
