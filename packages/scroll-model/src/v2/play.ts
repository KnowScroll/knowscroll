/**
 * The tally of a Scroll's calls, as a device works it out (D-064, D-180, D-187): a right call earns
 * one spark and extends the combo, a wrong call earns nothing, ends the combo and costs nothing. A
 * right Final call that follows a combo of two or more earns a second spark (the combo bonus).
 *
 * The server judges every lock from the stored revision with this same rule (`modules/play` calls
 * `sparksEarned`), and the screen uses it to show sparks and combo at once and while recording is
 * paused, when nothing is stored. A test runs both over every run of right and wrong calls. A tally
 * belongs to one Scroll: nothing here sums across Scrolls, and no function turns it into a level.
 */
export interface CallTally {
  /** One for each right call, and one more for a right Final call after a combo of two or more. */
  readonly sparks: number;
  /** Right calls in a row, in the order locked. The Final call counts like any other call. */
  readonly combo: number;
}

export const NO_TALLY: CallTally = { sparks: 0, combo: 0 };

/** A call as it was locked: whether it was right, and whether it was the Final call. */
export interface LockedCall {
  readonly correct: boolean;
  /** True for the Final call, the one call the combo can double. */
  readonly finalCall?: boolean;
}

/** The combo a person must hold going into the Final call for a right answer to earn the bonus ("combo ×2 doubles it"). */
export const COMBO_FOR_FINAL_BONUS = 2;

/** The sparks one lock earns, given the combo the person held before it. */
export function sparksEarned(lock: LockedCall, comboBefore: number): number {
  if (!lock.correct) return 0;
  return lock.finalCall === true && comboBefore >= COMBO_FOR_FINAL_BONUS ? 2 : 1;
}

/** Whether a right Final call would earn the bonus now: shown as "Combo ×2 doubles this one" before it is locked. */
export function finalBonusReady(comboBefore: number): boolean {
  return comboBefore >= COMBO_FOR_FINAL_BONUS;
}

/** The tally after one more call is locked. */
export function afterLock(tally: CallTally, lock: LockedCall): CallTally {
  return {
    sparks: tally.sparks + sparksEarned(lock, tally.combo),
    combo: lock.correct ? tally.combo + 1 : 0,
  };
}

/** The tally after each lock, in the order locked: element `n` is what the person had after their `n`-th call. */
export function talliesAfterEach(locks: readonly LockedCall[]): readonly CallTally[] {
  const tallies: CallTally[] = [];
  let tally = NO_TALLY;
  for (const lock of locks) {
    tally = afterLock(tally, lock);
    tallies.push(tally);
  }
  return tallies;
}

/** What the person has after all of their locks. */
export function tallyOf(locks: readonly LockedCall[]): CallTally {
  return talliesAfterEach(locks).at(-1) ?? NO_TALLY;
}

/** The finish of a landmark: gold for a right Final call, plain for any other (D-188). */
export type LandmarkTier = 'gold' | 'plain';

/**
 * The tier a landmark is awarded at. A call is locked once and never retried, so "right the first
 * time" is "right when locked". A wrong Final call still earns the landmark, in the plain finish.
 */
export function landmarkTier(finalCallCorrect: boolean): LandmarkTier {
  return finalCallCorrect ? 'gold' : 'plain';
}
