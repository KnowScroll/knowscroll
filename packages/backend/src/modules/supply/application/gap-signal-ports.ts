import type { PersonalScopeTx } from '../../identity/public.js';
import type { GapTarget, SignalSource } from '../domain/gaps.js';

/** A signal the system noticed where it already knew it: a planet, a facet when known, and who noticed. Counts only, never words. */
export interface GapSignalInput extends GapTarget {
  readonly source: SignalSource;
}

/**
 * Records signals inside a personal transaction that already knows them (a Composer decision, a planned demand, an ask). Each
 * signal is the person's own mark for the UTC day, at most one for each gap and day, so the scan counts each reader once. It
 * locks no shared row and calls no model; where the loop is off it does nothing. A name the catalogue does not hold is dropped.
 */
export type RecordGapSignals = (scope: PersonalScopeTx, signals: readonly GapSignalInput[]) => Promise<void>;

/** The private store of marks (`supply.gap_signal_marks`): the person's own rows, in the caller's transaction. */
export interface GapMarkStore {
  /** Writes the marks for `day`; a mark that exists (same gap, same day) is not written again. */
  mark(scope: PersonalScopeTx, day: string, signals: readonly GapSignalInput[]): Promise<void>;
}
