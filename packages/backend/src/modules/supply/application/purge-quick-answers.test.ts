import { describe, expect, it, vi } from 'vitest';
import { PURGE_BATCHES_PER_RUN, PURGE_BATCH_SIZE, makePurgeQuickAnswers } from './purge-quick-answers.js';

describe('the Quick answer purge (D-255)', () => {
  it('closes the answers nobody waits for first, then removes the ones whose day is over, and logs only counts', async () => {
    const order: string[] = [];
    const logEvent = vi.fn();
    const purge = makePurgeQuickAnswers({
      giveUpStale: (limit) => {
        order.push(`give-up ${String(limit)}`);
        return Promise.resolve(3);
      },
      purgeDue: (limit) => {
        order.push(`purge ${String(limit)}`);
        return Promise.resolve(2);
      },
      logEvent,
    });
    expect(await purge()).toEqual({ removed: 2, givenUp: 3 });
    expect(order).toEqual([`give-up ${String(PURGE_BATCH_SIZE)}`, `purge ${String(PURGE_BATCH_SIZE)}`]);
    expect(logEvent).toHaveBeenCalledWith('supply.quick_answers_given_up', { count: 3 });
    expect(logEvent).toHaveBeenCalledWith('supply.quick_answers_purged', { count: 2 });
  });

  it('works in batches, stops at a short one and at the run’s limit, and logs nothing when there was nothing to do', async () => {
    const full = vi.fn(() => Promise.resolve(PURGE_BATCH_SIZE));
    const logEvent = vi.fn();
    const endless = makePurgeQuickAnswers({ giveUpStale: full, purgeDue: full, logEvent });
    expect(await endless()).toEqual({
      removed: PURGE_BATCH_SIZE * PURGE_BATCHES_PER_RUN,
      givenUp: PURGE_BATCH_SIZE * PURGE_BATCHES_PER_RUN,
    });
    expect(full).toHaveBeenCalledTimes(2 * PURGE_BATCHES_PER_RUN);
    const none = vi.fn(() => Promise.resolve(0));
    logEvent.mockClear();
    expect(await makePurgeQuickAnswers({ giveUpStale: none, purgeDue: none, logEvent })()).toEqual({
      removed: 0,
      givenUp: 0,
    });
    expect(logEvent).not.toHaveBeenCalled();
  });
});
