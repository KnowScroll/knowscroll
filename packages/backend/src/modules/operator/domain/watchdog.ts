/**
 * The watchdog's rules (D-411): code-only health checks over `ops.watchdog`, run hourly by the
 * worker. A rule fires an alert when its count passes a threshold; an alert names a code, a count
 * and the window it counted over, and never a person, a record or a text. Nothing is repaired.
 *
 * Every threshold of every rule is one number in one object (`WATCHDOG_THRESHOLDS`), so a change is one reviewed
 * line. Windows and ages are in seconds.
 */
export interface WatchdogThresholds {
  readonly deadLetters: { readonly windowSeconds: number; readonly alertAtCount: number };
  readonly failedJobsRepeating: { readonly windowSeconds: number; readonly alertAtCount: number };
  readonly runsHeld: { readonly heldSeconds: number; readonly alertAtCount: number };
  readonly geographyUnavailable: {
    readonly runs: number;
    readonly lookbackSeconds: number;
    readonly alertAtCount: number;
  };
  readonly composerRepeats: { readonly windowSeconds: number; readonly alertAtCount: number };
  readonly unknownAttempts: { readonly olderThanSeconds: number; readonly alertAtCount: number };
}

/** The thresholds the worker runs with. */
export const WATCHDOG_THRESHOLDS: WatchdogThresholds = {
  /** Jobs that exhausted their retries and went to a dead-letter queue within the window, per queue. */
  deadLetters: { windowSeconds: 3 * 3600, alertAtCount: 1 },
  /** Failed jobs of one queue with the same failure code within the window. */
  failedJobsRepeating: { windowSeconds: 6 * 3600, alertAtCount: 5 },
  /**
   * Personal runs (Planner, Geography) still `queued` or `prepared` whose row has not moved for this long. A
   * claim lasts 1150 seconds and a paced wake waits at most five minutes, so an hour is well past both.
   */
  runsHeld: { heldSeconds: 3600, alertAtCount: 1 },
  /**
   * Universes whose latest settled Geography runs all ended on the same unavailable reason, while they
   * have coverage references. `runs` is the streak; `lookbackSeconds` ignores a universe that has not run since.
   */
  geographyUnavailable: { runs: 3, lookbackSeconds: 7 * 86400, alertAtCount: 1 },
  /**
   * Composer decisions within the window that offered an explanation the person has met while the decision records an
   * eligible unseen candidate. Only `composer-policy.v2` decisions are read; with none, the rule never fires.
   */
  composerRepeats: { windowSeconds: 24 * 3600, alertAtCount: 1 },
  /** Model attempts whose outcome is still `unknown` after this long (an operator reconciles or writes them off). */
  unknownAttempts: { olderThanSeconds: 6 * 3600, alertAtCount: 1 },
};

/** The kinds of observation `ops.watchdog` holds, one row per item. */
export type WatchdogRule =
  'dead_letter' | 'job_failed' | 'run_held' | 'geography_unavailable_repeat' | 'composer_repeat' | 'attempt_unknown';

/** What one rule's read asks of the store: observations newer or older than a time, grouped by subject and detail. */
export interface WatchdogQuery {
  readonly rule: WatchdogRule;
  readonly newerThan?: Date;
  readonly olderThan?: Date;
  /** Count only observations whose `magnitude` is at least this: a streak length for the geography rule. */
  readonly minMagnitude?: number;
}

/** Observations of one rule, grouped. `subject` and `detail` are codes; `count` is the observations in the group. */
export interface WatchdogGroup {
  readonly subject: string;
  readonly detail: string | null;
  readonly count: number;
}

export type WatchdogAlertCode =
  | 'dead_lettered_jobs'
  | 'failed_jobs_repeating'
  | 'personal_runs_held'
  | 'geography_unavailable_repeating'
  | 'composer_repeat_offered'
  | 'unknown_attempts_old';

/**
 * One alert: a code, how many, and the window or age it counted over. The optional fields name a queue, a
 * module or an outcome code. Never an ID of a person or a record.
 */
