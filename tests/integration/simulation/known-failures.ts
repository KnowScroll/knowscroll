import type { InvariantId, RepeatCause, Violation } from './invariants.js';

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

/**
 * Causes of an I1 repeat that the soft-penalty entry explains: the met unit was eligible, so only a soft term stood
 * between it and the offer (slice 1.2). A repeat whose unseen alternatives never reached the Composer (`retrieval`) is a
 * retrieval defect, not this one, and is deliberately absent: it stays an unexpected violation, with the number of
 * candidates the decision evaluated in its message, until a run reproduces it for a stated reason and it gets an entry.
 * None does today: even the large library (past the 100-candidate lane) shows only the soft penalty on moves the system chose.
 */
const EXPLAINED_REPEAT_CAUSES: readonly RepeatCause[] = ['soft_penalty', 'exploration_draw', 'format_sticky'];

/** What the handlers of the violation's queue threw, as the lab saw it. */
const messagesOf = (violation: Violation): readonly string[] => {
  const messages = violation.detail['messages'];
  return Array.isArray(messages) ? messages.filter((message): message is string => typeof message === 'string') : [];
};

/** The Planner's unique index on an open planner request per work group, which a second request for the same brief violates. */
const PLANNED_DEMAND_CONSTRAINT = 'supply_requests_planner_open_work';

/** The consequence of a failed delivery: pg-boss redelivers into a run whose claim is still held. */
const CLAIM_WAKE_EARLY = 'PLANNER_CLAIM_WAKE_EARLY';

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
    id: 'I3/planned-demand-duplicates-an-open-request',
    invariant: 'I3',
    slice: '1.3',
    reproducedBy: ['link-reader-exoplanets'],
    reason:
      'Planner demand for a topic whose unread content is gone asks Supply to commission again, although the person already has an open planned row for that brief (the ready one that reused content, and a deferred one that joined production). The lookup returns the ready row, so the second request joins the same work group and violates the unique index on one open planner row per work group. The Planner run throws, retries, dead-letters and stays prepared. Only a topic with a recipe Create may still choose (space.exoplanets) reaches it today.',
    matches: (violation) => {
      const messages = messagesOf(violation);
      return (
        violation.invariant === 'I3' &&
        ['job_handler_failed', 'run_held_queued', 'job_failed', 'job_dead_lettered', 'job_not_completed'].includes(
          violation.code,
        ) &&
        (violation.detail['queue'] === 'planner.run' ||
          violation.detail['queue'] === 'planner.run.dead' ||
          violation.detail['kind'] === 'planner') &&
        // The worker's own error, not just the queue: the unique index, and nothing but its consequence.
        messages.some((message) => message.includes(PLANNED_DEMAND_CONSTRAINT)) &&
        messages.every((message) => message.includes(PLANNED_DEMAND_CONSTRAINT) || message.includes(CLAIM_WAKE_EARLY))
      );
    },
  },
  {
    id: 'I2/reel-only-evidence-forms-no-system',
    invariant: 'I2',
    slice: '5.1',
    // Any reader who qualifies two Reels of a system meets it; `link-reader-reels` is the exact scenario.
    reproducedBy: ['link-reader-reels'],
    reason:
      'A Reel has no coverage mapping or certificate, and the trusted read serves only Scrolls (supportedFormats: [scroll]), so qualified Reels count for dust and for no place. Reel and Scroll have equal status.',
    matches: (violation) => violation.code === 'system_not_formed' && violation.detail['onlyWithReels'] === true,
  },
];

/** Whether an entry explains a violation: the same invariant, a persona the entry names (any, if it names none), and its reason. */
export const explains = (entry: KnownFailure, violation: Violation) =>
  entry.invariant === violation.invariant &&
  (entry.personas === undefined || entry.personas.includes(violation.persona)) &&
  entry.matches(violation);

/** The entry that explains a violation, if any. */
export const explainedBy = (violation: Violation) => KNOWN_FAILURES.find((entry) => explains(entry, violation));
