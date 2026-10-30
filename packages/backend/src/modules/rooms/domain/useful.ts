/**
 * The rule of Useful (R3 B2, D-167): one mark per member per message, never on one's own message, no negative mark.
 * It is a pure decision over facts the use case read under the room lock.
 */
export interface UsefulFacts {
  /** The message exists in this discussion and is shown to the member (not removed, not a deleted account's). */
  readonly shown: boolean;
  /** The message was written by the member who is marking it. */
  readonly ownMessage: boolean;
}

/** Why a mark is refused, or `undefined` when it may be made. A removal of a mark is never refused for either reason. */
export function usefulRefusal(facts: UsefulFacts): 'not_shown' | 'own_message' | undefined {
  if (!facts.shown) return 'not_shown';
  if (facts.ownMessage) return 'own_message';
  return undefined;
}
