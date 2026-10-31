import { canTakePart, type MemberStanding } from './threads.js';

/**
 * Rules of party places that need no database, clock or crypto (D-065).
 *
 * A place is where a member of a thread says they are in its series: a part, `on` or `finished`, and
 * the day they got there. It is coarse on purpose. There is nothing here for a playhead, a branch, a
 * selected episode, a seen marker or a time of day, and no rule reads another member's exploration.
 */

export type PlaceState = 'on' | 'finished';

/** What is stored for one member of one thread. */
export interface StoredPlace {
  readonly part: number;
  readonly state: PlaceState;
  /** A UTC calendar day, `YYYY-MM-DD`. */
  readonly day: string;
}

/** The calendar day a place is dated with: the server's own UTC date, never a time. */
export const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

/** How far along a place is: finishing a part sits between being on it and being on the next. */
const progress = (place: Pick<StoredPlace, 'part' | 'state'>): number =>
  place.part * 2 + (place.state === 'finished' ? 1 : 0);

export type PlaceMove = { readonly kind: 'keep' } | { readonly kind: 'store'; readonly place: StoredPlace };

/**
 * What a reported place does to the one already stored. A place only moves forward, so reopening an
 * earlier part, or a part just finished, changes nothing and a repeat is harmless: the stored day is the
 * day the member got there, and a repeat never rewrites it.
 */
export function movePlace(
  current: StoredPlace | undefined,
  reported: Pick<StoredPlace, 'part' | 'state'>,
  today: string,
): PlaceMove {
  if (current !== undefined && progress(reported) <= progress(current)) return { kind: 'keep' };
  return { kind: 'store', place: { part: reported.part, state: reported.state, day: today } };
}

/** A member as far as places are concerned: standing in the thread and their own "hide where I am". */
export interface PlaceMember extends MemberStanding {
  readonly accountId: string;
  readonly placeHidden: boolean;
}

export interface PlaceRow extends StoredPlace {
  readonly accountId: string;
}

/**
 * The places a reader may be shown, in an order that says nothing about who arrived first (by how far
 * along, then by name). A place is listed only when its member still takes part, has not hidden it, and
 * neither blocks the reader nor is blocked by them; the reader's own place is theirs to see. Every other
 * case simply leaves the person out, so nothing says why someone is missing.
 */
export function shownPlaces<M extends PlaceMember>(input: {
  readonly readerAccountId: string;
  readonly members: readonly M[];
  readonly rows: readonly PlaceRow[];
  /** Accounts the reader blocked or that blocked the reader. */
  readonly blockedWithReader: ReadonlySet<string>;
  readonly nameOf: (member: M) => string;
}): readonly { readonly member: M; readonly place: StoredPlace }[] {
  const byAccount = new Map(input.members.map((member) => [member.accountId, member]));
  const shown = input.rows.flatMap((row) => {
    const member = byAccount.get(row.accountId);
    if (member === undefined || !canTakePart(member) || member.placeHidden) return [];
    if (member.accountId !== input.readerAccountId && input.blockedWithReader.has(member.accountId)) return [];
    return [{ member, place: { part: row.part, state: row.state, day: row.day } }];
  });
  const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  return shown.toSorted(
    (left, right) =>
      progress(left.place) - progress(right.place) ||
      compare(input.nameOf(left.member), input.nameOf(right.member)) ||
      compare(left.member.accountId, right.member.accountId),
  );
}
