import { type GroupOrderItem, orderGroupMembers } from "@t3tools/shared/groupOrder";
import { generateSpreadPinOrderKeys, pinOrderKeyBetween } from "@t3tools/shared/orderKeys";

export interface GroupOrderAssignment<Id extends string> {
  readonly threadId: Id;
  readonly key: string;
}

const keysOf = (members: ReadonlyArray<GroupOrderItem>) =>
  members.flatMap((member) => (member.groupOrderKey == null ? [] : [member.groupOrderKey]));

/**
 * The keys a join writes so the joining chat shows first. In a fully keyed
 * group the joiner gets one key before the first. Otherwise none when it
 * already shows first as the newest keyless chat, else the group gets spread
 * keys with the joiner on top. `members` are the chats already in the group.
 * Write the plan in order: it runs bottom-up and ends with the joiner.
 */
export function planGroupJoin<Id extends string>(
  members: ReadonlyArray<GroupOrderItem<Id>>,
  joiner: GroupOrderItem<Id>,
): Array<GroupOrderAssignment<Id>> {
  const others = members.filter((member) => member.id !== joiner.id);
  const keyless = { ...joiner, groupOrderKey: null };
  const allKeyed = others.length > 0 && others.every((member) => member.groupOrderKey != null);
  if (allKeyed) {
    const first = keysOf(others).reduce((min, key) => (key < min ? key : min));
    const key = pinOrderKeyBetween(null, first);
    if (key !== null) return [{ threadId: joiner.id, key }];
  } else if (orderGroupMembers([...others, keyless])[0] === joiner.id) {
    return [];
  }
  return materialize([keyless, ...others], [joiner.id, ...orderGroupMembers(others)], joiner.id);
}

/**
 * Spread keys over `order`, skipping rows that already hold theirs. Writes run
 * bottom-up (last display position first): keyless chats sort above keyed
 * ones, so each written row lands below the unwritten ones in its planned
 * place and other clients never see rows reshuffle mid-write. `last` is
 * written last, so a retry that finds it unkeyed re-plans from what was written.
 */
function materialize<Id extends string>(
  members: ReadonlyArray<GroupOrderItem<Id>>,
  order: ReadonlyArray<Id>,
  last: Id,
): Array<GroupOrderAssignment<Id>> {
  const spread = generateSpreadPinOrderKeys(order.length);
  const current = new Map(members.map((member) => [member.id, member.groupOrderKey ?? null]));
  const plan = order
    .flatMap((threadId, index) => {
      const key = spread[index];
      return key === undefined || current.get(threadId) === key ? [] : [{ threadId, key }];
    })
    .toReversed();
  return [
    ...plan.filter((entry) => entry.threadId !== last),
    ...plan.filter((entry) => entry.threadId === last),
  ];
}

/**
 * The keys a handoff writes so the new chat sits directly above its source.
 * Unordered groups need none. A keyed source gets one key for the new chat;
 * otherwise the whole group gets spread keys in its display order with the
 * new chat inserted above the source. Members must include the new chat.
 * Write the plan in order: it runs bottom-up and ends with the new chat.
 */
export function planGroupInsertAbove<Id extends string>(
  members: ReadonlyArray<GroupOrderItem<Id>>,
  sourceId: Id,
  newId: Id,
): Array<GroupOrderAssignment<Id>> {
  const newMember = members.find((member) => member.id === newId);
  if (newMember?.groupOrderKey != null) return [];
  const others = members.filter((member) => member.id !== newId);
  const keys = keysOf(others);
  if (keys.length === 0) return [];

  const sourceKey = others.find((member) => member.id === sourceId)?.groupOrderKey;
  if (sourceKey != null) {
    const above = keys
      .filter((key) => key < sourceKey)
      .reduce<string | null>((max, key) => (max === null || key > max ? key : max), null);
    const key = pinOrderKeyBetween(above, sourceKey);
    if (key !== null) return [{ threadId: newId, key }];
  }

  // Keep the order the group shows now, moving only the new chat if needed.
  const order = orderGroupMembers(members).filter((id) => id !== newId);
  const sourceIndex = order.indexOf(sourceId);
  order.splice(sourceIndex === -1 ? 0 : sourceIndex, 0, newId);
  return materialize(members, order, newId);
}
