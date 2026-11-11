import type { InvariantId, Violation } from './invariants.js';

/**
 * Behaviour of the current code that an invariant forbids and that a later slice of #674 fixes. Each entry is a
 * named, narrow failure with the reason it fails, so CI stays green now and goes red the day a fix lands.
 *
 * The lab holds two promises about every entry:
 * - every violation of the invariant must match an entry, for a persona the entry names, or the run fails ("unexpected
 *   violation"): a new defect, or a known one failing for another reason than the one stated, cannot hide behind an entry;
 * - every entry must still be reproduced by the run as a whole (`gate/known-failures.test.ts` sums the reports of every lab
 *   file, so one file that happened to see no repeat cannot fail it): when a slice fixes the behaviour, its entry fails with
 *   "now fixed", and the slice deletes the entry in the same PR. That is how the check flips from expected failure to a gate.
 *
 * To add one, state the invariant, the slice that will fix it, why it fails today, and a `matches` that accepts only
 * violations that fail for that reason. Nothing here is a threshold or a number: `matches` reads the cause the lab
 * recorded in the violation's `detail`.
 */
export interface KnownFailure {
  readonly id: string;
  readonly invariant: InvariantId;
  /** The #674 slice that fixes it. */
  readonly slice: string;
  readonly reason: string;
  /** The only personas whose violations it explains, when it is tied to a kind of reader; any persona otherwise. */
  readonly personas?: readonly string[];
  /**
   * Personas whose run is the exact scenario that shows it. When some of them ran, the gate requires the entry to be
   * reproduced; a partial run without them is not blamed. Defaults to `personas`; with neither, the entry is always judged.
   */
  readonly reproducedBy?: readonly string[];
  readonly matches: (violation: Violation) => boolean;
}

export const KNOWN_FAILURES: readonly KnownFailure[] = [];

/** Whether an entry explains a violation: the same invariant, a persona the entry names (any, if it names none), and its reason. */
export const explains = (entry: KnownFailure, violation: Violation) =>
  entry.invariant === violation.invariant &&
  (entry.personas === undefined || entry.personas.includes(violation.persona)) &&
  entry.matches(violation);

/** The entry that explains a violation, if any. */
export const explainedBy = (violation: Violation) => KNOWN_FAILURES.find((entry) => explains(entry, violation));
