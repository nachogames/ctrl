import { type GroupOrderItem, orderGroupMembers } from "@t3tools/shared/groupOrder";
import { generateSpreadPinOrderKeys, pinOrderKeyBetween } from "@t3tools/shared/orderKeys";

export interface GroupOrderAssignment<Id extends string> {
  readonly threadId: Id;
  readonly key: string;
}

const keysOf = (members: ReadonlyArray<GroupOrderItem>) =>
  members.flatMap((member) => (member.groupOrderKey == null ? [] : [member.groupOrderKey]));

/**
 * The key for a chat joining the group: before the group's first key, so it
 * lands at the top. Null for an unordered group, where a keyless joiner is
 * already on top as the newest, and for corrupt keys.
 */
export function planGroupJoinKey(members: ReadonlyArray<GroupOrderItem>): string | null {
  const keys = keysOf(members);
  if (keys.length === 0) return null;
  const first = keys.reduce((min, key) => (key < min ? key : min));
  return pinOrderKeyBetween(null, first);
}

/**
 * The keys a handoff writes so the new chat sits directly above its source.
 * Unordered groups need none. A keyed source gets one key for the new chat;
 * otherwise the whole group gets spread keys in its display order with the
 * new chat inserted above the source. Members must include the new chat.
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
  const spread = generateSpreadPinOrderKeys(order.length);
  const current = new Map(members.map((member) => [member.id, member.groupOrderKey ?? null]));
  return order.flatMap((threadId, index) => {
    const key = spread[index];
    return key === undefined || current.get(threadId) === key ? [] : [{ threadId, key }];
  });
}
