import { releaseQueues } from '@knowscroll/backend/job-queues';
import { describe, expect, it } from 'vitest';
import { DRAINED_QUEUES, NOT_DRAINED } from '../queues.js';

/**
 * The lab drains the worker queues on the path a reader's activity takes, and says why it leaves the others. This
 * keeps that honest: a queue added to the release must be classified here, so a new consumer on the activity path cannot
 * go undrained by omission. It needs no database.
 */
describe('simulation lab wiring', () => {
  const declared = releaseQueues.map((queue) => queue.name).sort();
  const drained = DRAINED_QUEUES.map((queue) => queue.name);

  it('classifies every queue of the release as drained or not drained, with a reason', () => {
    const classified = [...drained, ...Object.keys(NOT_DRAINED)].sort();
    expect(
      declared.filter((name) => !classified.includes(name)),
      'queues the release declares that the lab neither drains nor explains (add them to DRAINED_QUEUES with a consumer in world.ts, or to NOT_DRAINED with a reason)',
    ).toEqual([]);
    expect(
      classified.filter((name) => !declared.includes(name)),
      'queues the lab names that the release no longer declares',
    ).toEqual([]);
  });

  it('names no queue twice and gives every undrained queue a reason', () => {
    expect(new Set(drained).size).toBe(drained.length);
    expect(drained.filter((name) => name in NOT_DRAINED)).toEqual([]);
    for (const [name, reason] of Object.entries(NOT_DRAINED)) expect(reason.length, name).toBeGreaterThan(10);
  });
});
