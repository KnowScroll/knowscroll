/**
 * Flair: small marks a person earns in one room by their own acts there (v3 R-11, R3 E5, D-342, D-343). Pure: the rules say
 * which acts earn which mark and what shows beside a name; reading the acts and storing the choice are the adapters' work.
 *
 * Nothing here is a score. A mark is earned or it is not, there is no total across marks and no rank between people, and what
 * counts toward one is only what the person did in this room with their own account. An AI inhabitant, a scout and a resident
 * have no account to count, so they cannot earn one.
 */

/** What a person can earn here, in the order a card lists it (the contract's `RoomFlairKind` has the same members). */
export type FlairKind = 'first_answer' | 'good_question' | 'flaw_finder' | 'launch_regular';

export const FLAIR_ORDER: readonly FlairKind[] = ['first_answer', 'good_question', 'flaw_finder', 'launch_regular'];

/**
 * How many acts earn each mark. `first_answer` is the first time; the others are a few times, so a single lucky moment is not
 * a habit. The three is R3 E5's ("Flaw finder 2/3") and the days a Launch's answers are kept bound
 * `launch_regular`: it is a recent habit, not a trophy (D-343).
 */
export const FLAIR_NEEDED: Readonly<Record<FlairKind, number>> = {
  first_answer: 1,
  good_question: 3,
  flaw_finder: 3,
  launch_regular: 3,
};

/**
 * Whether a partway count is shown for a mark (only to the person, D-342). A count is shown only when it is made of the person's
 * own acts (their taps, their Launches). How many of their questions others marked useful is a count of marks, and an author never
 * sees one (D-168), so Good question appears only once it is earned.
 */
const SHOWS_PROGRESS: Readonly<Record<FlairKind, boolean>> = {
  first_answer: true,
  good_question: false,
  flaw_finder: true,
  launch_regular: true,
};

/**
 * What the person has done in this room, counted from rows that exist. Each count stops at what the mark needs (the adapter
 * never counts further), so a large number is never read, kept or shown.
 */
export interface FlairActs {
  /** Messages with words in Today, or in a question topic that someone else left. */
  readonly answers: number;
  /** Question topics they left whose first message another member marked useful. */
  readonly goodQuestions: number;
  /** Right taps on Spot the flaw. */
  readonly flawsFound: number;
  /** Finished Launches they answered in, among the ones whose answers are still kept. */
  readonly launchesPlayed: number;
}

const COUNT_OF: Readonly<Record<FlairKind, (acts: FlairActs) => number>> = {
  first_answer: (acts) => acts.answers,
  good_question: (acts) => acts.goodQuestions,
  flaw_finder: (acts) => acts.flawsFound,
  launch_regular: (acts) => acts.launchesPlayed,
};

/** How far the person is toward a mark, from none up to what it needs. */
export const progressOf = (kind: FlairKind, acts: FlairActs): number =>
  Math.min(FLAIR_NEEDED[kind], Math.max(0, COUNT_OF[kind](acts)));

/** The marks they have earned, in card order. */
export const earnedFlair = (acts: FlairActs): readonly FlairKind[] =>
  FLAIR_ORDER.filter((kind) => progressOf(kind, acts) >= FLAIR_NEEDED[kind]);

/**
 * The marks they have started and not earned, with how far, for the marks whose count is of their own acts (`SHOWS_PROGRESS`). A
 * mark whose first step is the whole of it (`first_answer`) never appears: there is no "0 of 1" to show. Only the person reads this.
 */
export const comingFlair = (acts: FlairActs): readonly { flair: FlairKind; have: number; of: number }[] =>
  FLAIR_ORDER.flatMap((kind) => {
    const have = progressOf(kind, acts);
    const of = FLAIR_NEEDED[kind];
    return SHOWS_PROGRESS[kind] && have > 0 && have < of ? [{ flair: kind, have, of }] : [];
  });

/** What a person chose to show beside their name. Absent (`null`) is automatic: the first mark they have earned in card order (`FLAIR_ORDER`; a mark carries no time). */
export type FlairChoice = FlairKind | 'none' | null;

/**
 * What shows beside their name. `none` hides it. A chosen mark shows only while it is earned (one that has faded, such as a
 * Launch regular who stopped playing, shows nothing rather than another mark they did not choose). Automatic shows the first earned in card order.
 */
export function shownFlair(choice: FlairChoice, earned: readonly FlairKind[]): FlairKind | undefined {
  if (choice === 'none') return undefined;
  if (choice === null) return earned[0];
  return earned.includes(choice) ? choice : undefined;
}

/** Whether a choice may be saved now: hiding and automatic always, a mark only when it is earned. */
export const mayChoose = (choice: FlairKind | 'none' | 'auto', earned: readonly FlairKind[]): boolean =>
  choice === 'none' || choice === 'auto' || earned.includes(choice);
