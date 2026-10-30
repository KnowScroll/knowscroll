import type { CallItStop, FinalCallStop } from '@knowscroll/scroll-model';
import type { StageKeeping } from './stage-play';

/**
 * A call as the reader shows it: the option picked, and whether the answer has been revealed (a lock
 * in). Keeping a lock, and the sparks it earns, are the play layer's (`stage-play.ts`, D-063); the one
 * thing the reader reports is that the answer was shown, by kind and never by the option picked.
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

/** What the screen says about whether a locked call is kept, or nothing when there is nothing to say. */
export function keepingNote(keeping: StageKeeping): string | undefined {
  switch (keeping) {
    case 'recording_paused':
      return 'Not saved while recording is paused.';
    case 'waiting':
      return "Will save when you're back online.";
    case 'refused':
      return "Couldn't save this one.";
    case 'saved':
    case 'device_only':
      return undefined;
  }
}
