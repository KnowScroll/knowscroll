/**
 * The friends of the outer stop, and the one place that says in what order they take their places. The roster reads
 * them oldest profile first (the server lists friends by person id, a time-ordered id made when that friend made their
 * profile); the owner's leaning (A) is to keep that order. A place is a pure function of the order, so changing the
 * order later (a device ledger of "the order you met") is a change to `orderFriends` alone.
 */

/** A friend as the outer stop knows them: no presence, nothing the Friends list does not already show. */
export interface OuterFriend {
  readonly personId: string;
  readonly handle: string;
  /** The display name. */
  readonly name: string;
}

/** The friends in the order they take their places (option A: the roster's own order). A new array; the input is not changed. */
export function orderFriends(roster: readonly OuterFriend[]): readonly OuterFriend[] {
  return [...roster];
}
