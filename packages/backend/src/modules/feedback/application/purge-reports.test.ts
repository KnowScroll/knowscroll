import { describe, expect, it, vi } from 'vitest';
import { makePurgeReports, PURGE_BATCH_SIZE, PURGE_BATCHES_PER_RUN } from './purge-reports.js';

describe('the report purge', () => {
  it('removes what is due, logs a count and stops at the first short batch', async () => {
    const purgeDue = vi.fn().mockResolvedValueOnce(PURGE_BATCH_SIZE).mockResolvedValueOnce(7);
    const logEvent = vi.fn();
    expect(await makePurgeReports({ purgeDue, logEvent })()).toEqual({ removed: PURGE_BATCH_SIZE + 7 });
    expect(purgeDue).toHaveBeenCalledTimes(2);
    expect(purgeDue).toHaveBeenCalledWith(PURGE_BATCH_SIZE);
    expect(logEvent).toHaveBeenCalledWith('feedback.reports_purged', { count: PURGE_BATCH_SIZE + 7 });
  });

  it('logs nothing when nothing is due', async () => {
    const logEvent = vi.fn();
    expect(await makePurgeReports({ purgeDue: () => Promise.resolve(0), logEvent })()).toEqual({ removed: 0 });
    expect(logEvent).not.toHaveBeenCalled();
  });

  it('is bounded per run: a backlog continues on the next run', async () => {
    const purgeDue = vi.fn().mockResolvedValue(PURGE_BATCH_SIZE);
    const result = await makePurgeReports({ purgeDue, logEvent: vi.fn() })();
    expect(purgeDue).toHaveBeenCalledTimes(PURGE_BATCHES_PER_RUN);
    expect(result.removed).toBe(PURGE_BATCH_SIZE * PURGE_BATCHES_PER_RUN);
  });
});
