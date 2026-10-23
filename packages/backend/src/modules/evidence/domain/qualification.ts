import type { ScrollQualificationPolicy } from './policy.js';
import type { ReadingSummary } from './reading-summary.js';

/**
 * The classification of one encounter's reading (blueprint §8). `unknown` is not a failure: it says
 * the measurement is missing or incomplete, so the reading counts neither as consumption nor as a
 * negative example.
 */
export type Qualification = 'qualified' | 'not_qualified' | 'unknown';

/** Why a reading was classified as it was: stable codes, never text. */
export type QualificationReason =
  | 'instrumentation_missing'
  | 'instrumentation_outdated'
  | 'sequence_gaps'
  | 'no_visibility'
  | 'coverage_below_minimum'
  | 'q_below_minimum';

export interface QualificationResult {
  readonly qualification: Qualification;
  /** `coverageWeight * coverage + dwellWeight * min(1, activeDwell / estimatedReading)`, in [0, 1]. */
  readonly q: number;
  readonly coverage: number;
  readonly dwellRatio: number;
  readonly activeDwellMs: number;
  readonly estimatedReadingMs: number;
  readonly reasons: readonly QualificationReason[];
}

/** Rounds to four decimals, the precision results are stored at (stable under the same input). */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Qualifies a Scroll reading (blueprint §8):
 *
 *   q = 0.5 · weighted coverage + 0.5 · min(1, active dwell / estimated reading time)
 *
 * **qualified** needs valid lineage (the exposure's lineage was checked at intake), visibility (at
 * least one block seen), `q ≥ minQ` and coverage `≥ minCoverage`. A qualified result stands even
 * with missing events, because lost events can only have added to what was seen.
 * **unknown** when the thresholds are not met but the instrumentation is missing or insufficient
 * (no coverage report, no dwell report, a recorder build below the policy's minimum) or events were
 * lost (sequence gaps): the missing events might have made it qualified, so it is neither
 * qualified nor a negative.
 * **not_qualified** when the instrumentation is sufficient and complete, and the reading is short.
 * Pure: parameters come from the versioned policy, never from literals here.
 */
export function qualifyScrollReading(summary: ReadingSummary, policy: ScrollQualificationPolicy): QualificationResult {
  const dwellRatio =
    summary.estimatedReadingMs <= 0 ? 0 : Math.min(1, summary.activeDwellMs / summary.estimatedReadingMs);
  const q = Math.min(1, policy.coverageWeight * summary.coverage + policy.dwellWeight * dwellRatio);
  const visible = summary.seenBlocks.length > 0;
  const passes = visible && q >= policy.minQ && summary.coverage >= policy.minCoverage;

  const reasons: QualificationReason[] = [];
  if (summary.coverageEvents === 0 || summary.dwellEvents === 0) reasons.push('instrumentation_missing');
  else if (summary.instrumentationVersion < policy.minInstrumentationVersion) reasons.push('instrumentation_outdated');
  if (summary.sequenceGaps > 0) reasons.push('sequence_gaps');
  const incomplete = reasons.length > 0;

  if (!passes) {
    if (!visible) reasons.push('no_visibility');
    else if (summary.coverage < policy.minCoverage) reasons.push('coverage_below_minimum');
    else if (q < policy.minQ) reasons.push('q_below_minimum');
  }

  let qualification: Qualification;
  if (passes) qualification = 'qualified';
  else if (incomplete) qualification = 'unknown';
  else qualification = 'not_qualified';

  return {
    qualification,
    q: round4(q),
    coverage: round4(summary.coverage),
    dwellRatio: round4(dwellRatio),
    activeDwellMs: summary.activeDwellMs,
    estimatedReadingMs: summary.estimatedReadingMs,
    reasons: passes ? [] : reasons,
  };
}
