import type { LogEvent } from '../../../infrastructure/observability/index.js';

/** Answers removed in one transaction. Small, so the purge never holds a long lock. */
export const PURGE_BATCH_SIZE = 500;
/** Batches in one run: 5,000 answers. A larger backlog finishes on the next run, ten minutes later. */
export const PURGE_BATCHES_PER_RUN = 10;

/** Deletes up to `limit` Quick answers whose day is over, skipping rows another transaction holds. */
export type PurgeDueQuickAnswers = (limit: number) => Promise<number>;

/**
 * Settles up to `limit` Quick answers still `waiting` after the wait limit as unavailable and clears their words, skipping rows
 * another transaction holds: a job that never ran (a stopped worker, a lost job) must not leave the person's words up to a day.
 */
export type GiveUpStaleQuickAnswers = (limit: number) => Promise<number>;

export interface PurgeQuickAnswersPorts {
  readonly purgeDue: PurgeDueQuickAnswers;
  readonly giveUpStale: GiveUpStaleQuickAnswers;
  readonly logEvent: LogEvent;
}

/** What one run removed. */
export type PurgeQuickAnswers = () => Promise<{ readonly removed: number; readonly givenUp: number }>;

/**
 * `supply.purge-quick-answers` (every ten minutes, worker): first closes the answers that are still waiting after the wait limit
 * and clears their words, then removes the answers whose day is over, so no question or answer is kept longer than it was
 * promised (D-253, D-255). Reads nothing but the due rows, touches no personal scope and logs only counts.
 */
export function makePurgeQuickAnswers(ports: PurgeQuickAnswersPorts): PurgeQuickAnswers {
  return async () => {
    let givenUp = 0;
    for (let batch = 0; batch < PURGE_BATCHES_PER_RUN; batch += 1) {
      const count = await ports.giveUpStale(PURGE_BATCH_SIZE);
      givenUp += count;
      if (count < PURGE_BATCH_SIZE) break;
    }
    if (givenUp > 0) ports.logEvent('supply.quick_answers_given_up', { count: givenUp });
    let removed = 0;
    for (let batch = 0; batch < PURGE_BATCHES_PER_RUN; batch += 1) {
      const count = await ports.purgeDue(PURGE_BATCH_SIZE);
      removed += count;
      if (count < PURGE_BATCH_SIZE) break;
    }
    if (removed > 0) ports.logEvent('supply.quick_answers_purged', { count: removed });
    return { removed, givenUp };
  };
}
