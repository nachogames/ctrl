import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import type { ThreadId } from "@t3tools/contracts";

type CommandResult = AtomCommandResult<unknown, unknown>;
type CommandFailure = Extract<CommandResult, { readonly _tag: "Failure" }>;

const firstFailure = (results: ReadonlyArray<CommandResult>): CommandFailure | null =>
  results.find(
    (result): result is CommandFailure =>
      result._tag === "Failure" && !isAtomCommandInterrupted(result),
  ) ?? null;

/**
 * Settle or un-settle a group: stamp (or clear) its `settledAt`, then move
 * every member whose state differs. Members change only after the group
 * change landed. The returned undo reverses both halves together: it puts the
 * previous `settledAt` back and flips exactly the members this call changed.
 */
export async function applyThreadGroupSettlement(input: {
  readonly settled: boolean;
  readonly now: string;
  readonly previousSettledAt: string | null;
  readonly members: ReadonlyArray<{
    readonly id: ThreadId;
    readonly settledOverride: "settled" | "active" | null;
  }>;
  /** False where the environment cannot settle chats: only the group changes. */
  readonly settleMembers: boolean;
  readonly patchSettledAt: (settledAt: string | null) => Promise<CommandResult>;
  readonly setMemberSettled: (threadId: ThreadId, settled: boolean) => Promise<CommandResult>;
}): Promise<
  | { readonly kind: "group-failed"; readonly result: CommandFailure }
  | {
      readonly kind: "applied";
      /** First member that did not move, if any; the others did. */
      readonly memberFailure: CommandFailure | null;
      readonly undo: () => Promise<CommandResult>;
    }
> {
  const { settled } = input;
  const groupResult = await input.patchSettledAt(settled ? input.now : null);
  if (groupResult._tag === "Failure") return { kind: "group-failed", result: groupResult };
  const pending = input.settleMembers
    ? input.members.filter((member) => (member.settledOverride === "settled") !== settled)
    : [];
  const results = await Promise.all(
    pending.map(async (member) => ({
      id: member.id,
      result: await input.setMemberSettled(member.id, settled),
    })),
  );
  const changed = results.flatMap(({ id, result }) => (result._tag === "Success" ? [id] : []));
  return {
    kind: "applied",
    memberFailure: firstFailure(results.map(({ result }) => result)),
    undo: async () => {
      const restored = await input.patchSettledAt(input.previousSettledAt);
      if (restored._tag !== "Success") return restored;
      const reverted = await Promise.all(
        changed.map((threadId) => input.setMemberSettled(threadId, !settled)),
      );
      return firstFailure(reverted) ?? restored;
    },
  };
}
