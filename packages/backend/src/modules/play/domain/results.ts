/**
 * The rules of play that need no database (D-063, D-064, D-180): whether a locked pick is right,
 * and what a lock adds to a Scroll's sparks and combo.
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

/** The tally after one more call is locked. A right call earns a spark and extends the combo; a wrong one only ends it. */
export function afterLock(tally: Tally, correct: boolean): Tally {
  return {
    callsLocked: tally.callsLocked + 1,
    sparks: tally.sparks + (correct ? 1 : 0),
    combo: correct ? tally.combo + 1 : 0,
  };
}
