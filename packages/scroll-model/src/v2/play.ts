/**
 * The tally of a Scroll's calls, as a device works it out (D-064, D-180): a right call earns one
 * spark and extends the combo, a wrong call earns nothing, ends the combo and costs nothing.
 *
 * The server keeps its own copy of this rule and judges every lock from the stored revision; this
 * one lets the screen show sparks and combo at once, and while recording is paused, when nothing is
 * stored. They are tested to agree. A tally belongs to one Scroll: nothing here sums across Scrolls,
 * and no function turns it into a level.
 */
export interface CallTally {
  /** One for each right call. */
  readonly sparks: number;
  /** Right calls in a row, in the order locked. */
  readonly combo: number;
}

export const NO_TALLY: CallTally = { sparks: 0, combo: 0 };

/** The tally after each lock, in the order locked: element `n` is what the person had after their `n`-th call. */
export function talliesAfterEach(locks: readonly { readonly correct: boolean }[]): readonly CallTally[] {
  const tallies: CallTally[] = [];
  let tally = NO_TALLY;
  for (const lock of locks) {
    tally = lock.correct ? { sparks: tally.sparks + 1, combo: tally.combo + 1 } : { sparks: tally.sparks, combo: 0 };
    tallies.push(tally);
  }
  return tallies;
}

/** What the person has after all of their locks. */
export function tallyOf(locks: readonly { readonly correct: boolean }[]): CallTally {
  return talliesAfterEach(locks).at(-1) ?? NO_TALLY;
}
