import { foldName } from '../universe/universe-search';

/**
 * What you and a friend have in common, as names on this device (Round 7.3, "What we have in common").
 *
 * The friend's public list carries labels, never ids that mean anything on your side, so two systems are "the same" when
 * their names are, once folded as search folds a name (`foldName`: accents and case taken off, spaces made single):
 * "Café" and "cafe" are one name. Nothing leaves the device and nothing is kept: both lists are read from memory, and the answer is a pure
 * function of them. It carries no count that ranks, no score and no order of "more" or "less".
 */

/** The least a friend's system must carry to be compared: its name. A `VisitedSystem` is one. */
export interface NamedSystem {
  readonly label: string;
}

/**
 * The friend's systems whose name is also the name of one of your own systems, in the friend's own order and each
 * as the friend's entry (so the caller keeps its public id). Two systems of the friend that share one name are both
 * returned: each is a system of theirs you have. Duplicates among your names change nothing. A name that folds to
 * nothing (blank, or only marks) is never a match, so an unnamed system is not "in common" with another.
 *
 * The crossing film drifts these names past you: `systemsInCommon(own, friend.systems).map((system) => system.label)`.
 */
export function systemsInCommon<T extends NamedSystem>(
  ownLabels: readonly string[],
  friendSystems: readonly T[],
): readonly T[] {
  const own = new Set(ownLabels.map(foldName));
  own.delete('');
  return friendSystems.filter((system) => own.has(foldName(system.label)));
}
