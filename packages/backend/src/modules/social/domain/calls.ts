import { placeProgress, shownPlaces, type PlaceMember, type PlaceRow } from './places.js';
import { canTakePart } from './threads.js';

/**
 * Rules of "Call it together" that need no database, clock or crypto (D-155 to D-157).
 *
 * A call is one question of one part of a thread's series. Each member locks one pick before they start the
 * part, and nobody sees another member's pick until they have locked their own and the party has finished the
 * part. A pick is a play result (D-063): these rules return what to show the reader and read nothing about
 * what anyone watched, so no pick or right answer can leave through them.
 */

/** A call that no one has finished opens by itself on this UTC day after the first lock (D-155). */
export const REVEAL_AFTER_DAYS = 2;

/** The common guess is shown only once this many calls were locked across every thread (D-157). */
export const COMMON_GUESS_MIN_CALLS = 30;

/** One stored lock: who, which option, and the UTC day. Never a time of day. */
export interface CallLockRow {
  readonly accountId: string;
  readonly option: number;
  /** A UTC calendar day, `YYYY-MM-DD`. */
  readonly day: string;
}

/** The calendar day `days` after `day`, both as `YYYY-MM-DD`. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The call a thread offers for a Scroll: its first Call it. The Final call is a different moment (D-126, D-187). */
export function threadCallOf<C extends { readonly kind: 'call_it' | 'final_call' }>(
  calls: readonly C[],
): C | undefined {
  return calls.find((call) => call.kind === 'call_it');
}

/** A member's pick as the reader may see it after the reveal. */
export interface ShownPick<M> {
  readonly member: M;
  readonly option: number;
  readonly right: boolean;
}

interface Counted {
  /** Members the reader may count: they take part and neither side of a block with the reader. */
  readonly of: number;
  /** How many of them have locked. */
  readonly called: number;
}

/**
 * What one reader may see of one call.
 * - `open`: they have not locked and may. Counts only.
 * - `locked`: they locked; the others stay hidden. Counts and their own pick.
 * - `revealed`: they locked and the party has finished (or the clock ran out): everyone's picks.
 * - `closed`: they never locked and now may not: they started the part, or the call was revealed without them.
 */
export type CallView<M> =
  | ({ readonly stage: 'open' } & Counted)
  | ({ readonly stage: 'locked'; readonly option: number } & Counted)
  | ({
      readonly stage: 'revealed';
      readonly option: number;
      readonly picks: readonly ShownPick<M>[];
      readonly rightCount: number;
    } & Counted)
  | ({ readonly stage: 'closed'; readonly reason: 'started' | 'revealed' } & Counted);

export interface CallInput<M extends PlaceMember> {
  readonly readerAccountId: string;
  /** The part of the series this call comes before. */
  readonly part: number;
  /** Zero-based index of the right option, from the immutable revision. */
  readonly answer: number;
  readonly members: readonly M[];
  /** Every lock of this call in this thread. */
  readonly locks: readonly CallLockRow[];
  /** Every stored place of the thread. */
  readonly places: readonly PlaceRow[];
  /** Accounts the reader blocked or that blocked the reader. */
  readonly blockedWithReader: ReadonlySet<string>;
  /** The server's own UTC day. */
  readonly today: string;
  readonly nameOf: (member: M) => string;
}

/**
 * The reveal rule (D-155). The party reveals when everyone the reader can see who shares where they are has
 * finished the part, or on the second UTC day after the first lock, whichever is first, and only once someone
 * has locked. It never waits for a pick: a member who does not call cannot hold the others back, and one who
 * shares a place but never finishes holds them for two days at most. A member who hides, left, was removed
 * or is blocked either way with the reader is not waited for. Locking closes once the party has revealed or
 * the reader's own place says they started the part, so a pick is always a guess made before the part.
 */
export function viewCall<M extends PlaceMember>(input: CallInput<M>): CallView<M> {
  const { readerAccountId, part } = input;
  const present = input.members.filter(
    (member) =>
      canTakePart(member) && (member.accountId === readerAccountId || !input.blockedWithReader.has(member.accountId)),
  );
  const presentIds = new Set(present.map((member) => member.accountId));
  const locks = input.locks.filter((lock) => presentIds.has(lock.accountId));
  const counted = { of: present.length, called: locks.length };
  const own = locks.find((lock) => lock.accountId === readerAccountId);

  const sharing = shownPlaces({
    readerAccountId,
    members: input.members,
    rows: input.places,
    blockedWithReader: input.blockedWithReader,
    nameOf: input.nameOf,
  });
  const finishedPart = part * 2 + 1;
  const stillOnTheWay = sharing.some(({ place }) => placeProgress(place) < finishedPart);
  const firstDay = locks.map((lock) => lock.day).toSorted()[0];
  const timedOut = firstDay !== undefined && input.today >= addDays(firstDay, REVEAL_AFTER_DAYS);
  const partyDone = sharing.length > 0 && !stillOnTheWay;
  const revealed = locks.length > 0 && (partyDone || timedOut);

  if (own === undefined) {
    if (revealed) return { stage: 'closed', reason: 'revealed', ...counted };
    const ownPlace = sharing.find(({ member }) => member.accountId === readerAccountId)?.place;
    if (ownPlace !== undefined && placeProgress(ownPlace) >= part * 2) {
      return { stage: 'closed', reason: 'started', ...counted };
    }
    return { stage: 'open', ...counted };
  }
  if (!revealed) return { stage: 'locked', option: own.option, ...counted };

  const byAccount = new Map(present.map((member) => [member.accountId, member]));
  const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  const picks = locks
    .map((lock) => ({
      member: byAccount.get(lock.accountId)!,
      option: lock.option,
      right: lock.option === input.answer,
    }))
    .toSorted(
      (left, right) =>
        left.option - right.option ||
        compare(input.nameOf(left.member), input.nameOf(right.member)) ||
        compare(left.member.accountId, right.member.accountId),
    );
  return {
    stage: 'revealed',
    option: own.option,
    picks,
    rightCount: picks.filter((pick) => pick.right).length,
    ...counted,
  };
}

/**
 * The most common pick across every thread, when there are enough calls to say so without pointing at anyone
 * (D-157): the leading option and its share of all calls, in whole percent. Nothing below the threshold, and
 * nothing when two options lead together. It carries no count of people and no one's pick.
 */
export function commonGuess(
  countsByOption: readonly number[],
): { readonly option: number; readonly percent: number } | undefined {
  const total = countsByOption.reduce((sum, count) => sum + count, 0);
  if (total < COMMON_GUESS_MIN_CALLS) return undefined;
  const lead = Math.max(...countsByOption);
  const leaders = countsByOption.flatMap((count, option) => (count === lead ? [option] : []));
  if (leaders.length !== 1) return undefined;
  return { option: leaders[0]!, percent: Math.round((100 * lead) / total) };
}
