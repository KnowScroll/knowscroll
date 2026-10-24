import type { LogEvent } from '../../../infrastructure/observability/index.js';

/** Reports removed in one transaction. Small, so the purge never holds a long lock. */
export const PURGE_BATCH_SIZE = 500;
/** Batches in one run: 10,000 reports. A larger backlog finishes on the next day's run. */
export const PURGE_BATCHES_PER_RUN = 20;

/** Deletes up to `limit` reports whose `retain_until` has passed, skipping rows another transaction holds. */
export type PurgeDueReports = (limit: number) => Promise<number>;

export interface PurgeReportsPorts {
  readonly purgeDue: PurgeDueReports;
  readonly logEvent: LogEvent;
}

/** What one run removed. */
export type PurgeReports = () => Promise<{ readonly removed: number }>;

/**
 * `feedback.purge-reports` (daily, worker): removes the reports about deleted accounts whose 90 days are
 * over (D-055). Reads nothing but the due rows, touches no personal scope and logs only a count.
 */
export function makePurgeReports(ports: PurgeReportsPorts): PurgeReports {
  return async () => {
    let removed = 0;
    for (let batch = 0; batch < PURGE_BATCHES_PER_RUN; batch += 1) {
      const count = await ports.purgeDue(PURGE_BATCH_SIZE);
      removed += count;
      if (count < PURGE_BATCH_SIZE) break;
    }
    if (removed > 0) ports.logEvent('feedback.reports_purged', { count: removed });
    return { removed };
  };
}
