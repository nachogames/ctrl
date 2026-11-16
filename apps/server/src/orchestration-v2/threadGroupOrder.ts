import { type GroupOrderItem, orderGroupMembers } from "@t3tools/shared/groupOrder";
import { generateSpreadPinOrderKeys, pinOrderKeyBetween } from "@t3tools/shared/pinOrderKey";

export interface GroupOrderAssignment<Id extends string> {
  readonly threadId: Id;
  readonly key: string;
}

const keysOf = (members: ReadonlyArray<GroupOrderItem>) =>
  members.flatMap((member) => (member.groupOrderKey == null ? [] : [member.groupOrderKey]));

/**
 * Keys a join writes so the joiner (not in `members`) shows first: one key in a
 * fully keyed group, none when it already leads as the newest keyless chat,
 * else spread keys. Write in order: bottom-up, ending with the joiner.
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
 * Spread keys over `order`, bottom-up: keyless chats sort above keyed ones, so
 * other clients never see rows reshuffle mid-write. `last` is written last, so
 * a retry that finds it unkeyed re-plans from what was written.
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
 * Keys a handoff writes so the new chat (in `members`) sits above its source:
 * none for unordered groups, one for a keyed source, else spread keys in
 * display order. Write in order: bottom-up, ending with the new chat.
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
