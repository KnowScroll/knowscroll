import { describe, expect, it } from 'vitest';
import { releaseQueues } from '../../../job-queues.js';
import {
  CHECK_LIBRARY_SUPPORT_CLAIM_SECONDS,
  CheckLibrarySupportJobSchema,
  checkLibrarySupportJob,
  checkLibrarySupportQueue,
  checkLibrarySupportSingletonKey,
  sweepLibrarySupportQueue,
} from './library-support-events.js';
import { LIBRARY_SUPPORT_CHECK_VERSION } from './library-support.js';

const ASSET = '8a7d48fe-0397-4e00-91a8-b4700630880f';

describe('the queues of the library support check (D-415)', () => {
  it('carries IDs only: a revision and the checker version the sender knew, nothing else', () => {
    const job = checkLibrarySupportJob(ASSET, 3);
    expect(job).toEqual({ v: 1, assetId: ASSET, revision: 3, checkerVersion: LIBRARY_SUPPORT_CHECK_VERSION });
    expect(CheckLibrarySupportJobSchema.safeParse(job).success).toBe(true);
    for (const bad of [
      { ...job, sentence: 'A sentence of a CI fixture.' },
      { ...job, assetId: 'not-a-uuid' },
      { ...job, revision: 0 },
      { ...job, v: 2 },
    ])
      expect(CheckLibrarySupportJobSchema.safeParse(bad).success).toBe(false);
  });

  it('holds one job for a revision and checker version while it is queued or running', () => {
    expect(checkLibrarySupportQueue.exclusive).toBe(true);
    expect(checkLibrarySupportSingletonKey(checkLibrarySupportJob(ASSET, 3))).toBe(
      `${ASSET}:3:${LIBRARY_SUPPORT_CHECK_VERSION}`,
    );
    expect(checkLibrarySupportSingletonKey(checkLibrarySupportJob(ASSET, 4))).not.toBe(
      checkLibrarySupportSingletonKey(checkLibrarySupportJob(ASSET, 3)),
    );
    expect(
      checkLibrarySupportSingletonKey({
        ...checkLibrarySupportJob(ASSET, 3),
        checkerVersion: 'library-support-check.v2',
      }),
    ).not.toBe(checkLibrarySupportSingletonKey(checkLibrarySupportJob(ASSET, 3)));
  });

  it('holds its claim for the worst case of a check: every batch and the harness’s repair, each to the largest request timeout and the waits around it', () => {
    // 11 requests x (300 s + 20 s) + 180 s, as the reasoning README counts them.
    expect(CHECK_LIBRARY_SUPPORT_CLAIM_SECONDS).toBe(3_700);
    expect(checkLibrarySupportQueue.policy.expireInSeconds).toBe(3_700);
    expect(checkLibrarySupportQueue.policy.expireInSeconds).toBeGreaterThan(2 * (10 + 300 + 10) + 30);
  });

  it('is declared in the release, with a sweep every ten minutes that carries its version only', () => {
    expect(releaseQueues).toContain(checkLibrarySupportQueue);
    const declared = releaseQueues.find((queue) => queue.name === sweepLibrarySupportQueue.name);
    expect(declared?.schedule).toEqual({ cron: '*/10 * * * *', payload: { v: 1 } });
    expect(sweepLibrarySupportQueue.payload.safeParse({ v: 1 }).success).toBe(true);
    // It names no revision: which are due is read from the rows.
    expect(sweepLibrarySupportQueue.payload.safeParse({ v: 1, assetId: ASSET }).success).toBe(false);
    expect(checkLibrarySupportQueue.name).toBe('content.check-library-support');
  });
});
