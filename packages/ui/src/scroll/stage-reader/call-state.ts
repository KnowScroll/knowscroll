import type { CallItStop, FinalCallStop } from '@knowscroll/scroll-model';

/**
 * A call as the reader has played it on this device. Nothing here is saved or sent: locking in,
 * sparks and the Plot twist's effects are a later slice (S-2). The one thing reported is that the
 * answer was shown, by kind and never by the option picked (D-063).
 */
export interface CallState {
  readonly picked: number | undefined;
  readonly revealed: boolean;
}

export const FRESH_CALL: CallState = { picked: undefined, revealed: false };

/** Picks an option (zero-based) while the call is open; an option the call does not have, or a pick after the reveal, changes nothing. */
export function pickOption(state: CallState, option: number, optionCount: number): CallState {
  if (state.revealed || !Number.isInteger(option) || option < 0 || option >= optionCount) return state;
  return { ...state, picked: option };
}

/** Locks in the pick and shows the answer; with nothing picked there is nothing to lock in. */
export function lockIn(state: CallState): CallState {
  return state.picked === undefined || state.revealed ? state : { ...state, revealed: true };
}

export interface CallResult {
  readonly correct: boolean;
  /** The reader picked the common wrong guess: the source label that says so is shown with the Plot twist. */
  readonly guessSource: string | undefined;
}

/** What the reveal shows, once the call is revealed. */
export function resultOf(call: CallItStop | FinalCallStop, state: CallState): CallResult | undefined {
  if (!state.revealed || state.picked === undefined) return undefined;
  const guess = call.kind === 'call_it' ? call.commonGuess : undefined;
  return {
    correct: state.picked === call.answer,
    guessSource: guess !== undefined && guess.option === state.picked ? guess.source.label : undefined,
  };
}
