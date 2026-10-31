/**
 * The rules of play that need no database (D-063, D-064, D-180, D-187, D-188): whether a locked
 * pick is right, what a lock adds to a Scroll's sparks and combo, and the finish of a landmark.
 * The device works the same rules out in `scroll-model` (`afterLock`, `landmarkTier`) to show play at
 * once; this is the server's own copy, which judges every lock, and `results.test.ts` runs the two
 * over every run of calls and checks they agree. A domain file imports no package, so it cannot share
 * the code.
 *
 * Nothing here is learning, interest or belief. A pick is a move in a game the person chose to
 * play; its correctness is shown back to them and goes nowhere else.
 */

/** A call as the server judges it: how many options it has and which one is right. */
export interface JudgedCall {
  readonly optionCount: number;
  /** Zero-based index of the right option. */
  readonly answer: number;
}

export type Judgement =
  { readonly kind: 'judged'; readonly correct: boolean } | { readonly kind: 'option_out_of_range' };

/**
 * Whether `option` is one the call offers, and if so whether it is the right one. An option the
 * call does not have is a forged request, never a wrong answer: it is refused, and nothing is
 * stored.
 */
export function judgePick(call: JudgedCall, option: number): Judgement {
  if (!Number.isInteger(option) || option < 0 || option >= call.optionCount) return { kind: 'option_out_of_range' };
  return { kind: 'judged', correct: option === call.answer };
}

/** What a person has earned on one Scroll revision so far. */
export interface Tally {
  readonly callsLocked: number;
  /** One for each right call. */
  readonly sparks: number;
  /** Right calls in a row, in the order they were locked. */
  readonly combo: number;
}

export const NO_PLAY: Tally = { callsLocked: 0, sparks: 0, combo: 0 };

/** A lock as the tally counts it: whether it was right, and whether it was the Final call. */
export interface LockOutcome {
  readonly correct: boolean;
  readonly finalCall: boolean;
}

/** The combo a person must hold going into the Final call for a right answer to earn the bonus. */
const COMBO_FOR_FINAL_BONUS = 2;

/** The sparks one lock earns: one for a right call, two for a right Final call after a combo of two or more. */
function sparksEarned(lock: LockOutcome, comboBefore: number): number {
  if (!lock.correct) return 0;
  return lock.finalCall && comboBefore >= COMBO_FOR_FINAL_BONUS ? 2 : 1;
}

/**
 * The tally after one more call is locked. A right call earns a spark and extends the combo; a
 * right Final call after a combo of two or more earns two; a wrong call only ends the combo.
 */
export function afterLock(tally: Tally, lock: LockOutcome): Tally {
  return {
    callsLocked: tally.callsLocked + 1,
    sparks: tally.sparks + sparksEarned(lock, tally.combo),
    combo: lock.correct ? tally.combo + 1 : 0,
  };
}

/** The finish of a landmark: gold for a right Final call, plain for any other. */
export type LandmarkTier = 'gold' | 'plain';

/** The finish of the landmark a locked Final call awards. A call is locked once, so "first try" is "right when locked". */
export function landmarkTierOf(finalCall: LockOutcome): LandmarkTier {
  return finalCall.correct ? 'gold' : 'plain';
}
