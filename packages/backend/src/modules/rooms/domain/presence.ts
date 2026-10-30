/**
 * Who is here (D-069). Pure rules over the accounts that currently hold a fresh room lease: who is
 * shown, in what order, and when a number may be said. No database, no clock.
 */

/** A number of people here is shown from this many; below it the faces speak for themselves. */
export const COUNT_FROM = 3;

export interface HereFacts {
  /** Accounts whose lease is fresh, most recently renewed first. */
  readonly present: readonly string[];
  /** The reader. They are here by definition: a person reading the room has it open. */
  readonly viewer: string;
  /** Accounts the reader has blocked; their face is masked (left out) for the reader and for nobody else. */
  readonly blocked: ReadonlySet<string>;
  /** The most faces to show; the count may be larger. */
  readonly maxFaces: number;
}

export interface Here {
  /** The reader first, then the others in the order given. */
  readonly faces: readonly string[];
  /** Present only from `COUNT_FROM` people: "1 here" and "0 here" can never be said. */
  readonly count: number | undefined;
}

/**
 * The faces and the count a reader may be told. The reader is always in it, a blocked person never is (so
 * their presence cannot be read off the count either), and the number appears only from three people.
 */
export function hereOf(facts: HereFacts): Here {
  const others = facts.present.filter((account) => account !== facts.viewer && !facts.blocked.has(account));
  const everyone = [facts.viewer, ...others];
  return {
    faces: everyone.slice(0, facts.maxFaces),
    count: everyone.length >= COUNT_FROM ? everyone.length : undefined,
  };
}
