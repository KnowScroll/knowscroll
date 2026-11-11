import type { InvariantId, RepeatCause, Violation } from './invariants.js';

/**
 * Behaviour of the current code that an invariant forbids and that a later slice of #674 fixes. Each entry is a
 * named, narrow failure with the reason it fails, so CI stays green now and goes red the day a fix lands.
 *
 * The lab holds two promises about every entry:
 * - every violation of the invariant must match an entry or the run fails ("unexpected violation"): a new defect, or a
 *   known one failing for another reason than the one stated, cannot hide behind an entry;
 * - every entry must still be reproduced by the run: when a slice fixes the behaviour, its entry fails with "now fixed",
 *   and the slice deletes the entry in the same PR. That is how the check flips from expected failure to a gate.
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
  /** Personas that must reproduce it, when it is tied to a kind of reader; any persona otherwise. */
  readonly personas?: readonly string[];
  readonly matches: (violation: Violation) => boolean;
}

/** Causes of an I1 repeat that the current policy explains: all are the absence of a hard exclusion (slice 1.2). */
const EXPLAINED_REPEAT_CAUSES: readonly RepeatCause[] = [
  'soft_penalty',
  'exploration_draw',
  'format_sticky',
  'retrieval',
];

export const KNOWN_FAILURES: readonly KnownFailure[] = [
  {
    id: 'I1/already-met-is-a-soft-penalty',
    invariant: 'I1',
    slice: '1.2',
    reason:
      'Nothing hard-excludes an explanation the person has met. It costs a novelty term, so a met unit still wins while an unseen one exists: a same-topic repeat beats an unseen other-topic unit, exploration draws from the met ones too, and a sticky format keeps the person among met units of that format.',
    matches: (violation) =>
      violation.code === 'met_offered_while_unseen_left' &&
      EXPLAINED_REPEAT_CAUSES.includes(violation.detail['cause'] as RepeatCause),
  },
  {
    id: 'I2/reel-only-evidence-forms-no-system',
    invariant: 'I2',
    slice: '5.1',
    personas: ['link-reader-reels'],
    reason:
      'A Reel has no coverage mapping or certificate, and the trusted read serves only Scrolls (supportedFormats: [scroll]), so qualified Reels count for dust and for no place. Reel and Scroll have equal status.',
    matches: (violation) => violation.code === 'system_not_formed' && violation.detail['onlyWithReels'] === true,
  },
];

/** The entry that explains a violation, if any. */
export const explainedBy = (violation: Violation) =>
  KNOWN_FAILURES.find((entry) => entry.invariant === violation.invariant && entry.matches(violation));
