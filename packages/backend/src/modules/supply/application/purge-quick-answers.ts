import type { LogEvent } from '../../../infrastructure/observability/index.js';

/** Answers removed in one transaction. Small, so the purge never holds a long lock. */
export const PURGE_BATCH_SIZE = 500;
/** Batches in one run: 5,000 answers. A larger backlog finishes on the next run, ten minutes later. */
export const PURGE_BATCHES_PER_RUN = 10;

/** Deletes up to `limit` Quick answers whose day is over, skipping rows another transaction holds. */
export type PurgeDueQuickAnswers = (limit: number) => Promise<number>;

export interface PurgeQuickAnswersPorts {
  readonly purgeDue: PurgeDueQuickAnswers;
  readonly logEvent: LogEvent;
}

/** What one run removed. */
export type PurgeQuickAnswers = () => Promise<{ readonly removed: number }>;

/**
 * `supply.purge-quick-answers` (every ten minutes, worker): removes the Quick answers whose day is over, so no question
 * or answer is kept longer than the day it was promised (D-253). Reads nothing but the due rows, touches no personal scope
 * and logs only a count.
 */
export function makePurgeQuickAnswers(ports: PurgeQuickAnswersPorts): PurgeQuickAnswers {
  return async () => {
    let removed = 0;
    for (let batch = 0; batch < PURGE_BATCHES_PER_RUN; batch += 1) {
      const count = await ports.purgeDue(PURGE_BATCH_SIZE);
      removed += count;
      if (count < PURGE_BATCH_SIZE) break;
    }
    if (removed > 0) ports.logEvent('supply.quick_answers_purged', { count: removed });
    return { removed };
  };
}