export interface WatchdogAlert {
  readonly code: WatchdogAlertCode;
  readonly count: number;
  readonly windowSeconds: number;
  readonly queue?: string;
  readonly context?: string;
  readonly outcome?: string;
}

const ago = (now: Date, seconds: number) => new Date(now.getTime() - seconds * 1000);

/** The reads the six rules need now, with their cut-off times. */
export function watchdogQueries(
  now: Date,
  thresholds: WatchdogThresholds = WATCHDOG_THRESHOLDS,
): readonly WatchdogQuery[] {
  return [
    { rule: 'dead_letter', newerThan: ago(now, thresholds.deadLetters.windowSeconds) },
    { rule: 'job_failed', newerThan: ago(now, thresholds.failedJobsRepeating.windowSeconds) },
    { rule: 'run_held', olderThan: ago(now, thresholds.runsHeld.heldSeconds) },
    {
      rule: 'geography_unavailable_repeat',
      newerThan: ago(now, thresholds.geographyUnavailable.lookbackSeconds),
      minMagnitude: thresholds.geographyUnavailable.runs,
    },
    { rule: 'composer_repeat', newerThan: ago(now, thresholds.composerRepeats.windowSeconds) },
    { rule: 'attempt_unknown', olderThan: ago(now, thresholds.unknownAttempts.olderThanSeconds) },
  ];
}

/**
 * The alerts one rule's groups give rise to. Pure: it fires on its condition and never otherwise.
 * Each group of a per-queue rule is its own alert, so two queues with dead letters are two alerts.
 */
export function alertsFrom(
  rule: WatchdogRule,
  groups: readonly WatchdogGroup[],
  thresholds: WatchdogThresholds = WATCHDOG_THRESHOLDS,
): readonly WatchdogAlert[] {
  switch (rule) {
    case 'dead_letter':
      return groups
        .filter((group) => group.count >= thresholds.deadLetters.alertAtCount)
        .map((group) => ({
          code: 'dead_lettered_jobs',
          count: group.count,
          windowSeconds: thresholds.deadLetters.windowSeconds,
          queue: group.subject,
        }));
    case 'job_failed':
      return groups
        .filter((group) => group.count >= thresholds.failedJobsRepeating.alertAtCount)
        .map((group) => ({
          code: 'failed_jobs_repeating',
          count: group.count,
          windowSeconds: thresholds.failedJobsRepeating.windowSeconds,
          queue: group.subject,
          ...(group.detail === null ? {} : { outcome: group.detail }),
        }));
    case 'run_held':
      return groups
        .filter((group) => group.count >= thresholds.runsHeld.alertAtCount)
        .map((group) => ({
          code: 'personal_runs_held',
          count: group.count,
          windowSeconds: thresholds.runsHeld.heldSeconds,
          context: group.subject,
          ...(group.detail === null ? {} : { outcome: group.detail }),
        }));
    case 'geography_unavailable_repeat':
      return groups
        .filter((group) => group.count >= thresholds.geographyUnavailable.alertAtCount)
        .map((group) => ({
          code: 'geography_unavailable_repeating',
          count: group.count,
          windowSeconds: thresholds.geographyUnavailable.lookbackSeconds,
          outcome: group.subject,
        }));
    case 'composer_repeat':
      return groups
        .filter((group) => group.count >= thresholds.composerRepeats.alertAtCount)
        .map((group) => ({
          code: 'composer_repeat_offered',
          count: group.count,
          windowSeconds: thresholds.composerRepeats.windowSeconds,
          outcome: group.subject,
        }));
    case 'attempt_unknown':
      return groups
        .filter((group) => group.count >= thresholds.unknownAttempts.alertAtCount)
        .map((group) => ({
          code: 'unknown_attempts_old',
          count: group.count,
          windowSeconds: thresholds.unknownAttempts.olderThanSeconds,
          context: group.subject,
        }));
  }
}
